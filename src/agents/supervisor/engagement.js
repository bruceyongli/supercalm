// ENGAGEMENT — the attention governor's pure core. Supervision effort follows OPERATOR ENGAGEMENT:
// a session the operator touched recently earns full supervision; one they haven't touched in days
// drops to detection-only. Born from live data (2026-07-06): a month-old abandoned-but-"waiting"
// session burned ~345 verify calls/day because sibling sessions kept committing to the same repo
// (fp.work is repo-scoped) and re-arming its completion gate — while the operator answered 17% of
// asks and 824 expired unanswered in a week. The disease was unbounded supervision of work no human
// currently owns; tiering by engagement is the cure (3-model panel, unanimous — docs/improve/LEDGER.md).
//
// PURE module (no db/model/store imports): tier computation + the per-tier permission matrix live
// here so the unit matrix and replay harness exercise them without a server. supervisor.js supplies
// the timestamps (operator messages, typing, launch/resume) and consults allowedWhenTier() per
// intervention kind; sessions.js/buildState use tierOf for queue tiers + ask TTLs.

export const TIERS = ['hot', 'warm', 'stale'];

const H = 3600 * 1000;
export function tierThresholds(env = process.env) {
  // hot: the operator is actively working this session; warm: today's/yesterday's work;
  // stale: nothing from the operator in days — supervision stands down to detection-only.
  return {
    hotMs: Math.max(10 * 60 * 1000, Number(env.AIOS_ENGAGEMENT_HOT_HOURS || 6) * H),
    warmMs: Math.max(H, Number(env.AIOS_ENGAGEMENT_WARM_HOURS || 48) * H),
  };
}

// lastTouch = the newest OPERATOR act on the session: message sent (text/voice), typing heartbeat,
// launch or resume (starting a session IS engagement). Agent activity does NOT count — that's the
// whole point (the burner was "active" for a month with zero human touches).
export function tierOf({ lastTouch = 0, now = Date.now(), thresholds = tierThresholds() } = {}) {
  const age = now - Number(lastTouch || 0);
  if (age <= thresholds.hotMs) return 'hot';
  if (age <= thresholds.warmMs) return 'warm';
  return 'stale';
}

// What the supervisor may DO per tier. Detection (status/waiting classification, summaries) is not
// listed — it always runs; this gates the ACTIVE interventions and their model calls.
//   answer     — answer/escalate the agent's question (model call)
//   verify     — completion gate: challenge + skeptical verify (model call + evidence + screenshots)
//   nudge      — keepworking / unstick / checkpoint pushes (model call for unstick)
//   recover    — api-error retries, context-wedge /clear + /compact, exit auto-resume
//   doc        — self-maintaining supervision-doc updates (model call)
//   stance/doctrine distillation — grouped under 'learn' (cheap, only fires on operator messages —
//                which themselves re-heat the session, so stale sessions never pay it anyway)
const MATRIX = {
  hot: { answer: true, verify: true, nudge: true, recover: true, doc: true, learn: true },
  // warm: still supervised, but only NEW WORK earns the expensive completion gate — callers must pass
  // `newWork` (their work-fingerprint moved since the last verified/challenged state). No idle nudging:
  // if the operator isn't around, "keep going" pressure just generates asks nobody will answer.
  warm: { answer: true, verify: 'new-work-only', nudge: false, recover: true, doc: true, learn: true },
  // stale: detection-only. The session stays visible (queue: stale tier), waiting/blocked states are
  // still detected and surfaced, but no model calls are spent and the agent is not pushed. Any
  // operator touch instantly re-heats to hot on the next tick.
  stale: { answer: false, verify: false, nudge: false, recover: false, doc: false, learn: true },
};

export function allowedWhenTier(tier, kind, { newWork = false } = {}) {
  const row = MATRIX[tier] || MATRIX.hot;
  const v = row[kind];
  if (v === 'new-work-only') return !!newWork;
  return !!v;
}

// Reason string for decision records / suppression logs (distinct from mode- and stance- vocab).
export function tierReason(tier, kind) {
  return `tier-${tier}-holds-${kind}`;
}

// Ask garbage-collection: a pending ask older than the TTL is EXPIRED (archived out of the queue),
// not left to rot as false workload (64 leaked rows, oldest 33 days, before this existed).
export function askExpired({ askedAt = 0, now = Date.now(), ttlMs = askTtlMs() } = {}) {
  return now - Number(askedAt || 0) > ttlMs;
}
export function askTtlMs(env = process.env) {
  return Math.max(H, Number(env.AIOS_ASK_TTL_HOURS || 48) * H);
}

// Queue tiering for the dashboard: blocking (reserved/irreversible or explicit action asks on
// engaged sessions) > fresh (hot/warm waiting) > stale (collapsed group). Pure so buildState and
// tests share it.
export function queueTier({ tier, category }) {
  if (tier !== 'stale' && category === 'action') return 'blocking';
  if (tier === 'stale') return 'stale';
  return 'fresh';
}
export const QUEUE_TIER_ORDER = { blocking: 0, fresh: 1, stale: 2 };
