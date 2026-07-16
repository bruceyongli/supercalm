// STT source resolution — a PURE function (unit-tested in test/stt_source.test.js).
//
// Turns a stored preference + an optional per-request agent hint + what's actually available into an
// ORDERED CANDIDATE LIST the transcribe route walks. The critical invariants (from the spec's external
// critique) live here, deliberately as data, not scattered control flow:
//   1. one subscription vendor NEVER falls through to the OTHER subscription vendor — only to spark/provider;
//   2. pinning `spark` (local) yields [spark] ONLY — a user who chose local never silently egresses to cloud;
//   3. `auto` with no hint is codex-first (low-latency one-shot), NEVER claude-without-a-hint;
//   4. unavailable/unbuilt sources are dropped from the list (order preserved), never errored.

export const STT_SOURCES = ['auto', 'codex', 'claude', 'spark', 'provider'];

export function normalizeSttSource(v) {
  const s = String(v || '').trim().toLowerCase();
  return STT_SOURCES.includes(s) ? s : 'auto';
}

export function normalizeAgentHint(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'codex' || s === 'claude' ? s : null; // agy / unknown / absent → no subscription hint
}

// pref: normalized stt_source. hint: normalized agent hint (or null). avail: {codex,claude,spark,provider} booleans
// (a source is "available" only when logged-in AND its path is BUILT — claude is unbuilt in pass 1, so
// callers pass avail.claude=false there regardless of login). Returns an ordered, de-duplicated list.
export function resolveSttCandidates({ pref = 'auto', hint = null, avail = {} } = {}) {
  const p = normalizeSttSource(pref);
  const h = normalizeAgentHint(hint);
  let ideal;
  if (p === 'spark') ideal = ['spark']; // local pin: never cross to cloud
  else if (p === 'provider') ideal = ['provider']; // an explicit cloud choice
  else if (p === 'codex') ideal = ['codex', 'spark', 'provider'];
  else if (p === 'claude') ideal = ['claude', 'spark', 'provider'];
  else {
    // auto: match the hinted agent; a subscription source only ever backs off to spark/provider
    if (h === 'claude') ideal = ['claude', 'spark', 'provider'];
    else ideal = ['codex', 'spark', 'provider']; // codex hint, or no hint
  }
  const seen = new Set();
  return ideal.filter((s) => avail[s] && !seen.has(s) && seen.add(s));
}
