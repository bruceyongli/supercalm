import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, lstat, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'aios-worktree-archive-test-')));
process.env.AIOS_DATA = join(fixture, 'data');
process.env.AIOS_WORKTREE_ROOT = join(fixture, 'worktrees');
process.env.AIOS_NO_LISTEN = '1';
const bin = join(fixture, 'bin'); await mkdir(bin);
await writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
await writeFile(join(bin, 'sync'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
process.env.ARCHIVE_TMUX_LOG = join(fixture, 'tmux-calls');
await writeFile(process.env.ARCHIVE_TMUX_LOG, '');
await writeFile(join(bin, 'tmux'), `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.ARCHIVE_TMUX_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='has-session')process.exit(1);
if(args[0]==='display-message')process.stdout.write('zsh');
`, { mode: 0o700 });
process.env.AIOS_TMUX = join(bin, 'tmux');
process.env.PATH = bin + ':' + process.env.PATH;
const repo = join(fixture, 'project'), source = join(process.env.AIOS_WORKTREE_ROOT, 'project', 's_cold');
await mkdir(repo); await mkdir(join(process.env.AIOS_WORKTREE_ROOT, 'project'), { recursive: true });
const git = (...args) => exec('git', ['-C', repo, ...args], { env: process.env });
await git('init', '-b', 'main');
await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'Fixture');
await writeFile(join(repo, 'tracked.txt'), 'committed\n'); await git('add', '.'); await git('commit', '-m', 'fixture');
await git('worktree', 'add', '-b', 'session-cold', source);
await writeFile(join(source, 'tracked.txt'), 'staged change\n');
await exec('git', ['-C', source, 'add', 'tracked.txt']);
await writeFile(join(source, 'tracked.txt'), 'unstaged change\n');
await writeFile(join(source, 'new.md'), '# Untracked work\n');
await symlink('new.md', join(source, 'alias.md'));
const store = await import('../src/store.js');
store.createProject({ id: 'p_cold', name: 'Cold project', path: repo });
store.createSession({ id: 's_cold', project_id: 'p_cold', tool: 'codex', tmux: 'fixture-cold', status: 'exited' });
store.updateSession('s_cold', { status: 'exited', desired_status: 'exited', runtime_status: 'exited', worktree_path: source, branch: 'session-cold', codex_uuid: '00000000-0000-4000-8000-000000000001' });
const { archiveRecords, validateArchiveRecord, archivedFile, saveArchiveRecord } = await import('../src/artifact_archive.js');
const { restoreArchivedWorktree } = await import('../src/archive_transfer.js');
const { withSessionArchiveLock } = await import('../src/archive_lock.js');
const { withSessionCleanup } = await import('../src/session_cleanup_lock.js');
const { storedFileInfo, storedFileRead } = await import('../src/stored_file.js');
const remote = join(fixture, 'remote', 'archives', 's_cold');
const cli = (op, ...args) => exec(process.execPath, ['bin/archive-artifacts.mjs', op, 's_cold', '@worktree', ...args],
  { env: process.env, timeout: 60000, maxBuffer: 1024 * 1024 });
const { resume } = await import('../src/sessions.js');
const paneCalls = async () => (await readFile(process.env.ARCHIVE_TMUX_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(args => args[0] === 'new-session' && args.includes('fixture-cold'));
try {
  await withSessionArchiveLock('s_cold', async () => {
    await assert.rejects(() => withSessionArchiveLock('s_cold', () => {}), /being migrated/);
    await assert.rejects(() => cli('copy', 'fixture', remote), /being migrated/);
    await assert.rejects(() => withSessionCleanup('s_cold', () => {}), /being migrated/);
  });
  await withSessionArchiveLock('s_cold', () => {});
  // Real process death leaves an owner record but MUST release the kernel lease.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const {withSessionArchiveLock}=await import(${JSON.stringify(new URL('../src/archive_lock.js', import.meta.url).href)});
    await withSessionArchiveLock('s_crash',async()=>{process.stdout.write('LOCKED\\n');await new Promise(()=>setInterval(()=>{},1000));});
  `], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    const timer=setTimeout(()=>{holder.kill('SIGKILL');fail(Error('Lock fixture timeout'));},10000);
    holder.stdout.once('data',()=>{clearTimeout(timer);ok();});holder.once('error',fail);
  });
  await assert.rejects(() => withSessionArchiveLock('s_crash', () => {}), /being migrated/);
  const died = new Promise(ok => holder.once('close', ok)); holder.kill('SIGKILL'); await died;
  await withSessionArchiveLock('s_crash', () => {});
  store.updateSession('s_cold', { runtime_status: 'recovering' });
  await assert.rejects(() => cli('copy', 'fixture', remote), /fully stopped/);
  store.updateSession('s_cold', { runtime_status: 'exited' });
  await cli('copy', 'fixture', remote);
  let record = (await archiveRecords({ fresh: true })).find(r => r.sessionId === 's_cold');
  assert.equal(record.kind, 'worktree');
  assert.throws(() => validateArchiveRecord({ ...record, sourceRoot: repo }), /managed session worktree/);
  assert.throws(() => validateArchiveRecord({ ...record, sessionId: 's_other' }), /managed session worktree/);
  await cli('evict');
  record = (await archiveRecords({ fresh: true })).find(r => r.sessionId === 's_cold');
  await saveArchiveRecord({ ...record, evictionPath: source + '-recovery', state: 'verified' });
  await assert.rejects(() => resume('s_cold'), /interrupted/);
  await assert.rejects(() => lstat(source), { code: 'ENOENT' });
  await saveArchiveRecord(record);
  await assert.rejects(() => lstat(source), { code: 'ENOENT' });
  assert.match((await git('worktree', 'list', '--porcelain')).stdout, /locked AIOS archive s_cold/);
  await git('worktree', 'prune', '--expire', 'now');
  assert.match((await git('worktree', 'list', '--porcelain')).stdout, /session-cold/);
  assert.equal(await archivedFile('s_other', join(source, 'new.md')), null);
  const file = await storedFileInfo('s_cold', join(source, 'alias.md'));
  assert.match((await storedFileRead(join(source, 'alias.md'), file, 1000)).toString(), /Untracked work/);
  await rename(remote, remote + '-offline');
  const beforePanes = (await paneCalls()).length;
  await assert.rejects(() => resume('s_cold'), /Transfer failed/);
  assert.equal((await paneCalls()).length, beforePanes, 'real resume handler never launches a replacement on archive failure');
  await assert.rejects(() => lstat(source), { code: 'ENOENT' });
  assert.equal(store.getSession('s_cold').status, 'exited');
  await rename(remote + '-offline', remote);
  // A new local checkout must not be overwritten by the archived version.
  await mkdir(source); await writeFile(join(source, 'newer.txt'), 'keep me');
  await assert.rejects(() => withSessionArchiveLock('s_cold', () => restoreArchivedWorktree(store.getSession('s_cold'))), /never overwrites/);
  assert.equal(await readFile(join(source, 'newer.txt'), 'utf8'), 'keep me');
  await rm(source, { recursive: true });
  await resume('s_cold');
  assert.equal(store.getSession('s_cold').status, 'working', 'real resume handler restores before relaunch');
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'unstaged change\n');
  assert.equal((await exec('git', ['-C', source, 'show', ':tracked.txt'])).stdout, 'staged change\n');
  assert.equal(await readFile(join(source, 'new.md'), 'utf8'), '# Untracked work\n');
  assert.equal((await exec('git', ['-C', source, 'branch', '--show-current'])).stdout.trim(), 'session-cold');
  assert.doesNotMatch((await git('worktree', 'list', '--porcelain')).stdout, /locked AIOS archive/);
  assert.ok((await lstat(remote)).isDirectory(), 'remote original is retained after restoration');
  await restoreArchivedWorktree(store.getSession('s_cold')); // already restored is an idempotent no-op
  const sessionsSource = await readFile(new URL('../src/sessions.js', import.meta.url), 'utf8');
  const resumeSource = sessionsSource.slice(sessionsSource.indexOf('async function resumeNow('), sessionsSource.indexOf('export function resume('));
  assert.ok(resumeSource.indexOf('await restoreArchivedWorktree(s)') < resumeSource.indexOf('await ensureWorktree('), 'resume cannot recreate an archived dirty worktree');
  console.log('worktree_archive.test ok: stopped-only lease, Git prune protection, dirty/staged/untracked restore, same branch, preview, offline/collision fail-safe');
} finally {
  store.db.close();
  await rm(fixture, { recursive: true, force: true });
}
process.exit(0);
