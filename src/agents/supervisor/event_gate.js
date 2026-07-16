// EVENT GATE — event-driven brain invocation (v4 Phase 0, traceability row S8).
//
// The agent host ticks every ~15s, but a tick is only worth evidence-gathering and model calls when
// something actually HAPPENED. This gate turns the fixed-rate loop into event-driven invocation:
// the full onTick pass runs only when the tick SIGNATURE (pane snapshot hash + session status/
// question/category/stage + doc revision + operator stance + active card) changed, an API-error
// episode is live (its backoff timers need minute-granularity), or the heartbeat elapsed (drift
// insurance — "timeout" is itself an event type). Review corpus: 45k supervisor LLM calls /
// ~443M input tokens, most of them ticks where nothing had changed; one session burned 10,421
// calls producing zero sends that reached the pane.
//
// PURE module: (state, signature, now, opts) -> { run, reason, patch }. The caller persists `patch`
// only on run — a skipped tick writes NOTHING (state writes per skip would just move the waste).
// Emergency kill-switch: AIOS_EVENT_GATE=0 (every tick runs, pre-Phase-0 behavior). Default ON.

export const HEARTBEAT_MS = Number(process.env.AIOS_SUPERVISOR_HEARTBEAT_MS || 20 * 60_000);

export function eventGateEnabled() {
  return process.env.AIOS_EVENT_GATE !== '0';
}

// FNV-1a 32-bit -> base36 (local copy; pure module).
function h32(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Everything observable-cheaply that should wake the brain when it moves. Deliberately EXCLUDES
// last_activity (it shadows paneSig) and anything needing a subprocess or model call.
export function tickSignature({ status, question, category, stage, paneSig, docRev, stanceTs, activeTaskId } = {}) {
  return h32([
    String(status || ''),
    h32(question || ''),
    String(category || ''),
    String(stage || ''),
    String(paneSig || ''),
    String(docRev || ''),
    String(stanceTs || ''),
    String(activeTaskId || ''),
  ].join('|'));
}

// Gate decision. st carries { tickSig, tickRanAt } plus errSig from the API-error episode
// machinery (an active episode always runs — its retry schedule is minute-granular). The heartbeat
// deadline is computed at CHECK time from the caller's current heartbeatMs (never stored), so a
// mid-session config change (e.g. the operator tightening stuck_timeout_sec) takes effect on the
// very next tick instead of after the previously-armed deadline.
export function gateTick(st, sig, t, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const state = st && typeof st === 'object' ? st : {};
  const patch = { tickSig: sig, tickRanAt: t };
  if (!eventGateEnabled()) return { run: true, reason: 'gate-disabled', patch };
  if (!state.tickSig || state.tickSig !== sig) return { run: true, reason: 'signature-changed', patch };
  if (state.errSig) return { run: true, reason: 'error-episode', patch };
  if (t - (state.tickRanAt || 0) >= heartbeatMs) return { run: true, reason: 'heartbeat', patch };
  return { run: false, reason: 'no-event', patch: null };
}
