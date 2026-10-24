import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rename, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-worktree-registration-')));
process.env.AIOS_DATA = join(root, 'data');
process.env.AIOS_WORKTREE_ROOT = join(root, 'worktrees');
delete process.env.AIOS_LIVE_STORAGE_CONFIG;
const { ensureWorktree, worktreeExists } = await import('../src/worktrees.js');
const { gitOut } = await import('../src/git.js');
const repo = join(root, 'repo'), project = { name: 'fixture', path: repo };
const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const unavailable = error => error.status === 503 && /retained/.test(error.message);
const calls = [];
const targetOnly = async (cwd, args, options) => {
  calls.push({ cwd, args });
  assert.notEqual(args[0], 'worktree', 'existing linked checkout never enumerates, creates, removes, or prunes worktrees');
  assert.ok(options.timeout > 0 && options.timeout <= 30000);
  return gitOut(cwd, args, options);
};
try {
  await mkdir(repo); await mkdir(process.env.AIOS_DATA);
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'source'), 'source'); git(['add', '.']); git(['commit', '-qm', 'initial']);
  const wt = await ensureWorktree({ repoPath: repo, sid: 's_exact', project });
  const marker = join(wt.path, '.git'), admin = join(repo, '.git', 'worktrees', 's_exact');
  const markerText = await readFile(marker, 'utf8'), backlink = join(admin, 'gitdir'), common = join(admin, 'commondir');
  const backlinkText = await readFile(backlink, 'utf8'), commonText = await readFile(common, 'utf8');
  await writeFile(join(wt.path, 'dirty-untracked'), 'preserve this');

  // An unrelated invalid registration makes enumeration undesirable. The exact
  // target still proves both directions without reading any unrelated metadata.
  const unrelated = join(repo, '.git', 'worktrees', 'unavailable'); await mkdir(unrelated);
  await symlink(join(root, 'offline-registration'), join(unrelated, 'gitdir'));
  assert.equal(await worktreeExists(repo, wt.path, { runGit: targetOnly }), true);
  assert.equal(calls.length, 2, 'only project common-dir and target metadata Git observations');
  assert.equal(await worktreeExists(repo, join(wt.path, 'missing'), { runGit: targetOnly }), false);
  assert.equal(calls.length, 2, 'an absent checkout does not query Git');

  const altered = async (file, value, check = unavailable) => {
    const saved = await readFile(file);
    try { await writeFile(file, value); await assert.rejects(worktreeExists(repo, wt.path, { runGit: targetOnly }), check); }
    finally { await writeFile(file, saved); }
    assert.equal(await readFile(join(wt.path, 'dirty-untracked'), 'utf8'), 'preserve this');
  };
  await altered(backlink, join(repo, '.git') + '\n', e => unavailable(e) && e.code === 'worktree-existing-unconfirmed');
  for (const malformed of ['', '\n', `${backlinkText}extra\n`, `${backlinkText.trim()}\0`, 'x'.repeat(16 * 1024 + 1)]) {
    await altered(backlink, malformed);
  }
  await altered(marker, 'not a Git pointer\n');
  try {
    await assert.rejects(worktreeExists(repo, wt.path, { runGit: async (cwd, args, options) => {
      const result = await targetOnly(cwd, args, options);
      if (cwd === wt.path) await writeFile(marker, markerText + '\n');
      return result;
    } }), e => unavailable(e) && /marker changed/.test(e.message));
  } finally { await writeFile(marker, markerText); }
  await rename(marker, marker + '.saved');
  try { await assert.rejects(worktreeExists(repo, wt.path, { runGit: targetOnly }), unavailable, 'missing forward pointer is unknown, not permission to recreate'); }
  finally { await rename(marker + '.saved', marker); }
  await altered(common, join(root, 'missing-common-directory') + '\n');
  const foreign = join(root, 'foreign'); await mkdir(foreign);
  execFileSync('git', ['-C', foreign, 'init', '-q', '-b', 'main']);
  await altered(common, join(foreign, '.git') + '\n');

  await rename(backlink, backlink + '.saved');
  try {
    await assert.rejects(worktreeExists(repo, wt.path, { runGit: targetOnly }), unavailable);
    await symlink(backlink + '.saved', backlink);
    await assert.rejects(worktreeExists(repo, wt.path, { runGit: targetOnly }), unavailable, 'symlink backlink is not regular registration evidence');
  } finally { await rm(backlink, { force: true }); await rename(backlink + '.saved', backlink); }

  // A valid common-dir and backlink outside common/worktrees is not registration.
  const outside = join(repo, '.git', 'outside'); await rename(admin, outside);
  try {
    await writeFile(marker, `gitdir: ${outside}\n`); await writeFile(join(outside, 'commondir'), '..\n');
    await assert.rejects(worktreeExists(repo, wt.path, { runGit: targetOnly }), e => unavailable(e) && /outside/.test(e.message));
  } finally {
    await rename(outside, admin); await writeFile(marker, markerText); await writeFile(common, commonText);
  }

  const failure = { text: '', error: 'fixture Git command failed', diagnostics: {
    code: null, killed: true, signal: 'SIGKILL', timedOut: true, timeoutMs: 30000, elapsedMs: 30001, stderr: 'fixture stderr',
  } };
  await assert.rejects(worktreeExists(repo, wt.path, { runGit: async () => failure }), e => {
    assert.equal(e.status, 503); assert.equal(e.code, 'worktree-registration-unavailable');
    assert.equal(e.cause.message, failure.error); assert.deepEqual(e.gitDiagnostics, failure.diagnostics);
    assert.match(e.message, /timed out after 30000 ms/); return true;
  });
  for (const malformed of ['', `${repo}\nextra`, 'relative/path', `${repo}\0`]) {
    await assert.rejects(worktreeExists(repo, wt.path, { runGit: async (cwd, args, options) => cwd === repo
      ? { text: malformed, error: '' } : gitOut(cwd, args, options) }), e => unavailable(e) && /malformed Git paths/.test(e.message));
  }
  await assert.rejects(worktreeExists(repo, wt.path, { timeoutMs: 20, runGit: async () => {
    await new Promise(resolve => setTimeout(resolve, 30)); return { text: join(repo, '.git'), error: '' };
  } }), e => unavailable(e) && e.cause?.code === 'ETIMEDOUT');

  // Preserve the full-inventory fallback for a validated main checkout and its
  // original typed diagnostic; failed observations never mean "absent".
  await assert.rejects(worktreeExists(repo, repo, { runGit: async (cwd, args, options) => args[0] === 'worktree'
    ? failure : gitOut(cwd, args, options) }), e => e.code === 'worktree-inventory-unavailable'
      && e.status === 503 && e.gitDiagnostics.signal === 'SIGKILL');

  // Move BOTH repository and worktrees, retaining their registered logical names
  // and original .git pointers. Git emits physical paths; both spellings work.
  const mount = join(root, 'mounts', 'remote'), repoTarget = join(mount, 'project'), wtTarget = join(mount, 'worktrees');
  await mkdir(mount, { recursive: true }); await rename(repo, repoTarget); await symlink(repoTarget, repo);
  const logical = dirname(wt.path); await rename(logical, wtTarget); await symlink(wtTarget, logical);
  await writeFile(join(process.env.AIOS_DATA, 'live-storage.json'), JSON.stringify({ version: 1, id: 'fixture-only', mount,
    mappings: [{ source: repo, target: repoTarget, active: true }, { source: logical, target: wtTarget, active: true }] }));
  for (const repoName of [repo, repoTarget]) for (const wtName of [wt.path, join(wtTarget, 's_exact')]) {
    assert.equal(await worktreeExists(repoName, wtName, { runGit: targetOnly }), true);
  }
  assert.equal(await readFile(join(wt.path, 'dirty-untracked'), 'utf8'), 'preserve this');
  console.log('worktree registration: bounded exact proof, reciprocal/common-dir conflicts, malformed/unreadable evidence, aliases, and diagnostics passed');
} finally { await rm(root, { recursive: true, force: true }); }
