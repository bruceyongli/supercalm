// Deploy circuit breaker (autonomous-deploy plan §6). After repeated post-publish failures/rollbacks — or
// repo-level deploy thrash (thrash.js) — within a window, OPEN a persisted PER-PROJECT breaker → new
// integrations are REJECTED until an operator clears it. This is what stops a deploy→rollback→redeploy loop
// (the fix-relay incident). Evaluated lazily at the orchestrator's guard point (before starting work), so a
// tripped breaker blocks the NEXT integration; it never auto-closes — a human must clear it.
import { db } from './store.js';
import { now } from './util.js';

db.exec(`CREATE TABLE IF NOT EXISTS deploy_breaker (
  project_id TEXT PRIMARY KEY,
  open       INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  opened_at  INTEGER,
  cleared_at INTEGER,
  trip_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
)`);

const WINDOW_MS = Number(process.env.AIOS_BREAKER_WINDOW_MS || 3600000); // 1h
const FAIL_THRESHOLD = Number(process.env.AIOS_BREAKER_FAILS || 3);

const _get = db.prepare('SELECT * FROM deploy_breaker WHERE project_id = ?');
export function breakerState(projectId) {
  return _get.get(projectId) || { project_id: projectId, open: 0, reason: null, opened_at: null, cleared_at: null, trip_count: 0 };
}

// Post-publish failures (HELD / ROLLED_BACK) for this project since the later of (window start, last clear).
// A gate REJECTED is NOT counted — it never reached prod; only failures that touched the live service thrash.
export function recentFailures(projectId, windowMs = WINDOW_MS) {
  const since = Math.max(now() - windowMs, breakerState(projectId).cleared_at || 0);
  return db.prepare(`SELECT COUNT(*) n FROM integrations WHERE project_id = ? AND stage IN ('HELD','ROLLED_BACK') AND updated_at > ?`).get(projectId, since).n;
}

export function tripBreaker(projectId, reason) {
  const s = breakerState(projectId);
  db.prepare(`INSERT INTO deploy_breaker (project_id, open, reason, opened_at, cleared_at, trip_count, updated_at)
    VALUES (?,1,?,?,?,1,?)
    ON CONFLICT(project_id) DO UPDATE SET open=1, reason=excluded.reason, opened_at=excluded.opened_at,
      trip_count=deploy_breaker.trip_count+1, updated_at=excluded.updated_at`)
    .run(projectId, reason, now(), s.cleared_at || null, now());
  return breakerState(projectId);
}

export function clearBreaker(projectId) {
  db.prepare(`INSERT INTO deploy_breaker (project_id, open, reason, opened_at, cleared_at, trip_count, updated_at)
    VALUES (?,0,NULL,NULL,?,0,?)
    ON CONFLICT(project_id) DO UPDATE SET open=0, reason=NULL, opened_at=NULL, cleared_at=excluded.cleared_at, updated_at=excluded.updated_at`)
    .run(projectId, now(), now());
  return breakerState(projectId);
}

// Evaluate the trip condition; opens the breaker if tripped (idempotent — an already-open breaker stays open
// until manually cleared). Returns the current state. The trip signal is DIRECT: post-publish failures/
// rollbacks for THIS project in the window (a deploy→rollback→redeploy loop). We deliberately do NOT trip on
// a commit-stream heuristic — a healthy release cadence (package.json bumped every deploy, a commit that just
// mentions "revert") looks identical to thrash and would falsely block autonomous deploys forever.
export async function evaluate(projectId, repoPath) { // eslint-disable-line no-unused-vars
  if (!projectId) return { project_id: projectId, open: 0 };
  const s = breakerState(projectId);
  if (s.open) return s;
  const fails = recentFailures(projectId);
  if (fails >= FAIL_THRESHOLD) return tripBreaker(projectId, `${fails} post-publish failures/rollbacks in ${Math.round(WINDOW_MS / 60000)}m`);
  return breakerState(projectId);
}

// The guard the orchestrator/trigger calls before starting an integration. { blocked, reason, state }.
export async function breakerBlocks(projectId, repoPath) {
  const s = await evaluate(projectId, repoPath);
  return s.open ? { blocked: true, reason: s.reason, state: s } : { blocked: false, state: s };
}
