// Send-authority MODE — the supervisor's per-session permission ladder for pushing text into the
// operator's live session: observe (draft everything, send nothing) → copilot (send only what it is
// demonstrably sure of) → autopilot (full send authority; irreversible calls still escalate upstream).
//
// This is a DIFFERENT axis from the operator STANCE (stance.js): stance is what the operator asked the
// supervisor to pursue (finish everything / hold / answer only); mode is what the supervisor is allowed
// to deliver on its own. A copilot-mode supervisor under an autopilot stance still DRAFTS its keep-going
// nudges — the mode outranks the stance on delivery. Reason strings here are mode-prefixed so decision
// logs stay distinguishable from the stance vocabulary ('stance.autopilot_*', 'operator-hold').
//
// PURE module: no db/model/store imports, so the policy matrix is unit-testable (supervisor_send_policy
// test) and the live wrapper in supervisor.js stays thin. Legacy configs carry only `observe_only`;
// modeOf() resolves them (observe_only:true → observe, else autopilot — the pre-mode behavior), and
// `mode` must NEVER be defaulted at the meta level or every legacy autopilot grant silently downgrades.

export const MODES = ['observe', 'copilot', 'autopilot'];
export const DEFAULT_COPILOT_CONFIDENCE = 0.8;

export function modeOf(cfg = {}) {
  if (MODES.includes(cfg.mode)) return cfg.mode;
  return cfg.observe_only ? 'observe' : 'autopilot';
}

export function copilotThreshold(cfg = {}) {
  const n = Number(cfg.copilot_confidence);
  if (!Number.isFinite(n)) return DEFAULT_COPILOT_CONFIDENCE;
  return Math.min(1, Math.max(0, n));
}

// Message KINDS (classified per call site / ruleId, not per actionType — a checkpoint push is an
// actionType 'challenge' but must not ride the evidence-challenge lane):
//   answer    — a reply to the agent's question. copilot: confidence-gated, fail-closed.
//   challenge — a completion-gate evidence demand ("prove it") incl. verify.corrective_gap. Safe: it
//               never changes direction, only asks for proof — copilot sends these.
//   nudge     — unstick / keep-working / checkpoint / doctrine-advance pushes. copilot drafts them.
//   recover   — state-changing rescues (proxy-auth redirect, api-retry, /clear, /compact, resume).
//               copilot drafts them; callers must escalate/notify once when blocked, never loop silently.
//   operator  — operator-initiated relay (e.g. the Resolve box "also send"). ALWAYS allowed; the mode
//               gates the SUPERVISOR's autonomy, not the operator's own words.
export const SEND_KINDS = ['answer', 'challenge', 'nudge', 'recover', 'operator'];

// The pure policy: (mode, kind, meta) -> { allowed, reason }. `reason` is '' when allowed.
// Fail-closed: in copilot an answer with a missing/unparseable confidence or an unconfirmed
// reserved flag does NOT send — a model that failed to calibrate is not "confident".
export function sendPolicy(mode, kind, { confidence, reserved, threshold = DEFAULT_COPILOT_CONFIDENCE } = {}) {
  if (kind === 'operator') return { allowed: true, reason: '' };
  if (!MODES.includes(mode)) mode = 'autopilot';
  if (mode === 'observe') return { allowed: false, reason: 'mode-observe' };
  if (mode === 'autopilot') return { allowed: true, reason: '' };
  // copilot
  if (kind === 'challenge') return { allowed: true, reason: '' };
  if (kind === 'answer') {
    const c = Number(confidence);
    if (!Number.isFinite(c)) return { allowed: false, reason: 'mode-copilot-no-confidence' };
    if (reserved !== false) return { allowed: false, reason: 'mode-copilot-reserved-unconfirmed' };
    if (c < threshold) return { allowed: false, reason: 'mode-copilot-confidence' };
    return { allowed: true, reason: '' };
  }
  return { allowed: false, reason: `mode-copilot-holds-${kind}` }; // nudge / recover
}

// Human-readable line for the panel's suppression display.
export function modeLabel(mode) {
  return mode === 'observe' ? 'Observe' : mode === 'copilot' ? 'Co-pilot' : 'Autopilot';
}
