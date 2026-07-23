import { createHash } from 'node:crypto';
import { db } from '../../store.js';
import { applyMigrations, ensureColumn } from '../../migrations.js';
import { id, now } from '../../util.js';

const POLICY_VERSION = 'supervisor.policy.2026-06-25';
const SNAPSHOT_SCHEMA = 'supervisor.snapshot';
const DECISION_SCHEMA = 'supervisor.decision';

db.exec(`
  CREATE TABLE IF NOT EXISTS supervisor_decisions (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL,
    ts                 INTEGER NOT NULL,
    policy_version     TEXT,
    snapshot_hash      TEXT,
    rule_id            TEXT,
    action_type        TEXT,
    action_target      TEXT,
    allowed_send       INTEGER NOT NULL DEFAULT 0,
    suppression_reason TEXT,
    operator_intent    TEXT,
    triggering_signal  TEXT,
    reasons_json       TEXT,
    state_patch_json   TEXT,
    decision_json      TEXT,
    snapshot_json      TEXT,
    sent               INTEGER NOT NULL DEFAULT 0,
    sent_text          TEXT,
    send_result_json   TEXT,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_session_ts ON supervisor_decisions(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_action ON supervisor_decisions(session_id, action_type, ts);
  CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_ts ON supervisor_decisions(ts);
  CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_inline_snapshot_ts ON supervisor_decisions(ts) WHERE snapshot_json IS NOT NULL;

  CREATE TABLE IF NOT EXISTS supervisor_snapshots (
    snapshot_hash TEXT PRIMARY KEY,
    schema        TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL,
    refs          INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_supervisor_snapshots_last_used ON supervisor_snapshots(last_used_at);
`);
// Project Memory phase 2: every policy record names WHICH contract it acted against — the active
// task card id + version (null until phase 3 sets an active task). Additive, preserves history.
applyMigrations(db, [{
  id: '0103_supervisor_decision_task_identity',
  description: 'Associate supervisor decisions with versioned project-memory task cards',
  up(conn) {
    ensureColumn(conn, 'supervisor_decisions', 'task_id', 'TEXT');
    ensureColumn(conn, 'supervisor_decisions', 'card_version', 'INTEGER');
  },
}]);

const _insert = db.prepare(`
  INSERT INTO supervisor_decisions (
    id, session_id, ts, policy_version, snapshot_hash, rule_id, action_type, action_target,
    allowed_send, suppression_reason, operator_intent, triggering_signal, reasons_json,
    state_patch_json, decision_json, snapshot_json, sent, sent_text, send_result_json, created_at,
    task_id, card_version
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const _updateSend = db.prepare('UPDATE supervisor_decisions SET sent=?, sent_text=?, send_result_json=? WHERE id=?');
const DECISION_COLUMNS = `id, session_id, ts, policy_version, snapshot_hash, rule_id, action_type,
  action_target, allowed_send, suppression_reason, operator_intent, triggering_signal, reasons_json,
  state_patch_json, decision_json, sent, sent_text, send_result_json, created_at, task_id, card_version`;
const _latest = db.prepare(`SELECT ${DECISION_COLUMNS} FROM supervisor_decisions WHERE session_id=? ORDER BY ts DESC LIMIT 1`);
const _history = db.prepare(`SELECT ${DECISION_COLUMNS} FROM supervisor_decisions WHERE session_id=? ORDER BY ts DESC LIMIT ?`);
const _putSnapshot = db.prepare(`
  INSERT INTO supervisor_snapshots (snapshot_hash, schema, snapshot_json, created_at, last_used_at, refs)
  VALUES (?,?,?,?,?,1)
  ON CONFLICT(snapshot_hash) DO UPDATE SET last_used_at=excluded.last_used_at, refs=supervisor_snapshots.refs+1
`);
const _getSnapshot = db.prepare('SELECT snapshot_json FROM supervisor_snapshots WHERE snapshot_hash=?');
const _legacySnapshots = db.prepare(`SELECT id, ts, snapshot_hash, snapshot_json
  FROM supervisor_decisions WHERE snapshot_json IS NOT NULL
  ORDER BY ts DESC LIMIT ? OFFSET ?`);
const _finishLegacySnapshot = db.prepare('UPDATE supervisor_decisions SET snapshot_hash=?, snapshot_json=NULL WHERE id=? AND snapshot_json IS NOT NULL');

const SNAPSHOT_RETAIN = Math.max(100, Number(process.env.AIOS_SUPERVISOR_SNAPSHOT_RETAIN || 2000));
const DECISION_RETAIN = Math.max(1000, Number(process.env.AIOS_SUPERVISOR_DECISION_RETAIN || 250000));
const LEGACY_INLINE_RETAIN = Math.max(0, Number(process.env.AIOS_SUPERVISOR_INLINE_SNAPSHOT_RETAIN || 1000));
const MAINTENANCE_BATCH = Math.max(10, Math.min(1000, Number(process.env.AIOS_SUPERVISOR_MAINTENANCE_BATCH || 100)));

function j(v) {
  try { return JSON.stringify(v ?? null); } catch { return 'null'; }
}

function parseJ(s, d = null) {
  try { return s ? JSON.parse(s) : d; } catch { return d; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

export function snapshotHash(snapshot) {
  return createHash('sha256').update(JSON.stringify(stable(snapshot || {}))).digest('hex').slice(0, 24);
}

export function makeDecision({
  sessionId,
  snapshot,
  ruleId,
  action,
  allowedSend = false,
  suppressionReason = '',
  latestOperatorIntent = null,
  triggeringSignal = null,
  reasons = [],
  statePatch = {},
  generatedAt = now(),
} = {}) {
  const snapHash = snapshotHash(snapshot);
  return {
    schema: DECISION_SCHEMA,
    decisionId: id('sd'),
    sessionId,
    generatedAt,
    policyVersion: POLICY_VERSION,
    snapshotHash: snapHash,
    ruleId: ruleId || 'unknown',
    action: action || { type: 'none', target: 'internal', payload: {} },
    allowedSend: !!allowedSend,
    suppressionReason: suppressionReason || '',
    latestOperatorIntent: latestOperatorIntent || { type: 'none', text: '', ts: null, confidence: 0 },
    currentTask: snapshot?.currentTask || null,
    task: snapshot?.task || null, // {id, version, hash} of the active task card (Project Memory; null pre-phase-3)
    triggeringSignal: triggeringSignal || null,
    reasons: Array.isArray(reasons) ? reasons : [String(reasons || '')].filter(Boolean),
    statePatch: statePatch || {},
  };
}

export function persistDecision(ctxOrSessionId, decision, snapshot = null) {
  const sessionId = typeof ctxOrSessionId === 'string' ? ctxOrSessionId : ctxOrSessionId?.sessionId;
  if (!sessionId || !decision?.decisionId) return null;
  const action = decision.action || {};
  const snapHash = decision.snapshotHash || (snapshot ? snapshotHash(snapshot) : '');
  if (snapshot && snapHash) {
    const t = now();
    _putSnapshot.run(snapHash, SNAPSHOT_SCHEMA, j({ schema: SNAPSHOT_SCHEMA, ...snapshot }), t, t);
  }
  _insert.run(
    decision.decisionId,
    sessionId,
    decision.generatedAt || now(),
    decision.policyVersion || POLICY_VERSION,
    snapHash,
    decision.ruleId || '',
    action.type || '',
    action.target || '',
    decision.allowedSend ? 1 : 0,
    decision.suppressionReason || '',
    j(decision.latestOperatorIntent || null),
    j(decision.triggeringSignal || null),
    j(decision.reasons || []),
    j(decision.statePatch || {}),
    j(decision),
    null, // snapshots are content-addressed; never duplicate the full blob on every decision row
    0,
    '',
    null,
    now(),
    decision.task?.id ?? null,
    Number.isFinite(decision.task?.version) ? decision.task.version : null
  );
  maybeMaintainLedger();
  return decision.decisionId;
}

export function updateDecisionSend(decisionId, result = {}) {
  if (!decisionId) return;
  _updateSend.run(result.sent ? 1 : 0, String(result.sent_text || result.message || '').slice(0, 2000), j(result), decisionId);
}

export function parseDecisionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ts: row.ts,
    policyVersion: row.policy_version || '',
    snapshotHash: row.snapshot_hash || '',
    ruleId: row.rule_id || '',
    actionType: row.action_type || '',
    actionTarget: row.action_target || '',
    allowedSend: !!row.allowed_send,
    suppressionReason: row.suppression_reason || '',
    latestOperatorIntent: parseJ(row.operator_intent, null),
    triggeringSignal: parseJ(row.triggering_signal, null),
    reasons: parseJ(row.reasons_json, []),
    statePatch: parseJ(row.state_patch_json, {}),
    decision: parseJ(row.decision_json, null),
    sent: !!row.sent,
    sentText: row.sent_text || '',
    sendResult: parseJ(row.send_result_json, null),
  };
}

export function latestDecision(sessionId) {
  return parseDecisionRow(_latest.get(sessionId));
}

export function decisionHistory(sessionId, limit = 25) {
  return _history.all(sessionId, limit).map(parseDecisionRow);
}

export function decisionSnapshot(hash) {
  return parseJ(_getSnapshot.get(String(hash || ''))?.snapshot_json, null);
}

let writesSinceMaintenance = 0;
let maintaining = false;
export function maintainLedger() {
  if (maintaining) return;
  maintaining = true;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Existing installations stored evidence inline. Backfill each parseable snapshot under a hash
      // recomputed from canonical content, and clear the inline copy only after insertion succeeds.
      // Invalid legacy JSON remains untouched for manual recovery instead of being erased.
      for (const row of _legacySnapshots.all(MAINTENANCE_BATCH, LEGACY_INLINE_RETAIN)) {
        const parsed = parseJ(row.snapshot_json, null);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const snapshot = { ...parsed };
        delete snapshot.schema;
        const hash = snapshotHash(snapshot);
        const t = now();
        _putSnapshot.run(hash, SNAPSHOT_SCHEMA, j({ schema: SNAPSHOT_SCHEMA, ...snapshot }), row.ts || t, t);
        _finishLegacySnapshot.run(hash, row.id);
      }
      // Keep detailed evidence bounded; older decision metadata remains queryable.
      db.prepare(`DELETE FROM supervisor_snapshots WHERE snapshot_hash IN (
        SELECT snapshot_hash FROM supervisor_snapshots ORDER BY last_used_at DESC LIMIT ? OFFSET ?
      )`).run(MAINTENANCE_BATCH, SNAPSHOT_RETAIN);
      db.prepare(`DELETE FROM supervisor_decisions WHERE id IN (
        SELECT id FROM supervisor_decisions ORDER BY ts DESC LIMIT ? OFFSET ?
      )`).run(MAINTENANCE_BATCH, DECISION_RETAIN);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  } catch (e) {
    console.error('[aios] supervisor ledger maintenance failed:', e?.message || e);
  } finally {
    maintaining = false;
  }
}
function maybeMaintainLedger() {
  if (++writesSinceMaintenance < 100) return;
  writesSinceMaintenance = 0;
  setImmediate(maintainLedger);
}
const maintenanceTimer = setInterval(maintainLedger, 60000);
maintenanceTimer.unref?.();
setImmediate(maintainLedger);

export { POLICY_VERSION, SNAPSHOT_SCHEMA, DECISION_SCHEMA };
