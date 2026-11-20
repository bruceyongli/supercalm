// A continuation has a distinct workspace and native history. Its stable ID makes
// opening the same stopped session idempotent across browser retries and reboots.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, realpath, writeFile, lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, LOG_DIR } from './config.js';
import { initializeExecutionNative } from './execution_native.js';
import { expectedStoragePath, liveStorageConfig } from './live_storage.js';

const exec = promisify(execFile);
const base = join(DATA_DIR, 'local-continuations');
export function continuationId(sid) {
  if (!/^s_[A-Za-z0-9_-]+$/.test(sid) || isContinuation(sid)) throw Error('Invalid original session');
  return 's_local_' + sid.slice(2);
}
export const isContinuation = sid => /^s_local_[A-Za-z0-9_-]+$/.test(sid);
export const continuationRoot = sid => isContinuation(sid) ? join(base, sid) : null;
export const sessionArtifactRoot = sid => isContinuation(sid) ? join(base, sid, 'artifacts') : join(DATA_DIR, 'session-artifacts', sid);
export const sessionLogFile = sid => isContinuation(sid) ? join(base, sid, 'terminal.log') : join(LOG_DIR, sid + '.log');
export const continuationCodexSessions = sid => isContinuation(sid) ? join(base, sid, 'native/codex/sessions') : undefined;
export function continuationNativeEnv(sid, tool) {
  const root = continuationRoot(sid);
  if (!root) return {};
  if (tool === 'claude') return { CLAUDE_CONFIG_DIR: join(root, 'native/claude') };
  if (tool === 'codex') return { CODEX_HOME: join(root, 'native/codex') };
  return {};
}

export async function prepareContinuationStorage(id) {
  const root = continuationRoot(id);
  if (!root) throw Error('Invalid local continuation');
  const config = liveStorageConfig();
  if (expectedStoragePath(root, config) !== root) throw Error('The local continuation directory resolves to remote storage');
  // Verify one component at a time before creating any files beneath it.
  const data = await realpath(DATA_DIR), device = (await stat(data)).dev;
  for (const dir of [base, root, join(root, 'native'), join(root, 'native/codex'), join(root, 'native/claude'),
    join(root, 'artifacts'), join(root, 'scratch'), join(root, 'scratch/tmp')]) {
    await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    if (!(await lstat(dir)).isDirectory() || (await stat(dir)).dev !== device) throw Error('Continuation storage must be a local directory');
  }
  await initializeExecutionNative(root);
  return device;
}
export async function prepareContinuation(source, project, messages) {
  const id = continuationId(source.id), root = continuationRoot(id), cwd = join(root, 'workspace');
  const device = await prepareContinuationStorage(id);
  const existing = await lstat(cwd).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (existing && (!existing.isDirectory() || existing.dev !== device)) throw Error('Local continuation workspace was replaced');
  if (!existing) {
    const stage = await mkdtemp(join(root, 'prepare-'));
    try {
      let baseline = 'The workspace started empty. Your remote working files are still on the original volume.';
      // Only copy an exact saved branch from an available local primary repository.
      // A linked or remote checkout cannot supply the missing uncommitted changes.
      if (source.branch && project?.path) {
        try {
          if (expectedStoragePath(project.path) !== project.path) throw Error('Remote primary repository');
          const repo = await realpath(project.path);
          if ((await stat(repo)).dev !== device || !(await lstat(join(repo, '.git'))).isDirectory()) throw Error('No local repository');
          await exec('git', ['check-ref-format', 'refs/heads/' + source.branch], { timeout: 2000 });
          const ref = 'refs/heads/' + source.branch;
          const { stdout } = await exec('git', ['-C', repo, 'rev-parse', '--verify', ref + '^{commit}'], { timeout: 2000 });
          const commit = stdout.trim();
          await exec('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--single-branch', '--no-tags', '--depth=1', '--branch', source.branch, '--', repo, join(stage, 'tree')], { timeout: 15000 });
          const head = await exec('git', ['-C', join(stage, 'tree'), 'rev-parse', 'HEAD']);
          if (head.stdout.trim() !== commit) throw Error('Local branch changed during recovery');
          await exec('git', ['-C', join(stage, 'tree'), 'remote', 'remove', 'origin']);
          baseline = 'Local committed snapshot: ' + source.branch + ' at ' + commit + '. Uncommitted remote edits still need recovery.';
        } catch {
          await rm(join(stage, 'tree'), { force: true, recursive: true });
        }
      }
      const tree = join(stage, 'tree');
      await mkdir(tree, { recursive: true, mode: 0o700 });
      await exec('git', ['-C', tree, 'init', '-q'], { timeout: 5000 });
      const text = ['# Local session recovery', '', 'Original session: ' + source.id, 'Title: ' + (source.title || ''),
        'Original workspace: ' + (source.worktree_path || project?.path || 'unknown'), baseline, '',
        'Open Settings → Storage and reconnect the original device. Once healthy, open the original session and choose Resume. Compare both workspaces before bringing local edits across.',
        '', '## Recent locally saved messages', '', ...messages.map(m => (m.direction === 'in' ? 'User' : 'Session') + ': ' + String(m.text || '').slice(-1800))].join('\n\n');
      await writeFile(join(sessionArtifactRoot(id), 'RECOVERY.md'), text, { flag: 'wx', mode: 0o600 })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
      await rename(tree, cwd);
    } finally { await rm(stage, { force: true, recursive: true }); }
  }
  return { id, root, cwd, notes: join(sessionArtifactRoot(id), 'RECOVERY.md') };
}
