// Voice updates are a recent-work queue, not a recap of every unresolved old session.
const DAY = 24 * 60 * 60 * 1000;
const OPERATOR = new Set(['', 'task', 'text', 'text+attachments', 'voice', 'operator', 'operator-correction', 'phone', 'phone+attachments']);
export function voiceActivityTimestamp(session, messages = null) {
  const times = messages
    ? messages.filter(row => row.direction === 'out' || (row.direction === 'in' && OPERATOR.has(row.source || ''))).map(row => Number(row.ts))
    : [session?.voice_activity_at, session?.last_key?.ts, session?.report_at].map(Number);
  const genuine = times.filter(value => Number.isFinite(value) && value > 0);
  // If there is no genuine message, session creation is the conservative fallback. last_activity is
  // only for legacy projections without a creation timestamp, never to revive an old known session.
  return genuine.length ? Math.max(...genuine) : Number(messages ? session?.started_at : session?.started_at || session?.last_activity) || 0;
}
export function isRecentVoiceSession(session, currentTime = Date.now(), messages = null) {
  if (!session || (session.status && !['starting', 'working', 'waiting'].includes(session.status))) return false;
  const ts = voiceActivityTimestamp(session, messages);
  return ts > 0 && ts >= currentTime - DAY && ts <= currentTime + 60000;
}
