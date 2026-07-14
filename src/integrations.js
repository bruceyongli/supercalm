// Autonomous integrate-&-deploy — the DURABLE STATE MACHINE (docs/specs/autonomous-deploy-plan.md step 2).
// Each integration walks a persisted stage graph; every transition is ONE SQLite transaction plus an
// immutable event row, so the machine survives the self-deploy restart and is idempotent-resumable. This
// module is JUST the backbone: enqueue, fenced transitions, the single-active + FIFO invariants, and
// boot-time recovery. It does NOT run the actual integrate flow (rebase/test/merge/deploy) — that later
// module drives the machine through these stages.
//
// Safety invariants encoded here:
//  - FENCING: a worker must present the row's current fence_token to transition; a stale worker (its token
//    was bumped by a boot recovery) can never write. Fencing — not a lost in-memory/flock lock — defines
//    ownership across a restart.
//  - SINGLE ACTIVE: at most one integration is in an ACTIVE stage (claimed, past QUEUED, not terminal/held)
//    at a time. A HELD integration also blocks the queue (system paused pending a human).
//  - LEGAL TRANSITIONS ONLY: the NEXT map is the whole graph; an illegal jump is rejected, never applied.
import { db } from './store.js';
import { id as genId, now } from './util.js';
import { BOOT_ID } from './config.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    project_id TEXT, session_id TEXT,
    source_branch TEXT, source_sha TEXT, base_sha TEXT, candidate_sha TEXT, previous_green_sha TEXT,
    stage TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
    fence_token INTEGER NOT NULL DEFAULT 1, owner_boot_id TEXT, heartbeat_at INTEGER,
    checks_digest TEXT, deploy_started_at INTEGER, health_deadline INTEGER,
    rollback_sha TEXT, failure_code TEXT, failure_detail TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_id TEXT NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL, data TEXT, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_intev ON integration_events(integration_id, at);
  CREATE TABLE IF NOT EXISTS health_probes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    integration_id TEXT NOT NULL, boot_id TEXT, served_sha TEXT, status TEXT, detail TEXT, at INTEGER NOT NULL
  );
`);

export const STAGES = [
  'QUEUED', 'PREPARING', 'CHECKING', 'APPROVED', 'PUBLISHING', 'MAIN_PUBLISHED', 'RESTART_REQUESTED',
  'VERIFYING', 'GREEN', 'REJECTED', 'ROLLING_BACK', 'ROLLBACK_PUBLISHED', 'ROLLBACK_RESTART_REQUESTED',
  'ROLLBACK_VERIFYING', 'ROLLED_BACK', 'HELD',
];
// Fully done — the queue is free again.
export const TERMINAL = new Set(['GREEN', 'REJECTED', 'ROLLED_BACK']);
// The whole legal transition graph. An `from` not listed (a terminal) allows nothing.
const NEXT = {
  QUEUED: ['PREPARING', 'REJECTED', 'HELD'],
  PREPARING: ['CHECKING', 'REJECTED', 'HELD'],
  CHECKING: ['APPROVED', 'REJECTED', 'HELD'],
  APPROVED: ['PUBLISHING', 'REJECTED', 'HELD'],
  PUBLISHING: ['MAIN_PUBLISHED', 'ROLLING_BACK', 'HELD'], // after publish there is no clean REJECT — roll back
  MAIN_PUBLISHED: ['RESTART_REQUESTED', 'ROLLING_BACK', 'HELD'],
  RESTART_REQUESTED: ['VERIFYING', 'ROLLING_BACK', 'HELD'],
  VERIFYING: ['GREEN', 'ROLLING_BACK', 'HELD'],
  ROLLING_BACK: ['ROLLBACK_PUBLISHED', 'HELD'],
  ROLLBACK_PUBLISHED: ['ROLLBACK_RESTART_REQUESTED', 'HELD'],
  ROLLBACK_RESTART_REQUESTED: ['ROLLBACK_VERIFYING', 'HELD'],
  ROLLBACK_VERIFYING: ['ROLLED_BACK', 'HELD'],
  HELD: ['QUEUED', 'REJECTED', 'ROLLED_BACK'], // an operator resolves a hold: requeue, abandon, or accept a rollback
  GREEN: [], REJECTED: [], ROLLED_BACK: [],
};
// A stage where a worker "owns" the pipeline (claimed, past QUEUED, not terminal, not parked). Used for the
// single-active invariant. HELD is not active but still blocks the queue.
const isActive = (stage) => !TERMINAL.has(stage) && stage !== 'QUEUED' && stage !== 'HELD';
// Anything that occupies the pipeline: an active worker OR a parked hold. New work must wait for these.
export function occupiedBy() {
  return db.prepare(`SELECT * FROM integrations WHERE stage NOT IN ('QUEUED','GREEN','REJECTED','ROLLED_BACK') ORDER BY created_at LIMIT 1`).get() || null;
}

const _get = db.prepare('SELECT * FROM integrations WHERE id = ?');
export const getIntegration = (id) => _get.get(id) || null;
export const listIntegrations = (limit = 50) => db.prepare('SELECT * FROM integrations ORDER BY created_at DESC LIMIT ?').all(limit);
export const eventsFor = (id) => db.prepare('SELECT * FROM integration_events WHERE integration_id = ? ORDER BY at, id').all(id);

function record(intId, from, to, data) {
  db.prepare('INSERT INTO integration_events (integration_id, from_stage, to_stage, data, at) VALUES (?,?,?,?,?)')
    .run(intId, from || null, to, data ? JSON.stringify(data) : null, now());
}

// Enqueue a candidate. It waits in QUEUED (FIFO); a worker dequeues it via claimNext(). Returns the row.
export function enqueue({ projectId = null, sessionId = null, sourceBranch = null, sourceSha = null, baseSha = null, candidateSha = null } = {}) {
  const t = now();
  const row = { id: genId('int'), project_id: projectId, session_id: sessionId, source_branch: sourceBranch, source_sha: sourceSha, base_sha: baseSha, candidate_sha: candidateSha, stage: 'QUEUED', attempt: 0, fence_token: 1, created_at: t, updated_at: t };
  db.prepare(`INSERT INTO integrations (id, project_id, session_id, source_branch, source_sha, base_sha, candidate_sha, stage, attempt, fence_token, created_at, updated_at)
    VALUES (@id,@project_id,@session_id,@source_branch,@source_sha,@base_sha,@candidate_sha,@stage,@attempt,@fence_token,@created_at,@updated_at)`).run(row);
  record(row.id, null, 'QUEUED', { enqueued: true });
  return getIntegration(row.id);
}

// The oldest QUEUED candidate (FIFO), or null.
export const nextQueued = () => db.prepare(`SELECT * FROM integrations WHERE stage='QUEUED' ORDER BY created_at LIMIT 1`).get() || null;

// Transition a row to `to`, atomically, IFF (a) it exists, (b) the caller holds the current fence_token,
// (c) `to` is a legal next stage, and (d) entering an ACTIVE stage doesn't violate single-active. Returns
// the updated row. Throws (never partially applies) on any violation — the caller treats a throw as "lost".
export function transition(intId, to, { fenceToken, data = null, patch = {} } = {}) {
  const cur = getIntegration(intId);
  if (!cur) throw new Error('no such integration: ' + intId);
  if (fenceToken != null && fenceToken !== cur.fence_token) throw new Error(`fenced out: token ${fenceToken} != current ${cur.fence_token}`);
  if (!STAGES.includes(to)) throw new Error('unknown stage: ' + to);
  if (!(NEXT[cur.stage] || []).includes(to)) throw new Error(`illegal transition ${cur.stage} -> ${to}`);
  if (isActive(to)) {
    const other = db.prepare(`SELECT id FROM integrations WHERE id != ? AND stage NOT IN ('QUEUED','GREEN','REJECTED','ROLLED_BACK')`).get(intId);
    if (other) throw new Error('single-active violated: ' + other.id + ' occupies the pipeline');
  }
  const cols = ['stage = ?', 'updated_at = ?'];
  const vals = [to, now()];
  const ALLOWED = new Set(['attempt', 'owner_boot_id', 'heartbeat_at', 'checks_digest', 'deploy_started_at', 'health_deadline', 'rollback_sha', 'failure_code', 'failure_detail', 'candidate_sha', 'base_sha', 'previous_green_sha', 'source_sha']);
  for (const [k, v] of Object.entries(patch)) if (ALLOWED.has(k)) { cols.push(`${k} = ?`); vals.push(v); }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE integrations SET ${cols.join(', ')} WHERE id = ? AND fence_token = ?`).run(...vals, intId, cur.fence_token);
    record(intId, cur.stage, to, data);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return getIntegration(intId);
}

// Heartbeat from the active worker (proves liveness; used to distinguish a live pipeline from a crashed one).
export function heartbeat(intId, fenceToken) {
  const r = db.prepare('UPDATE integrations SET heartbeat_at = ? WHERE id = ? AND fence_token = ?').run(now(), intId, fenceToken);
  return r.changes > 0;
}

export function recordProbe(intId, { bootId = null, servedSha = null, status = null, detail = null } = {}) {
  db.prepare('INSERT INTO health_probes (integration_id, boot_id, served_sha, status, detail, at) VALUES (?,?,?,?,?,?)').run(intId, bootId, servedSha, status, detail, now());
}

// BOOT RECOVERY. The old process died on the self-deploy restart, so its in-memory lock + fence ownership
// are gone. On boot, before accepting deploy work: find the single pipeline-occupying integration (active or
// held), BUMP its fence_token (orphaning any stale worker), stamp this boot as the owner, and return it for
// the caller to RECONCILE (compare the served SHA to candidate_sha → resume / verify / HELD on ambiguity).
// Returns { integration, bumped } or { integration: null }. Reconciliation lives with the flow (later step).
export function recoverOnBoot(bootId) {
  const occ = occupiedBy();
  if (!occ) return { integration: null };
  const newToken = (occ.fence_token || 0) + 1;
  db.prepare('UPDATE integrations SET fence_token = ?, owner_boot_id = ?, updated_at = ? WHERE id = ?').run(newToken, bootId, now(), occ.id);
  record(occ.id, occ.stage, occ.stage, { bootRecovery: true, bootId, fence_token: newToken });
  return { integration: getIntegration(occ.id), bumped: newToken };
}

// Run boot recovery once when this module loads (the server restarts on every deploy). Re-asserting fence
// ownership BEFORE any worker touches a pipeline-occupying integration is what prevents a stale pre-restart
// worker from writing. Reconciliation (served-SHA vs candidate_sha → resume/verify/HELD) is the flow's job
// in a later step; here we only orphan the stale token + log, so a mid-flight integration is never silently
// lost across a restart. Fail-safe: a recovery error must never block boot.
try {
  const { integration, bumped } = recoverOnBoot(BOOT_ID);
  if (integration) console.error(`[aios] integration boot-recovery: ${integration.id} in ${integration.stage} — fence bumped to ${bumped}, owner ${BOOT_ID}; awaiting reconcile.`);
} catch (e) { console.error('[aios] integration boot-recovery skipped:', e?.message || e); }
