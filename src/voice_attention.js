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

export function originalRequestFrom(messages, fallback = '') {
  const inbound = (messages || []).filter((message) => message?.direction === 'in' && String(message.text || '').trim());
  const task = inbound.find((message) => message.source === 'task');
  return String(task?.text || inbound[0]?.text || fallback || '').trim();
}

export function asksForSessionOverview(text) {
  const value = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!value) return false;
  return /\b(all|each|every|other|new)\b.{0,45}\b(sessions?|agents?)\b/.test(value)
    || /\b(sessions?|agents?)\b.{0,45}\b(status|working|stopped|blocked|inactive|failed|new)\b/.test(value)
    || /\b(status|what(?:'s| is) going on)\b.{0,45}\b(sessions?|agents?)\b/.test(value);
}
