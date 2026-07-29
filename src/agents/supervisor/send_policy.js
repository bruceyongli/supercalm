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

// Deterministic backstop for the self-echo incident (2026-07-09): the supervisor drafted
// "Start the pending X card as the active task… treat the Y card as done/closed" for an ops session
// that was merely DISCUSSING another session's cards — and autopilot delivered it. Card lifecycle is
// operator-reserved in EVERY mode, so a drafted ANSWER that directs card state changes is forced to
// the escalate path regardless of the model's action/confidence fields (prompts ask for this too,
// but the sharp edge gets a regex, not hope). Scope: imperative lifecycle verb near "card" /
// "task card", or the "treat … as done/closed" form. Deliberately fail-safe — a false positive
// only converts a send into an operator escalation.
// `open` is also a state adjective ("the current card remains open"). Exclude that grammatical
// shape at the token so a later real imperative in the same clause can still be found independently.
// A post-match skip would consume "open ... activate the next card" as one match and could hide the
// asserted `activate`, so keep these fixed-width lookbehinds in the scanner itself.
const CARD_LIFECYCLE_RX = /(?<!\bis )(?<!\bare )(?<!\bwas )(?<!\bwere )(?<!\bremain )(?<!\bremains )(?<!\bremained )(?<!\bstay )(?<!\bstays )(?<!\bstayed )\b(start|activate|resume|pause|close|abandon|create|open)\b[^.!?;\n]{0,60}?\b(task\s+)?cards?\b|\bcards?\b[^.!?;\n]{0,60}?\bas\s+(the\s+)?(active|done|closed|current)\b|\btreat\b[^.!?;\n]{0,80}?\bas\s+done\b/gi;
const CARD_LIFECYCLE_REFUTATION_RX = /\b(?:do(?:es)?\s+not|do(?:es)?n't|never|must\s+not|must\s+never|should\s+not|shouldn't|cannot|can't)\b[^.!?;\n]{0,40}$/i;
const COORDINATED_CARD_LIFECYCLE_REFUTATION_RX = /\b(?:do(?:es)?\s+not|do(?:es)?n't|never|must\s+not|must\s+never|should\s+not|shouldn't|cannot|can't)\b[^.!?;\n]{0,90}\b(?:start|activate|resume|pause|close|abandon|create|open)\b[^.!?;\n]{0,70}\bor\s+$/i;
const CARD_LIFECYCLE_CONTRAST_RX = /\b(?:but|however|instead)\b[^.!?;\n]{0,50}$/i;
export function cardLifecycleDirective(text) {
  const value = String(text || '');
  CARD_LIFECYCLE_RX.lastIndex = 0;
  for (const match of value.matchAll(CARD_LIFECYCLE_RX)) {
    const before = value.slice(Math.max(0, match.index - 80), match.index);
    const clauseStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
    const clausePrefix = before.slice(clauseStart + 1);
    // "Do not close the card" describes the guard; it is the opposite of a lifecycle directive.
    // Scope the exception to the same punctuation-bounded clause so a nearby, unrelated imperative
    // remains blocked. The shared dispatcher still rejects every asserted lifecycle instruction.
    // The same negation also scopes a coordinated second verb in "do not close X or activate Y";
    // contrastive "but activate Y" and a new sentence remain asserted and therefore blocked.
    if ((!CARD_LIFECYCLE_CONTRAST_RX.test(clausePrefix) && CARD_LIFECYCLE_REFUTATION_RX.test(clausePrefix))
        || COORDINATED_CARD_LIFECYCLE_REFUTATION_RX.test(clausePrefix)) continue;
    return true;
  }
  return false;
}

// Co-pilot's recovery lane is intentionally non-actuating. A weaker answer model can otherwise
// smuggle "resume the builder" through kind=answer even though sendPolicy correctly holds kind=recover.
// Match only affirmative mode-scoped actuator language; inspecting actuator availability, drafting a
// recommendation, Autopilot actuation, and explicit "must NOT invoke" clauses remain allowed.
const COPILOT_RECOVERY_ACTUATOR_RX = /(?:\b(?:co-?pilot|advisory|read-only)\b|monitoring\/supervisor modes)[^.\n]{0,100}\b(?:should|will|must|can|may|likewise)\s+(?:directly\s+)?(?:resume|relaunch|restart|invoke|use)\b|\b(?:resume|relaunch|restart|invoke|use)\b[^.\n]{0,60}\b(?:in|under)\s+(?:co-?pilot|advisory|read-only)\b/gi;
const RECOVERY_REFUTATION_RX = /\b(?:do\s+not|don'?t|never|must\s+not|should\s+not|cannot|can'?t|takes?\s+no)\b[^.!?;\n]{0,48}$/i;

export function copilotRecoveryDirective(text) {
  const value = String(text || '');
  COPILOT_RECOVERY_ACTUATOR_RX.lastIndex = 0;
  for (const match of value.matchAll(COPILOT_RECOVERY_ACTUATOR_RX)) {
    const before = value.slice(Math.max(0, match.index - 90), match.index);
    const clauseStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
    if (RECOVERY_REFUTATION_RX.test(before.slice(clauseStart + 1))) continue;
    return true;
  }
  return false;
}
