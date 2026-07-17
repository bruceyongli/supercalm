// PARKED lifecycle (v4 Phase 2, traceability A3): the 10-session review found identical screens
// repeated ×76–×295 for DAYS — dead panes polluting the needs-you queue and stats while nobody
// closed them out. A session whose STABILIZED snapshot (detect's stableSnap hash) hasn't moved for
// the park threshold is PARKED: flagged in state (UIs demote it), one notification, no further
// attention pressure. Any pane change or operator reply un-parks instantly — parking is attention
// bookkeeping, never a kill. Pure policy module; the sessions poll loop wires it.
export const PARK_AFTER_MS = Number(process.env.AIOS_PARK_AFTER_MS || 6 * 60 * 60_000); // 6h of byte-stillness

export function parkVerdict({ status, parked, idleMs }, { parkAfterMs = PARK_AFTER_MS } = {}) {
  if (status === 'exited' || status === 'starting') return { park: false, unpark: !!parked };
  if (parked) return { park: false, unpark: idleMs < parkAfterMs }; // any movement resets idle → wake
  return { park: idleMs >= parkAfterMs, unpark: false };
}
