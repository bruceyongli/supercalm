import { createHash } from 'node:crypto';
import { db } from '../../store.js';
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
`);

const _insert = db.prepare(`
  INSERT INTO supervisor_decisions (
    id, session_id, ts, policy_version, snapshot_hash, rule_id, action_type, action_target,
    allowed_send, suppression_reason, operator_intent, triggering_signal, reasons_json,
    state_patch_json, decision_json, snapshot_json, sent, sent_text, send_result_json, created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const _updateSend = db.prepare('UPDATE supervisor_decisions SET sent=?, sent_text=?, send_result_json=? WHERE id=?');
const _latest = db.prepare('SELECT * FROM supervisor_decisions WHERE session_id=? ORDER BY ts DESC LIMIT 1');
const _history = db.prepare('SELECT * FROM supervisor_decisions WHERE session_id=? ORDER BY ts DESC LIMIT ?');

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
    triggeringSignal: triggeringSignal || null,
    reasons: Array.isArray(reasons) ? reasons : [String(reasons || '')].filter(Boolean),
    statePatch: statePatch || {},
  };
}

export function persistDecision(ctxOrSessionId, decision, snapshot = null) {
  const sessionId = typeof ctxOrSessionId === 'string' ? ctxOrSessionId : ctxOrSessionId?.sessionId;
  if (!sessionId || !decision?.decisionId) return null;
  const action = decision.action || {};
  _insert.run(
    decision.decisionId,
    sessionId,
    decision.generatedAt || now(),
    decision.policyVersion || POLICY_VERSION,
    decision.snapshotHash || (snapshot ? snapshotHash(snapshot) : ''),
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
    snapshot ? j({ schema: SNAPSHOT_SCHEMA, ...snapshot }) : null,
    0,
    '',
    null,
    now()
  );
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

export { POLICY_VERSION, SNAPSHOT_SCHEMA, DECISION_SCHEMA };
