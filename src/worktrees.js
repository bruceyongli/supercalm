// Per-session git-worktree isolation (multi-session collaboration, Phase 1).
// Each isolated session gets its OWN worktree + branch off the repo's default branch, so concurrent
// sessions on the same repo never clobber each other's working tree. Worktrees live OUTSIDE the repo
// (AIOS_WORKTREE_ROOT || ~/.local/share/aios/worktrees) — never under the repo's gitignored data/,
// which recursive scanners / `rm data` / repo-discovery would foul (gpt review).
//
// Built entirely on the fail-soft `gitOut` primitive (src/git.js); no direct throws from git errors.
// Pure helpers (sanitize / branchFor / worktreePathFor / isSafeToRemove predicate inputs) are unit-tested.
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gitOut } from './git.js';

// ---- pure path/name helpers -------------------------------------------------------------------
// A git-ref- and filesystem-safe component: only [A-Za-z0-9._-], no '..', no leading/trailing '.'/'-',
// capped, and an empty result falls back to a stable hash so a path/branch is always produced.
export function sanitize(component) {
  let s = String(component ?? '').replace(/[^A-Za-z0-9._-]+/g, '-');
  s = s.replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-'); // '..' is an illegal git ref; collapse dashes
  s = s.replace(/^[.\-]+/, '').replace(/[.\-]+$/, '');
  s = s.slice(0, 64).replace(/[.\-]+$/, '');
  if (!s) s = 'x' + createHash('sha1').update(String(component ?? '')).digest('hex').slice(0, 10);
  return s;
}

export function worktreeRoot() {
  return process.env.AIOS_WORKTREE_ROOT || join(homedir(), '.local', 'share', 'aios', 'worktrees');
}

function projSlug(project) {
  return sanitize(project?.name || (project?.path ? basename(project.path) : '') || 'repo');
}

export function branchFor(project, sid) {
  return `supercalm/${projSlug(project)}/${sanitize(sid)}`;
}

export function worktreePathFor(project, sid) {
  const p = join(worktreeRoot(), projSlug(project), sanitize(sid));
  return assertUnderRoot(p); // defense-in-depth: the sanitized parts can never escape, but verify
}

function assertUnderRoot(p) {
  const root = resolve(worktreeRoot());
  const rp = resolve(p);
  if (rp !== root && !rp.startsWith(root + sep)) throw new Error('worktree path escapes root: ' + p);
  return rp;
}

// ---- git-backed lifecycle ---------------------------------------------------------------------
export async function isGitRepo(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return false;
  const r = await gitOut(repoPath, ['rev-parse', '--is-inside-work-tree']);
  return r.text.trim() === 'true';
}

// The repo's integration branch: origin/HEAD → main/master → current HEAD. Offline/no-origin safe.
export async function defaultBranch(repoPath) {
  const sym = await gitOut(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const m = sym.text.match(/refs\/remotes\/origin\/(.+)$/);
  if (m) return m[1].trim();
  for (const b of ['main', 'master']) {
    const e = await gitOut(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
    if (e.text.trim()) return b;
  }
  const h = await gitOut(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return h.text && h.text.trim() !== 'HEAD' ? h.text.trim() : 'main';
}

// Compare by REALPATH: `git worktree list` reports realpaths (e.g. /private/var on macOS) which may
// differ from our chosen path through symlinks — a plain resolve() would miss the match.
const realp = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
export async function worktreeExists(repoPath, path) {
  if (!existsSync(path)) return false;
  const want = realp(path);
  const r = await gitOut(repoPath, ['worktree', 'list', '--porcelain']);
  return r.text.split('\n').some((l) => l.startsWith('worktree ') && realp(l.slice('worktree '.length).trim()) === want);
}

// Per-repo single-flight so two concurrent launches on the same repo can't race `git worktree add`
// (models session_labels.js serialize()). Chain runs fn regardless of the previous item's outcome.
const _locks = new Map();
function serialize(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _locks.set(key, next.then(() => {}, () => {}));
  return next;
}

// Create-or-reuse the session's worktree. Returns { path, branch, reused }. Concurrency-safe +
// failure-atomic: a half-made worktree is force-removed + pruned before we surface the error.
// Callers fail OPEN (on throw, launch falls back to the shared tree) — never let this wedge a launch.
export async function ensureWorktree({ repoPath, sid, project, desiredPath = '', desiredBranch = '' }) {
  return serialize(resolve(repoPath), async () => {
    if (!(await isGitRepo(repoPath))) throw new Error('not a git worktree: ' + repoPath);
    const path = assertUnderRoot(desiredPath || worktreePathFor(project, sid));
    const branch = desiredBranch || branchFor(project, sid);

    if (await worktreeExists(repoPath, path)) return { path, branch, reused: true }; // resume / re-launch

    await mkdir(dirname(path), { recursive: true });
    // Resume-after-prune: the branch may already exist — attach it. Fresh: create it off the default branch.
    const branchExists = !!(await gitOut(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).text.trim();
    const addArgs = branchExists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, await defaultBranch(repoPath)];
    const r = await gitOut(repoPath, addArgs, { timeout: 30000 });
    if (r.error || !existsSync(path)) {
      await gitOut(repoPath, ['worktree', 'remove', '--force', path], { timeout: 15000 }).catch(() => {});
      await gitOut(repoPath, ['worktree', 'prune']).catch(() => {});
      throw new Error('worktree add failed: ' + (r.error || 'path missing after add'));
    }
    return { path, branch, reused: false };
  });
}

// Safe ONLY when the worktree is clean AND its branch has no commits beyond the base it forked from.
// Returns false on any uncertainty (git error) — we never remove what we can't verify.
export async function isSafeToRemove(repoPath, path, branch) {
  if (!existsSync(path)) return true; // already gone — safe to prune the registration
  const st = await gitOut(path, ['status', '--porcelain']);
  if (st.error) return false;
  if (st.text.trim()) return false; // dirty
  if (!branch) return true;
  const base = await defaultBranch(repoPath);
  const mb = await gitOut(repoPath, ['merge-base', base, branch]);
  if (mb.error || !mb.text.trim()) return false;
  const ahead = await gitOut(repoPath, ['rev-list', '--count', `${mb.text.trim()}..${branch}`]);
  return !ahead.error && ahead.text.trim() === '0';
}

// Remove a worktree ONLY when safe (clean + no unmerged commits); otherwise RETAIN it (the caller
// records a pm_event / surfaces it). Never `--force` by default — that would silently drop work.
export async function removeWorktree({ repoPath, path, branch = '' } = {}) {
  if (!(await isSafeToRemove(repoPath, path, branch))) {
    return { removed: false, reason: 'retained: uncommitted changes or commits beyond base' };
  }
  await gitOut(repoPath, ['worktree', 'remove', path], { timeout: 15000 }); // no --force
  if (branch) await gitOut(repoPath, ['branch', '-d', branch]); // safe delete (refuses if unmerged)
  await gitOut(repoPath, ['worktree', 'prune']);
  return { removed: true };
}

// Prune stale worktree registrations + return the live worktree paths. The DB-side reconciliation
// (dropping pm_session_runtime rows for exited sessions, disk accounting) lives in the fleet monitor,
// which has store access — this stays layering-clean (git only).
export async function reconcile(repoPath) {
  await gitOut(repoPath, ['worktree', 'prune']);
  const r = await gitOut(repoPath, ['worktree', 'list', '--porcelain']);
  const worktrees = r.text.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
  return { worktrees };
}
