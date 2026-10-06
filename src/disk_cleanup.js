import { lstat, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { TMUX, ROOT } from './config.js';
import * as store from './store.js';
import { storageComponents, cleanupEligibility, isInside, storageInventory, measureStoragePath, exclusiveStorageRows } from './disk_storage.js';
import { isSafeToRemove, removeWorktree, worktreeExists } from './worktrees.js';
import { gitOut } from './git.js';
import { withSessionCleanup } from './session_cleanup_lock.js';
import { bus } from './bus.js';

const exec = promisify(execFile), plans = new Map(), receipts = new Map(), flights = new Map();
const MODES = new Set(['disposable', 'outputs', 'delete']);
const disposable = new Set(['logs', 'scratch', 'browser-cache', 'launch']);
function fail(message, code = 'unsafe-cleanup', status = 409) {
  const error = new Error(message); error.code = code; error.status = status; throw error;
}
const identity = s => JSON.stringify([s.id, s.status, s.desired_status, s.runtime_status, s.status_reason,
  s.project_id, s.worktree_path, s.branch, s.tmux, s.ended_at]);
async function safeOwnedWorktree(session, project) {
  if (!project || !session.branch || !await worktreeExists(project.path, session.worktree_path)) return false;
  const proxy = await realpath(join(homedir(), 'proxy')).catch(() => resolve(join(homedir(), 'proxy')));
  const repo = await realpath(project.path).catch(() => resolve(project.path));
  if (isInside(repo, proxy)) return false;
  const actual = await gitOut(session.worktree_path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return !actual.error && actual.text.trim() === session.branch
    && await isSafeToRemove(project.path, session.worktree_path, session.branch);
}

async function stoppedSession(id, mode) {
  const s = store.getSession(id);
  if (!s) fail('Session no longer exists', 'session-not-found', 404);
  const eligibility = cleanupEligibility(s);
  if (!eligibility.cleanable || (mode === 'delete' && !eligibility.deletable)) fail(eligibility.reason || 'Only operator-killed sessions can be deleted');
  const lifecycle = await import('./sessions.js');
  if (lifecycle.sessionBusyForCleanup(id)) fail('Session is launching or resuming');
  if (store.db.prepare("SELECT 1 FROM sessions WHERE parent_session_id=? AND status!='exited' LIMIT 1").get(id)) fail('Session has live child sessions');
  // No process termination is part of cleanup. A stale DB row must not authorize deleting live files.
  const pane = await exec(TMUX, ['has-session', '-t', s.tmux], { timeout: 5000, encoding: 'utf8' })
    .then(() => 'live', error => error.code === 1 && /can't find session|no server running|No such file or directory/i.test(String(error.stderr || '')) ? 'absent' : 'unknown');
  if (pane !== 'absent') fail(pane === 'live' ? 'A tmux session still exists; stop it before cleanup' : 'Cannot verify tmux state');
  return s;
}

async function checkedTarget(component, session, projects) {
  const proxy = resolve(join(homedir(), 'proxy'));
  const target = resolve(component.path), base = resolve(component.base);
  if (target === base || !isInside(target, base) || isInside(target, proxy)) fail('Target is outside its managed storage boundary');
  let info;
  try { info = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink()) fail('Symlink cleanup targets are refused');
  const canonicalBase = await realpath(base), canonical = await realpath(target);
  const canonicalProxy = await realpath(proxy).catch(() => proxy);
  const suffix = target.slice(base.length);
  if (canonical !== canonicalBase + suffix || isInside(canonical, proxy) || isInside(canonical, canonicalProxy)) fail('A parent symlink changed the cleanup target or resolves into the protected proxy fleet');
  for (const p of projects) {
    const projectPath = await realpath(p.path).catch(() => resolve(p.path));
    if (isInside(projectPath, canonical)) fail('Target contains a registered project');
  }
  const servicePath = await realpath(ROOT);
  if (isInside(servicePath, canonical)) fail('Target contains the running service');
  const others = store.listSessions().filter(s => s.id !== session.id);
  for (const other of others) if (other.worktree_path) {
    const path = await realpath(other.worktree_path).catch(() => resolve(other.worktree_path));
    if (isInside(path, canonical) || isInside(canonical, path)) fail('Target is shared with another session');
  }
  return { ...component, path: target, fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` };
}

export async function planStorageCleanup(ids, mode = 'disposable') {
  if (!MODES.has(mode) || !Array.isArray(ids) || ids.length < 1 || ids.length > 100
      || ids.some(id => typeof id !== 'string' || !/^s_[a-zA-Z0-9_-]+$/.test(id))) fail('Select 1–100 valid sessions and a cleanup mode', 'bad-cleanup-request', 400);
  const rows = [], projects = store.listProjects();
  for (const id of new Set(ids)) {
    const s = await stoppedSession(id, mode), project = store.getProject(s.project_id);
    const targets = [], retained = [];
    for (const c of storageComponents(s, project)) {
      if (c.retained || (mode === 'disposable' && !disposable.has(c.kind))) continue;
      if (c.kind === 'worktree') {
        if (!await lstat(c.path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) continue;
        if (!project || isInside(resolve(project.path), resolve(join(homedir(), 'proxy')))
            || !await safeOwnedWorktree(s, project)) {
          if (mode === 'delete') fail('Worktree has uncommitted/unmerged work; clean disposable files instead');
          retained.push('Worktree: uncommitted/unmerged work'); continue;
        }
      }
      const target = await checkedTarget(c, s, projects);
      if (target) targets.push({ ...target, bytes: (await measureStoragePath(target.path)).bytes });
    }
    rows.push({ id, title: s.title || id, project: project?.name || '(unregistered)', identity: identity(s), targets, retained });
  }
  for (const [id, plan] of plans) if (plan.expires_at < Date.now()) plans.delete(id);
  const allocation = new Map(exclusiveStorageRows(rows.flatMap(row => row.targets)).map(t => [t.path, t.exclusive_bytes]));
  for (const row of rows) for (const target of row.targets) target.bytes = allocation.get(target.path);
  if (plans.size >= 32) plans.delete(plans.keys().next().value);
  const plan = { id: randomUUID(), mode, created_at: Date.now(), expires_at: Date.now() + 10 * 60_000, sessions: rows,
    estimated_bytes: rows.reduce((n, row) => n + row.targets.reduce((n, t) => n + t.bytes, 0), 0),
    irreversible: true, preserved: ['Project source folders', 'Native CLI histories', ...(mode === 'disposable' ? ['Saved outputs', 'Uploads', 'Review screenshots', 'AIOS conversation records'] : mode === 'outputs' ? ['AIOS conversation records'] : [])] };
  plans.set(plan.id, plan);
  return plan;
}

function deleteSessionRecords(id) {
  // Project tasks, evidence, decisions, usage totals and integration audit remain historical records.
  // Deletion makes SQLite pages reusable; no live VACUUM (which needs extra space and stalls writers).
  const tables = ['messages', 'events', 'attention_dismissals', 'agent_grants', 'session_space',
    'session_maps', 'session_labels', 'session_usage_limits', 'preflight_specs', 'supervisor_reviews', 'supervisor_snapshots', 'voice_scripts'];
  const existing = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of tables) if (existing.has(table)
      && store.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'session_id')) {
      store.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
    }
    store.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

async function executeCleanupOnce(planId, confirmed) {
  const plan = plans.get(planId);
  if (!confirmed || !plan || plan.expires_at < Date.now()) fail('Preview cleanup again and explicitly confirm', 'cleanup-confirmation-required', 400);
  plans.delete(planId); // single-use; retries cannot reuse authority to delete newer files
  const results = [];
  for (const row of plan.sessions) {
    const removedPaths = []; let removedBytes = 0;
    try {
      results.push(await withSessionCleanup(row.id, async () => {
        const s = await stoppedSession(row.id, plan.mode);
        if (identity(s) !== row.identity) fail('Session changed since the preview; preview again');
        const targets = [];
        for (const t of row.targets) {
          const current = await checkedTarget(t, s, store.listProjects());
          if (current && current.fingerprint !== t.fingerprint) fail('Cleanup files changed since the preview; preview again');
          if (current) targets.push(current);
        }
        const worktree = targets.find(t => t.kind === 'worktree');
        if (worktree && !await safeOwnedWorktree(s, store.getProject(s.project_id))) fail('Worktree now has uncommitted/unmerged work or a changed branch');
        // Preflight ALL paths before deleting the first; the worktree is removed by git, never force.
        let bytes = 0;
        for (const t of targets) {
          if (t.kind === 'worktree') {
            const result = await removeWorktree({ repoPath: store.getProject(s.project_id).path, path: t.path, branch: s.branch });
            if (!result.removed || await lstat(t.path).then(() => true, () => false)) fail('Git did not remove the worktree');
          } else await rm(t.path, { recursive: true, force: false, maxRetries: 2 });
          bytes += row.targets.find(old => old.path === t.path).bytes;
          removedBytes = bytes; removedPaths.push(t.path);
        }
        if (plan.mode === 'delete') deleteSessionRecords(s.id);
        else store.addEvent(s.id, 'storage-cleanup', { mode: plan.mode, kinds: targets.map(t => t.kind), estimated_bytes: bytes });
        return { id: row.id, ok: true, deleted: plan.mode === 'delete', estimated_bytes: bytes, removed_paths: removedPaths, retained: row.retained };
      }));
    } catch (error) { results.push({ id: row.id, ok: false, code: error.code || 'cleanup-failed', error: String(error.message || error),
      removed_paths: removedPaths, estimated_bytes: removedBytes, partial: removedPaths.length > 0 }); }
  }
  storageInventory.invalidate();
  bus.emit('changed');
  return { ok: results.every(r => r.ok), results, estimated_bytes: results.reduce((n, r) => n + (r.estimated_bytes || 0), 0),
    note: 'Files removed cannot be recovered by AIOS. SQLite pages are reusable; database file size is not automatically compacted.' };
}

// A lost response or duplicate click replays the same receipt; it never applies old authority to
// newly created files. Bounded in-memory receipts, no automatic retry with a fresh plan.
export async function executeStorageCleanup(planId, confirmed = false) {
  if (!confirmed) fail('Explicit confirmation is required', 'cleanup-confirmation-required', 400);
  for (const [id, r] of receipts) if (r.expires_at < Date.now()) receipts.delete(id);
  if (receipts.has(planId)) return receipts.get(planId).result;
  if (flights.has(planId)) return flights.get(planId);
  const operation = executeCleanupOnce(planId, confirmed).then(result => {
    if (receipts.size >= 32) receipts.delete(receipts.keys().next().value);
    receipts.set(planId, { expires_at: Date.now() + 15 * 60_000, result }); return result;
  }).finally(() => flights.delete(planId));
  flights.set(planId, operation);
  return operation;
}
