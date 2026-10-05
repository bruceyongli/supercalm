import { attentionUnreadCount, dismissAttention } from './attention_store.js';
import { bus } from './bus.js';

// One durable dismissal contract for Needs You and Voice Assistant. Bound to the report at click
// time; a newer report remains unread. Never stop a session or send anything to its coding agent.
export function dismissAttentionReport(sessionId, throughId, ts = Date.now()) {
  const before = attentionUnreadCount(sessionId);
  const dismissal = dismissAttention(sessionId, throughId, ts);
  if (!dismissal) throw Object.assign(new Error('attention report not found'), { status: 404 });
  const unread = attentionUnreadCount(sessionId);
  const marked = Math.max(0, before - unread);
  bus.emit('session-status', {
    session: sessionId, unread, dismissed: !!dismissal.dismissed,
    dismissed_at: dismissal.dismissed ? dismissal.dismissed_at : null,
    dismissed_report_id: dismissal.dismissed ? dismissal.report_id : null,
    dismissed_report_text: dismissal.dismissed ? dismissal.report_text : null,
    source: 'dismiss', ts,
  });
  bus.emit('changed');
  return { ok: true, marked, dismissal, unread };
}
