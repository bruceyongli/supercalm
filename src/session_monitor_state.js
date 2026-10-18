// Monitoring begins from persisted lifecycle state. A service restart is observation, not pane
// activity: a session that was already waiting keeps its old idle clock on the first snapshot.
export function initialMonitorLastChange(session, at = Date.now()) {
  if (session?.status !== 'waiting') return at;
  const persisted = Number(session.last_activity);
  return Number.isFinite(persisted) && persisted > 0 ? Math.min(at, persisted) : at;
}

export function observeMonitorSnapshot(entry, nextHash, persistedStatus, at = Date.now()) {
  const first = entry.lastHash == null;
  const changed = nextHash !== entry.lastHash;
  entry.lastHash = nextHash;
  // The first snapshot establishes a baseline, even for a recovered working pane. It proves only
  // that a screen exists, not that new work happened while we were attaching its monitor.
  const realActivity = changed && !first;
  if (realActivity) entry.lastChange = at;
  return realActivity;
}
