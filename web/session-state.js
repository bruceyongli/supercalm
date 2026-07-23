function revisionOf(value) {
  const revision = Number(value?.revision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export function isStaleSessionPatch(current, patch) {
  const currentRevision = revisionOf(current);
  const patchRevision = revisionOf(patch);
  return currentRevision != null && patchRevision != null && patchRevision < currentRevision;
}

export function mergeSessionPatch(current, patch) {
  if (!current) return patch || null;
  if (!patch) return current;
  if (isStaleSessionPatch(current, patch)) return current;
  return {
    ...current,
    ...patch,
    revision: revisionOf(patch) || revisionOf(current) || undefined,
  };
}

// A home request and the session-status stream are independent transports. The stream can publish a
// newer row (or create a row absent from the response) while an older full snapshot is still in flight.
// Reconcile per-session revisions and retain only rows known to have changed after that request began.
export function mergeSessionSnapshot(currentRows, incomingRows, changedAfterRequest = new Set()) {
  const current = new Map((currentRows || []).filter((row) => row?.id).map((row) => [row.id, row]));
  const seen = new Set();
  const merged = [];
  for (const patch of incomingRows || []) {
    if (!patch?.id || seen.has(patch.id)) continue;
    seen.add(patch.id);
    const row = current.get(patch.id);
    if (row && changedAfterRequest.has(patch.id)) {
      const currentRevision = revisionOf(row);
      const patchRevision = revisionOf(patch);
      // The row changed locally after this request began. Equal revisions can still carry independent
      // metadata (for example unread state), so only a strictly newer canonical revision may replace it.
      if (currentRevision == null || patchRevision == null || patchRevision <= currentRevision) {
        merged.push(row);
        continue;
      }
    }
    merged.push(mergeSessionPatch(row, patch));
  }
  for (const [id, row] of current) {
    if (!seen.has(id) && changedAfterRequest.has(id)) merged.push(row);
  }
  return merged;
}
