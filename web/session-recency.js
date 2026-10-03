// Presentation only: grouping must never dismiss, mark read, or change a session's lifecycle.
export const SESSION_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function sessionRecencyTimestamp(session) {
  const times = [session?.last_activity, session?.last_key?.ts]
    .map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (times.length) return Math.max(...times);
  const started = Number(session?.started_at);
  return Number.isFinite(started) && started > 0 ? started : 0;
}

export function splitSessionRecency(sessions, currentTime = Date.now()) {
  const recent = [], older = [];
  for (const session of sessions || []) {
    const timestamp = sessionRecencyTimestamp(session);
    (timestamp && currentTime - timestamp > SESSION_RECENCY_WINDOW_MS ? older : recent).push(session);
  }
  return { recent, older }; // retain the stable ordering in each group
}
