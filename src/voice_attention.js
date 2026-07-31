// Pure voice-attention rules. The spoken concierge must use the same product definition as the
// Needs You UI; "status = waiting" alone is broader and includes read or explicitly dismissed work.
export function isNeedsYouSession(session, { unread = 0, dismissed = false } = {}) {
  return !!session
    && !dismissed
    && session.status === 'waiting'
    && Number(unread) > 0
    && !!session.category
    && session.category !== 'working';
}

const ACK_ONLY = /^(?:(?:yes|yeah|yep|no|nope|ok(?:ay)?|sure|continue|go ahead|send it|do it|next|skip|moving on|move on|thanks?|thank you)[\s,.!]*)+$/i;

export function latestAttentionReportFrom(messages) {
  return (messages || []).filter((message) => message?.direction === 'out' && String(message.text || '').trim()).at(-1) || null;
}

export function originalRequestFrom(messages, fallback = '', { reportId = null } = {}) {
  const rows = messages || [];
  const boundary = Number(reportId) || Number(latestAttentionReportFrom(rows)?.id) || Infinity;
  const inbound = rows.filter((message) => message?.direction === 'in'
    && String(message.text || '').trim()
    && (!Number.isFinite(Number(message.id)) || Number(message.id) < boundary));
  // A long-running session is a sequence of requests. The current attention report belongs to the
  // latest substantive operator turn before it—not to the first task that named the session months ago.
  const substantive = [...inbound].reverse().find((message) => !ACK_ONLY.test(String(message.text || '').trim()));
  return String(substantive?.text || inbound.at(-1)?.text || fallback || '').trim();
}

export function isStaleSessionTitleEcho(text, title) {
  const report = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const sessionTitle = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (report.length < 24 || sessionTitle.length < 24) return false;
  return sessionTitle.startsWith(report) || report.startsWith(sessionTitle);
}

export function latestReliableReport(messages, session = {}) {
  const latest = latestAttentionReportFrom(messages);
  const candidates = [session.question, session.summary, latest?.text]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (!isStaleSessionTitleEcho(candidate, session.title)) return candidate;
  }
  return candidates.length
    ? 'The latest status detector repeated the older session title, so it did not provide a reliable new outcome.'
    : '';
}

export function asksForSessionOverview(text) {
  const value = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!value) return false;
  return /\b(all|each|every|other|new)\b.{0,45}\b(sessions?|agents?)\b/.test(value)
    || /\b(sessions?|agents?)\b.{0,45}\b(status|working|stopped|blocked|inactive|failed|new)\b/.test(value)
    || /\b(status|what(?:'s| is) going on)\b.{0,45}\b(sessions?|agents?)\b/.test(value);
}
