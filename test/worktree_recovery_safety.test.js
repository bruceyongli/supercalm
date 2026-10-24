import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rename, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-worktree-recovery-')));
process.env.AIOS_DATA = join(root, 'data'); process.env.AIOS_WORKTREE_ROOT = join(root, 'worktrees');
delete process.env.AIOS_LIVE_STORAGE_CONFIG;
const { ensureWorktree, worktreeExists } = await import('../src/worktrees.js');
const { gitOut } = await import('../src/git.js');
const repo = join(root, 'repo'), project = { name: 'fixture', path: repo };
const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const destructive = calls => calls.some(a => a[0] === 'worktree' && ['remove', 'prune'].includes(a[1]) || a[0] === 'branch' && a.some(v => ['-D', '-d'].includes(v)));
try {
  await mkdir(repo); await mkdir(process.env.AIOS_DATA);
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'source.txt'), 'source'); git(['add', '.']); git(['commit', '-qm', 'initial']);
  const original = await ensureWorktree({ repoPath: repo, sid: 's_original', project });
  const important = join(original.path, 'uncommitted.txt'); await writeFile(important, 'never remove this work');
  const existing = { repoPath: repo, sid: 's_original', project, desiredPath: original.path, desiredBranch: original.branch };
  const unreadableRow = join(root, 'symlink-loop'); await symlink(unreadableRow, unreadableRow);
  assert.equal(await worktreeExists(repo, original.path, { runGit: async () => ({
    text: `worktree ${unreadableRow}\0\0worktree ${original.path}\0\0`, error: '',
  }) }), true, 'exact inventory match does not stat unrelated slow/broken worktree paths');
  let calls = [];
  await assert.rejects(ensureWorktree(existing, { runGit: async (cwd, args, options) => {
    calls.push(args);
    assert.ok(options.timeout >= 30000, 'remote diagnostics receive a bounded 30-second budget');
    if (args[0] === 'worktree' && args[1] === 'list') return { text: '', error: 'timed out' };
    return gitOut(cwd, args, options);
  } }), e => e.code === 'worktree-inventory-unavailable');
  assert.equal(await readFile(important, 'utf8'), 'never remove this work');
  assert.equal(calls.some(a => a[0] === 'worktree' && a[1] === 'add'), false); assert.equal(destructive(calls), false);
  calls = [];
  await assert.rejects(ensureWorktree(existing, { runGit: async (cwd, args, options) => {
    calls.push(args);
    if (args[0] === 'worktree' && args[1] === 'list') return { text: `worktree ${repo}\0HEAD ${git(['rev-parse', 'HEAD'])}\0\0`, error: '' };
    return gitOut(cwd, args, options);
  } }), e => e.code === 'worktree-existing-unconfirmed');
  assert.equal(calls.some(a => a[0] === 'worktree' && a[1] === 'add'), false); assert.equal(destructive(calls), false);

  // The add succeeded on disk but the client received a timeout. The checkout,
  // branch and uncommitted contents survive, and an ordinary retry reuses it.
  calls = []; let timedPath;
  await assert.rejects(ensureWorktree({ repoPath: repo, sid: 's_timed_add', project }, { runGit: async (cwd, args, options) => {
    calls.push(args); const result = await gitOut(cwd, args, options);
    if (args[0] === 'worktree' && args[1] === 'add') {
      timedPath = args[2] === '-b' ? args[4] : args[2];
      await writeFile(join(timedPath, 'keep.txt'), 'partial delivery is not deletion authority');
      return { text: '', error: 'simulated timeout after successful add' };
    }
    return result;
  } }), /retained/);
  assert.equal(destructive(calls), false); assert.equal(await readFile(join(timedPath, 'keep.txt'), 'utf8'), 'partial delivery is not deletion authority');
  assert.equal((await ensureWorktree({ repoPath: repo, sid: 's_timed_add', project })).reused, true);

  calls = []; let configuredPath;
  await assert.rejects(ensureWorktree({ repoPath: repo, sid: 's_config_failure', project }, { runGit: async (cwd, args, options) => {
    calls.push(args);
    if (args[0] === 'config' && args[1]?.endsWith('.aios-base')) return { text: '', error: 'simulated configuration timeout' };
    const result = await gitOut(cwd, args, options);
    if (args[0] === 'worktree' && args[1] === 'add') configuredPath = args[4];
    return result;
  } }), /checkout and branch were retained/);
  assert.equal(destructive(calls), false); assert.equal(await worktreeExists(repo, configuredPath), true);

  const racePath = join(process.env.AIOS_WORKTREE_ROOT, 'fixture', 's_race'); calls = [];
  await assert.rejects(ensureWorktree({ repoPath: repo, sid: 's_race', project }, { runGit: async (cwd, args, options) => {
    calls.push(args);
    if (args[0] === 'for-each-ref') { await mkdir(racePath); await writeFile(join(racePath, 'keep.txt'), 'another creator'); }
    return gitOut(cwd, args, options);
  } }), e => e.code === 'worktree-existing-unconfirmed');
  assert.equal(calls.some(a => a[0] === 'worktree' && a[1] === 'add'), false); assert.equal(destructive(calls), false);
  assert.equal(await readFile(join(racePath, 'keep.txt'), 'utf8'), 'another creator');

  // Registration retains the logical path after a storage-only relocation.
  const mount = join(root, 'mounts', 'remote'), logical = dirname(original.path), target = join(mount, 'worktrees');
  await mkdir(mount, { recursive: true }); await rename(logical, target); await symlink(target, logical);
  await writeFile(join(process.env.AIOS_DATA, 'live-storage.json'), JSON.stringify({ version: 1, id: 'fixture-only', mount,
    mappings: [{ source: logical, target, active: true }] }));
  assert.equal(await worktreeExists(repo, original.path), true);
  assert.equal(await worktreeExists(repo, join(target, 's_original')), true);
  assert.equal(await readFile(important, 'utf8'), 'never remove this work');
  console.log('worktree recovery safety passed: slow/failed inventory, uncertain add/config, existing-path races retain all data; registered logical/physical aliases match');
} finally { await rm(root, { recursive: true, force: true }); }
