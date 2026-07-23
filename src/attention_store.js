import { createHash } from 'node:crypto';
import { db, addMessage } from './store.js';

const _get = db.prepare('SELECT * FROM attention_dismissals WHERE session_id = ?');
const _list = db.prepare(`
  SELECT d.*, s.title, s.tool, s.model, s.status, s.category, s.summary, s.question,
         s.last_activity, s.started_at, s.revision, p.name AS project
  FROM attention_dismissals d
  JOIN sessions s ON s.id = d.session_id
  LEFT JOIN projects p ON p.id = s.project_id
  ORDER BY d.dismissed_at DESC
  LIMIT ?`);
const _upsert = db.prepare(`
  INSERT INTO attention_dismissals (session_id, report_id, report_hash, report_text, dismissed_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    report_id = excluded.report_id,
    report_hash = excluded.report_hash,
    report_text = excluded.report_text,
    dismissed_at = excluded.dismissed_at`);
const _delete = db.prepare('DELETE FROM attention_dismissals WHERE session_id = ?');
const _lastOut = db.prepare(`
  SELECT id, session_id, text, ts, read_at
  FROM messages
  WHERE session_id = ? AND direction = 'out'
  ORDER BY id DESC LIMIT 1`);
const _outThrough = db.prepare(`
  SELECT id, session_id, text, ts, read_at
  FROM messages
  WHERE session_id = ? AND direction = 'out' AND id <= ?
  ORDER BY id DESC LIMIT 1`);
const _lastInId = db.prepare(`
  SELECT COALESCE(MAX(id), 0) AS id
  FROM messages
  WHERE session_id = ? AND direction = 'in'`);
const _markReadThrough = db.prepare(`
  UPDATE messages SET read_at = ?
  WHERE session_id = ? AND direction = 'out' AND id <= ? AND read_at IS NULL`);
const _markReadOne = db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL');
const _restoreOne = db.prepare('UPDATE messages SET read_at = NULL WHERE id = ?');
const _session = db.prepare('SELECT status, category FROM sessions WHERE id = ?');
const _unread = db.prepare(`
  WITH last_in AS (
    SELECT COALESCE(MAX(id), 0) AS last_id
    FROM messages
    WHERE session_id = ? AND direction = 'in'
  )
  SELECT COUNT(*) AS n
  FROM messages m, last_in i
  WHERE m.session_id = ?
    AND m.direction = 'out'
    AND m.read_at IS NULL
    AND m.id > i.last_id`);

export function normalizeAttentionText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function attentionHash(text) {
  return createHash('sha256').update(normalizeAttentionText(text)).digest('hex');
}

function projectDismissal(row) {
  if (!row) return null;
  return {
    ...row,
    report_hash: row.report_hash || attentionHash(row.report_text),
    dismissed: true,
  };
}

export function getAttentionDismissal(sessionId) {
  return projectDismissal(_get.get(sessionId));
}

export function listAttentionDismissals(limit = 500) {
  return _list.all(Math.max(1, Math.min(1000, Number(limit) || 500))).map(projectDismissal);
}

// Make one explicit, durable attention decision. throughId is the exact report visible at click time,
// so a later report can never be accidentally swept into this dismissal.
export function dismissAttention(sessionId, throughId = null, dismissedAt = Date.now()) {
  const report = throughId ? _outThrough.get(sessionId, throughId) : _lastOut.get(sessionId);
  if (!report) return null;
  _markReadThrough.run(dismissedAt, sessionId, report.id);
  const latest = _lastOut.get(sessionId);
  if (latest && latest.id > report.id) {
    _delete.run(sessionId);
    return {
      session_id: sessionId,
      report_id: report.id,
      report_text: report.text || '',
      dismissed: false,
      raced: true,
    };
  }
  _upsert.run(sessionId, report.id, attentionHash(report.text), report.text || '', dismissedAt);
  return projectDismissal(_get.get(sessionId));
}

export function clearAttentionDismissal(sessionId) {
  return (_delete.run(sessionId).changes || 0) > 0;
}

// Create a report only when it is a new attention episode. An exact repeat with no operator input
// after the prior report is the same unresolved need (most importantly, a service-restart duplicate).
export function createAttentionReport(sessionId, text) {
  const normalized = normalizeAttentionText(text);
  if (!normalized) return { created: false, message: null, duplicate: true };
  const previous = _lastOut.get(sessionId);
  const lastInId = Number(_lastInId.get(sessionId)?.id) || 0;
  if (previous && attentionHash(previous.text) === attentionHash(normalized) && lastInId <= previous.id) {
    return {
      created: false,
      duplicate: true,
      message: { id: previous.id, text: previous.text, ts: previous.ts, read_at: previous.read_at },
    };
  }
  const message = addMessage(sessionId, 'out', 'detect', normalized);
  return { created: true, duplicate: false, message: { ...message, text: normalized, read_at: null } };
}

export function markAttentionReportRead(reportId, ts = Date.now()) {
  if (!Number.isSafeInteger(Number(reportId)) || Number(reportId) <= 0) return false;
  return (_markReadOne.run(ts, Number(reportId)).changes || 0) > 0;
}

export function attentionUnreadCount(sessionId) {
  return Number(_unread.get(sessionId, sessionId)?.n) || 0;
}

// Undo is intentionally bounded: only the dismissed report is restored, and only while it remains an
// unanswered, non-working need. Otherwise Restore simply removes it from the history section.
export function restoreAttention(sessionId) {
  const dismissal = _get.get(sessionId);
  if (!dismissal) return { restored: false, unread: attentionUnreadCount(sessionId) };
  const session = _session.get(sessionId);
  const lastInId = Number(_lastInId.get(sessionId)?.id) || 0;
  _delete.run(sessionId);
  const canReopen = session?.status === 'waiting'
    && session?.category !== 'working'
    && lastInId <= dismissal.report_id;
  if (canReopen) _restoreOne.run(dismissal.report_id);
  return {
    restored: true,
    reopened: canReopen,
    unread: attentionUnreadCount(sessionId),
    report_id: dismissal.report_id,
  };
}
