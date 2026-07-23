// Phase 1 — per-session git-worktree isolation. Covers the pure helpers + the real git lifecycle in
// src/worktrees.js, the per-project `isolation` toggle round-trip (guards the positional _upsert edit),
// the session worktree_path/branch schema, and the linked-worktree DB boot-guard decision logic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, statSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname, basename } from 'node:path';

// A scratch DB dir BEFORE importing anything that opens store.js (project_helpers/store).
process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'wt-data-'));
process.env.AIOS_WORKTREE_ROOT = mkdtempSync(join(tmpdir(), 'wt-root-'));

const wtmod = await import('../src/worktrees.js');
const { sanitize, worktreeRoot, branchFor, worktreePathFor, defaultBranch, ensureWorktree, isolatedWorktreeForLaunch, isSafeToRemove, removeWorktree, worktreeExists } = wtmod;

// ---- pure: sanitize ----
assert.ok(!sanitize('../etc/passwd').includes('..'), 'sanitize strips ..');
assert.equal(sanitize('hello world'), 'hello-world', 'spaces → dash');
assert.match(sanitize('café ☕ x'), /^[A-Za-z0-9._-]+$/, 'unicode stripped to safe set');
assert.ok(sanitize('a'.repeat(200)).length <= 64, 'overlong capped ≤64');
assert.ok(sanitize('').startsWith('x'), 'empty → stable hash');
assert.ok(sanitize('...---').length > 0, 'all-punct → hash, not empty');
assert.ok(!sanitize('.hidden').startsWith('.'), 'no leading dot');

// ---- pure: branch + path (no escape) ----
const proj = { name: 'aios', path: '/tmp/x' };
assert.equal(branchFor(proj, 's_abc'), 'supercalm/aios/s_abc', 'branch shape');
assert.ok(worktreePathFor(proj, 's_abc').startsWith(worktreeRoot()), 'worktree path under root');
// a malicious sid/name is NEUTRALIZED by sanitize (../ stripped) so the path stays under root — never escapes.
assert.ok(worktreePathFor({ name: 'ok', path: '/tmp' }, '../../../etc').startsWith(worktreeRoot() + sep), 'malicious sid neutralized, stays under root');
assert.ok(worktreePathFor({ name: '../../evil', path: '/tmp' }, 's').startsWith(worktreeRoot() + sep), 'malicious project name neutralized');

// ---- real git lifecycle on a throwaway repo ----
const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'));
execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
writeFileSync(join(repo, 'a.txt'), 'hi');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
execFileSync('git', ['-C', repo, 'switch', '-qc', 'release/production']);
writeFileSync(join(repo, 'release.txt'), 'production\n');
execFileSync('git', ['-C', repo, 'add', 'release.txt']);
execFileSync('git', ['-C', repo, 'commit', '-qm', 'production release']);
const releaseHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', repo, 'switch', '-q', 'main']);

assert.equal(await defaultBranch(repo), 'main', 'defaultBranch resolves main');
const aggregate = mkdtempSync(join(tmpdir(), 'wt-non-git-'));
await assert.rejects(
  isolatedWorktreeForLaunch({ repoPath: aggregate, sid: 's_aggregate', project: { name: 'aggregate', path: aggregate } }),
  (e) => e?.code === 'isolation-project-not-git' && /project path itself.*Git checkout/.test(e.message),
  'enabled isolation fails closed for a non-Git aggregate directory',
);
const wt = await ensureWorktree({ repoPath: repo, sid: 's_one', project: { name: 'proj', path: repo } });
assert.ok(existsSync(wt.path) && !wt.reused, 'worktree created');
assert.equal(await worktreeExists(repo, wt.path), true, 'worktreeExists (realpath-aware)');
const wt2 = await ensureWorktree({ repoPath: repo, sid: 's_one', project: { name: 'proj', path: repo } });
assert.ok(wt2.reused && wt2.path === wt.path, 'idempotent reuse');

assert.equal(await isSafeToRemove(repo, wt.path, wt.branch), true, 'clean + no commits → safe');
writeFileSync(join(wt.path, 'dirty.txt'), 'x');
assert.equal(await isSafeToRemove(repo, wt.path, wt.branch), false, 'dirty → not safe');
assert.equal((await removeWorktree({ repoPath: repo, path: wt.path, branch: wt.branch })).removed, false, 'dirty → retained, not removed');
rmSync(join(wt.path, 'dirty.txt'));
writeFileSync(join(wt.path, 'b.txt'), 'y');
execFileSync('git', ['-C', wt.path, 'add', '.']);
execFileSync('git', ['-C', wt.path, 'commit', '-qm', 'work']);
assert.equal(await isSafeToRemove(repo, wt.path, wt.branch), false, 'commits beyond base → not safe (retained)');
const wt3 = await ensureWorktree({ repoPath: repo, sid: 's_two', project: { name: 'proj', path: repo } });
assert.equal((await removeWorktree({ repoPath: repo, path: wt3.path, branch: wt3.branch })).removed, true, 'clean/no-commit → removed');
assert.equal(existsSync(wt3.path), false, 'removed worktree gone');
const releaseWt = await ensureWorktree({
  repoPath: repo,
  sid: 's_release',
  project: { name: 'proj', path: repo },
  baseBranch: 'release/production',
});
assert.equal(
  execFileSync('git', ['-C', releaseWt.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  releaseHead,
  'declared production branch, not default branch, is the new session base',
);
assert.equal(
  execFileSync('git', ['-C', repo, 'config', '--get', `branch.${releaseWt.branch}.aios-base`], { encoding: 'utf8' }).trim(),
  'release/production',
  'session branch records its production base',
);
assert.equal(await isSafeToRemove(repo, releaseWt.path, releaseWt.branch), true, 'clean production-based session can be removed');
assert.equal((await removeWorktree({ repoPath: repo, path: releaseWt.path, branch: releaseWt.branch })).removed, true, 'production-based session removed safely');

// ---- per-project isolation toggle (positional _upsert integrity) ----
const ph = await import('../src/project_helpers.js');
ph.setHelpers('p1', { context_inject: 1, preflight: 0, wiki_mcp: 1, lessons: 0, isolation: 1 });
const h = ph.getHelpers('p1');
assert.deepEqual([h.context_inject, h.preflight, h.wiki_mcp, h.lessons, h.isolation], [1, 0, 1, 0, 1], 'columns not swapped');
assert.equal(ph.helperEnabled('p1', 'isolation'), true, 'helperEnabled isolation true');
ph.setHelpers('p1', { isolation: 0 });
assert.equal(ph.helperEnabled('p1', 'isolation'), false, 'flipped off');
assert.equal(ph.getHelpers('p1').wiki_mcp, 1, 'partial update leaves others intact');
assert.equal(ph.helperEnabled('p_fresh', 'isolation'), false, 'default OFF for a new project');
process.env.AIOS_ISOLATION = '1';
assert.equal(ph.helperEnabled('p1', 'isolation'), true, 'env kill-switch forces ON');
process.env.AIOS_ISOLATION = '0';
assert.equal(ph.helperEnabled('p_fresh', 'isolation'), false, 'env kill-switch forces OFF');
delete process.env.AIOS_ISOLATION;

// ---- session worktree_path/branch schema (writable via updateSession) ----
const store = await import('../src/store.js');
const p = store.createProject ? null : null; // projects helper varies; write a session row directly
const sid = 's_wt_' + Date.now();
store.createSession({ id: sid, project_id: null, tool: 'codex', tmux: 'x', title: 't', status: 'working' });
store.updateSession(sid, { worktree_path: '/some/wt/path', branch: 'supercalm/x/s' });
const row = store.getSession(sid);
assert.equal(row.worktree_path, '/some/wt/path', 'worktree_path persisted');
assert.equal(row.branch, 'supercalm/x/s', 'branch persisted');

// ---- linked-worktree DB boot-guard decision (mirrors src/store.js) ----
const realish = (pp) => { let cur = resolve(pp); const tail = []; while (!existsSync(cur) && dirname(cur) !== cur) { tail.unshift(basename(cur)); cur = dirname(cur); } try { return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur); } catch { return resolve(pp); } };
const decide = (root, dbPath) => { const g = join(root, '.git'); if (!(existsSync(g) && statSync(g).isFile())) return 'boot'; const d = realish(dbPath), r = realish(root); return (d !== r && !d.startsWith(r + sep)) ? 'refuse' : 'boot'; };
const fakeWt = mkdtempSync(join(tmpdir(), 'wt-fake-')); writeFileSync(join(fakeWt, '.git'), 'gitdir: x'); mkdirSync(join(fakeWt, 'data'), { recursive: true });
assert.equal(decide(fakeWt, '/Users/nobody/aios/data/aios.db'), 'refuse', 'worktree + foreign canonical DB → refuse');
assert.equal(decide(fakeWt, join(fakeWt, 'data', 'aios.db')), 'boot', 'worktree + own scratch data → boot');

console.log('worktrees.test: all assertions passed');
