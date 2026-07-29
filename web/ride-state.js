// Pure report-episode identity for Ride mode. Kept DOM-free so deduplication can be tested without a
// browser and shared by future notification surfaces.
function contentStamp(session) {
  const text = [
    session?.category,
    session?.question,
    session?.summary,
    session?.last_key?.text,
  ].filter(Boolean).join('\n').trim();
  if (!text) return 'waiting';
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `text-${(hash >>> 0).toString(36)}`;
}

export function rideAttentionKey(session) {
  if (!session?.id) return '';
  // last_activity also changes for lifecycle heartbeats. It must never be part of this key or one
  // unchanged Needs You report can repeatedly interrupt the operator. The message/report boundary is
  // authoritative; old projections fall back to a stable hash of the human-facing report content.
  const report = session.last_key?.id || session.report_id;
  const stamp = report || contentStamp(session);
  return `${session.id}:${stamp}`;
}

export function nextRideAttention(needs, announcedKeys) {
  const seen = announcedKeys instanceof Set ? announcedKeys : new Set(announcedKeys || []);
  return (needs || []).find((session) => {
    const key = rideAttentionKey(session);
    return key && !seen.has(key);
  }) || null;
}
