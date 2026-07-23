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
  // Previously this reset lastChange for every waiting session at boot, briefly classified it as
  // working, then generated a second "new" report when the idle timer elapsed.
  const realActivity = changed && !(first && persistedStatus === 'waiting');
  if (realActivity) entry.lastChange = at;
  return realActivity;
}
