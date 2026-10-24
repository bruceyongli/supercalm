// Per-session git-worktree isolation (multi-session collaboration, Phase 1).
// Each isolated session gets its OWN worktree + branch off the repo's default branch, so concurrent
// sessions on the same repo never clobber each other's working tree. Worktrees live OUTSIDE the repo
// (AIOS_WORKTREE_ROOT || ~/.local/share/aios/worktrees) — never under the repo's gitignored data/,
// which recursive scanners / `rm data` / repo-discovery would foul (gpt review).
//
// Uses the fail-soft `gitOut` primitive (src/git.js); failed observations remain
// explicit unknown states and never authorize replacing/removing an existing checkout.
// Pure helpers (sanitize / branchFor / worktreePathFor / isSafeToRemove predicate inputs) are unit-tested.
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, sep, isAbsolute } from 'node:path';
import { existsSync, constants } from 'node:fs';
import { mkdir, lstat, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gitOut } from './git.js';
import { assertLiveStorage, sameStoragePath } from './live_storage.js';
import { provisionLiveStorageRoot } from './storage_provision.js';

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
const READ_TIMEOUT_MS = 30000;
export async function isGitRepo(repoPath, { runGit = gitOut } = {}) {
  if (!repoPath || !existsSync(repoPath)) return false;
  const r = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree'], { timeout: READ_TIMEOUT_MS });
  return !r.error && r.text.trim() === 'true';
}

// Isolation is an operator-selected safety contract, not an optimization. If it is enabled,
// silently falling back to the shared checkout defeats the setting and lets concurrent agents
// overwrite or deploy one another's work. Keep shared-directory behavior available by turning
// isolation off explicitly; while it is on, fail closed with an actionable launch error.
export async function isolatedWorktreeForLaunch({ repoPath, sid, project, baseBranch = '' }) {
  if (!(await isGitRepo(repoPath))) {
    const e = new Error(`multi-session isolation requires the project path itself to be a Git checkout: ${repoPath}. Register the repository root as its own project, or explicitly disable isolation for this aggregate directory`);
    e.code = 'isolation-project-not-git';
    throw e;
  }
  try {
    return await ensureWorktree({ repoPath, sid, project, baseBranch });
  } catch (cause) {
    const e = new Error(`multi-session isolation could not create a worktree for ${repoPath}: ${cause?.message || cause}`);
    e.code = 'isolation-worktree-failed';
    e.cause = cause;
    throw e;
  }
}

// The repo's integration branch: origin/HEAD → main/master → current HEAD. Offline/no-origin safe.
export async function defaultBranch(repoPath, { runGit = gitOut } = {}) {
  const sym = await runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { timeout: READ_TIMEOUT_MS });
  const m = sym.text.match(/refs\/remotes\/origin\/(.+)$/);
  if (m) return m[1].trim();
  for (const b of ['main', 'master']) {
    const e = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { timeout: READ_TIMEOUT_MS });
    if (e.text.trim()) return b;
  }
  const h = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: READ_TIMEOUT_MS });
  return h.text && h.text.trim() !== 'HEAD' ? h.text.trim() : 'main';
}

const pathStat = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const diagnosticFailure = (message, code = 'worktree-inventory-unavailable', failure = null) => {
  const details = failure?.diagnostics;
  const cause = failure?.error ? Object.assign(new Error(failure.error), details) : failure;
  const timeout = details?.timedOut ? ` Git timed out after ${details.timeoutMs} ms.` : '';
  const detail = cause?.message ? ` ${cause.message.slice(0, 4096)}` : '';
  return Object.assign(new Error(message + timeout + detail, cause ? { cause } : undefined), {
    code, status: 503, ...(details ? { gitDiagnostics: details } : {}),
  });
};

// Git itself reads the forward .git pointer and commondir. Prove that this is
// THIS repository's direct worktrees/<id> registration, then read only its reverse
// pointer. A full `worktree list` reads every registration, even with porcelain;
// unrelated slow/offline worktrees must not block a healthy session's recovery.
async function registeredWorktree(repoPath, path, want, { runGit, remaining, observe }) {
  const unavailable = 'Could not verify the Git worktree registration. Existing files were retained; retry when storage responds.';
  const unconfirmed = reason => diagnosticFailure(`The existing checkout's Git registration is unconfirmed (${reason}). Existing files were retained.`, 'worktree-existing-unconfirmed');
  const marker = join(path, '.git'), forwardBefore = await observe(() => lstat(marker));
  const git = async (cwd, args) => {
    const r = await runGit(cwd, args, { timeout: remaining(), maxBuffer: 64 * 1024 });
    if (r.error) throw diagnosticFailure(unavailable, 'worktree-registration-unavailable', r);
    return r.text;
  };
  const common = await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const evidence = await git(path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']);
  const fields = evidence.split('\n');
  if (fields.length !== 3 || ![common, ...fields].every(p => isAbsolute(p) && !/[\r\n\0]/.test(p))) throw unconfirmed('malformed Git paths');
  const [admin, targetCommon, top] = fields;
  // Canonicalize only the requested checkout/repository metadata, never another
  // session's path. This also handles platform aliases such as /var -> /private/var.
  const expectedCommon = await observe(() => realpath(common));
  const actualCommon = await observe(() => realpath(targetCommon));
  const actualAdmin = await observe(() => realpath(admin));
  if (actualCommon !== expectedCommon || await observe(() => realpath(top)) !== want) throw unconfirmed('checkout or common directory mismatch');
  if (actualAdmin === expectedCommon) return false; // a main checkout still uses the inventory below
  if (!forwardBefore.isFile()) throw unconfirmed('linked checkout marker is not a regular file');
  if (dirname(actualAdmin) !== join(expectedCommon, 'worktrees')) throw unconfirmed('registration is outside the project worktrees directory');

  const backlinkFile = join(actualAdmin, 'gitdir');
  // A small regular metadata file only; no symlink/FIFO/device reads or unbounded
  // allocation. observe supplies the same overall deadline as the Git commands.
  const backlink = await observe(async () => {
    const handle = await open(backlinkFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > 16 * 1024) throw unconfirmed('invalid backlink file');
      const buffer = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (bytesRead !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unconfirmed('backlink changed while reading');
      return buffer.subarray(0, bytesRead).toString('utf8').replace(/\r?\n$/, '');
    } finally { await handle.close(); }
  });
  if (!backlink || /[\r\n\0]/.test(backlink)) throw unconfirmed('malformed backlink');
  const pointedMarker = resolve(actualAdmin, backlink);
  // Registered relocation aliases may have logical/physical spellings. Verify
  // the real target as well: an intact alias never excuses a conflicting link.
  if (!sameStoragePath(pointedMarker, marker) && await observe(() => realpath(pointedMarker)) !== join(want, '.git')) {
    throw unconfirmed('backlink points to another checkout');
  }
  if (await observe(() => realpath(pointedMarker)) !== await observe(() => realpath(marker))) throw unconfirmed('backlink identity mismatch');
  const forwardAfter = await observe(() => lstat(marker));
  if (forwardBefore.dev !== forwardAfter.dev || forwardBefore.ino !== forwardAfter.ino || forwardBefore.size !== forwardAfter.size
      || forwardBefore.mtimeMs !== forwardAfter.mtimeMs || forwardBefore.ctimeMs !== forwardAfter.ctimeMs) throw unconfirmed('checkout marker changed while reading');
  return true;
}

// Missing checkout is false; failed/conflicting observations remain UNKNOWN and
// never authorize replacing it. The complete read has one bounded budget.
export async function worktreeExists(repoPath, path, { runGit = gitOut, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  const expired = () => diagnosticFailure('Git worktree registration observation timed out. Existing files were retained.',
    'worktree-registration-unavailable', Object.assign(new Error(`Read budget of ${timeoutMs} ms exhausted`), { code: 'ETIMEDOUT' }));
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw expired(); return ms; };
  const observe = async action => {
    const ms = remaining();
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(expired()), ms); })]); }
    catch (cause) {
      if (cause.status === 503) throw cause;
      throw diagnosticFailure('Could not read the Git worktree registration. Existing files were retained.', 'worktree-registration-unavailable', cause);
    } finally { clearTimeout(timer); }
  };
  if (!await observe(() => pathStat(path))) return false;
  const want = await observe(() => realpath(path));
  if (await registeredWorktree(repoPath, path, want, { runGit, remaining, observe })) return true;
  const r = await runGit(repoPath, ['worktree', 'list', '--porcelain', '-z'], { timeout: remaining() });
  if (r.error) throw diagnosticFailure('Could not read the Git worktree inventory. Existing files were retained; retry when storage responds.', 'worktree-inventory-unavailable', r);
  const rows = r.text.split('\0').filter(line => line.startsWith('worktree '));
  if (!rows.length) throw diagnosticFailure('Git returned an incomplete worktree inventory. Existing files were retained.');
  const paths = rows.map(row => row.slice('worktree '.length)), logical = resolve(path);
  // The common resume case needs no filesystem reads for the other sessions.
  // Old/archived rows may be on slow/offline storage; exact inventory evidence wins.
  if (paths.some(listed => resolve(listed) === logical || resolve(listed) === want)) return true;
  if (paths.some(listed => sameStoragePath(listed, path))) return true;
  for (const listed of paths) {
    try { if (await observe(() => realpath(listed)) === want) return true; }
    catch (error) { if (error.code !== 'ENOENT' && error.cause?.code !== 'ENOENT') throw error; }
  }
  return false;
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
// failure-preserving: a failed/slow Git command is never authority to remove a
// checkout, branch or registration. Partial creations stay for safe retry/inspection.
export async function ensureWorktree({ repoPath, sid, project, desiredPath = '', desiredBranch = '', baseBranch = '' }, { runGit = gitOut } = {}) {
  return serialize(resolve(repoPath), async () => {
    await assertLiveStorage(repoPath);
    if (!(await isGitRepo(repoPath, { runGit }))) throw new Error('Git could not confirm the project checkout; files were retained: ' + repoPath);
    const path = assertUnderRoot(desiredPath || worktreePathFor(project, sid));
    await provisionLiveStorageRoot(dirname(path), 'worktree');
    await assertLiveStorage(path);
    const branch = desiredBranch || branchFor(project, sid);

    if (await worktreeExists(repoPath, path, { runGit })) return { path, branch, reused: true }; // resume / re-launch
    if (await pathStat(path)) throw diagnosticFailure('The session checkout exists but Git did not confirm its registration. It was retained; inspect or repair its registration before retrying.', 'worktree-existing-unconfirmed');

    await mkdir(dirname(path), { recursive: true });
    // Resume-after-prune: the branch may already exist — attach it. Fresh: create it off the default branch.
    // Unlike rev-parse, for-each-ref succeeds with empty output for a missing ref;
    // an actual command failure can therefore never be mistaken for an absent branch.
    const refs = await runGit(repoPath, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`], { timeout: READ_TIMEOUT_MS });
    if (refs.error) throw diagnosticFailure('Could not read the session branch. Existing files and refs were retained.');
    const branchExists = refs.text.split('\n').includes(`refs/heads/${branch}`);
    let base = '';
    let baseCommit = '';
    if (!branchExists) {
      base = baseBranch || await defaultBranch(repoPath, { runGit });
      const verified = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { timeout: READ_TIMEOUT_MS });
      baseCommit = verified.text.trim();
      if (verified.error || !baseCommit) throw new Error(`worktree base branch does not exist: ${base}`);
    }
    const addArgs = branchExists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, baseCommit];
    // Another process may have created the path since the inventory observation.
    if (await pathStat(path)) throw diagnosticFailure('The worktree path appeared during creation. It was retained; retry to inspect it.', 'worktree-existing-unconfirmed');
    const r = await runGit(repoPath, addArgs, { timeout: 60000 });
    if (r.error || !existsSync(path)) {
      throw new Error('worktree add failed; any existing or partial checkout and branch were retained: ' + (r.error || 'path missing after add'));
    }
    // Remember the branch the session forked from. Cleanup must compare against this release base,
    // not origin/HEAD, or a clean branch based on a production release branch appears "ahead" forever.
    if (!branchExists) {
      const configured = await runGit(repoPath, ['config', `branch.${branch}.aios-base`, base], { timeout: READ_TIMEOUT_MS });
      if (configured.error) {
        throw new Error('could not record worktree base branch; checkout and branch were retained: ' + configured.error);
      }
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
  const configuredBase = await gitOut(repoPath, ['config', '--get', `branch.${branch}.aios-base`]);
  const base = configuredBase.text.trim() || await defaultBranch(repoPath);
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
