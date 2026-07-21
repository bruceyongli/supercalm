// SEND KERNEL — the deterministic mediation layer between agent brains and the pane (v4 Phase 0).
//
// Every agent auto-send (ctx.sendToAgent / ctx.sendCommand in context.js) passes through
// evaluateSend() before any text reaches tmux. The LLM proposes; this code disposes. It enforces,
// in code, the four invariants the 10-long-sessions review showed prompts cannot hold
// (docs/improve/v4-traceability.md rows S1/S3/S4/S6):
//
//   1. KIND ALLOWLIST — a send must carry a declared kind from send_policy's SEND_KINDS.
//   2. RESERVED ACTIONS — deploy / credentials / surveys / card-lifecycle / destructive-git
//      directives are structurally unsendable by any agent in any mode; they can only become an
//      operator escalation. False positives are fail-safe: a blocked send turns into a notification.
//   3. DEDUPE + RATE BOUNDS — the same text never re-sends into an unchanged pane; identical text
//      is windowed; sends have a minimum gap and an hourly cap per session.
//   4. NO-EFFECT CIRCUIT BREAKER — N consecutive sends into a pane whose stabilized snapshot never
//      changed opens the circuit: no further sends, ONE escalation, and the circuit closes only
//      when the pane actually changes (deterministic close; a frozen pane stays silent forever
//      instead of collecting 134 sends).
//
// PURE module (like send_policy.js): no db/model/store imports. evaluateSend is a state-transition
// function — (state, proposal, now) -> { allowed, reason, escalate, state } — so every guard is
// unit-testable and mutation-testable (test/send_kernel.test.js fails if a guard is disabled).
// The stateful wrapper (per-session state map, audit events, notifications) lives in context.js.
//
// Emergency kill-switch: AIOS_SEND_KERNEL=0 (allow-all, audited as 'kernel-disabled'). Default ON.

import { SEND_KINDS, cardLifecycleDirective } from './supervisor/send_policy.js';

export const KERNEL_DEFAULTS = {
  minGapMs: Number(process.env.AIOS_SEND_KERNEL_MIN_GAP_MS || 90_000), // min gap between auto-sends per session
  hourlyCap: Number(process.env.AIOS_SEND_KERNEL_HOURLY_CAP || 10), // auto-sends per rolling hour per session
  dedupeWindowMs: Number(process.env.AIOS_SEND_KERNEL_DEDUPE_MS || 10 * 60_000), // identical text blocked within this window even if the pane changed
  breakerThreshold: Number(process.env.AIOS_SEND_KERNEL_BREAKER_N || 3), // consecutive no-effect sends before the circuit opens
  ringSize: 20, // remembered recent sends
  receiptTimeoutMs: Number(process.env.AIOS_SEND_KERNEL_RECEIPT_MS || 5 * 60_000), // a send unacknowledged by ANY pane movement for this long resolves received:false
  budgetCap: Number(process.env.AIOS_SEND_KERNEL_BUDGET_CAP || 3), // allowed sends per budget key per window — the key is the WORK ITEM, so rewording never resets it
  budgetWindowMs: Number(process.env.AIOS_SEND_KERNEL_BUDGET_MS || 6 * 3600_000),
};

// Phase-1 end-state, ON by default now that every agent send path declares an intent (supervisor via
// dispatch, slash-commands as RECOVER_COMMAND, council via COUNCIL_OUTCOME): a non-operator send without
// a declared intent is refused outright — free-form autonomous sends are structurally impossible.
// AIOS_SEND_KERNEL_REQUIRE_INTENT=0 is the emergency kill-switch (matches the Phase-0 pattern).
export function intentRequired() {
  return process.env.AIOS_SEND_KERNEL_REQUIRE_INTENT !== '0';
}

export function kernelEnabled() {
  return process.env.AIOS_SEND_KERNEL !== '0';
}

// FNV-1a 32-bit -> base36; local copy so the module stays dependency-free.
function h32(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Reserved-action classes (Phase-0 pattern grade; Phase 1 replaces free text with typed intents).
// Conservative on purpose — these run against AGENT-AUTHORED auto-sends only (kind 'operator', the
// operator's own relayed words, bypasses the kernel), and a false positive merely converts a send
// into an operator escalation. Each class traces to a reviewed incident:
//   deploy         — supervisor relayed "Deploy now, the operator already said deploy" x6 (s_0e9e27b282)
//   credentials    — supervisor directed login with a real user's password (s_ced80c3270)
//   survey         — supervisor answered the CLI's rating survey (s_ced80c3270, s_e8b74301f6)
//   card_lifecycle — self-echo incident (2026-07-09): card admin is operator territory in every mode
//   git_destructive— force-push / hard-reset directives; gitGuardrails covers the agent's own shell,
//                    this covers the SUPERVISOR telling the agent to do it
// ---------------------------------------------------------------------------
const RESERVED_RX = {
  deploy: /\b(deploy(?:ment|s)?|redeploy(?:ment)?|re-deploy)\b(?![^.!?\n]{0,40}\b(?:plan|doc|breaker|pipeline|api|key|log|logs|output|history|record|status)\b)|\bbin\/deploy\b|\bship\s+it\b|\bpush\s+(?:it\s+)?to\s+(?:prod|production|main|origin)\b/i,
  credentials: /\b(?:use|enter|type|paste|input|login\s+with|log\s*in\s+with)\b[^.!?\n]{0,50}\b(?:password|passcode|credential|secret|api[-_ ]?key|token)\b|\b(?:password|passcode|credential)\b[^.!?\n]{0,50}\b(?:use|enter|type|paste|input)\b|\blog\s*in\s+as\s+\w+|\b(?:cat|read|open|inspect|grep|check)\b[^.!?\n]{0,60}(?:\.dev\.vars|\bsecrets?\s+file|\bcredential\s+(?:file|store)|\.env\b)|\b(?:switch|swap|rotate|replace|apply)\b[^.!?\n]{0,40}\b(?:token|api[-_ ]?key|credential)\b|\.dev\.vars\b[^.!?\n]{0,60}\b(?:token|key|credential|auth|route)\b|登录.{0,20}密码|密码.{0,20}登录/i,
  survey: /\b(?:answer|select|choose|press|pick)\b[^.!?\n]{0,40}\b(?:survey|rating|feedback\s+form)\b|\b(?:survey|rating\s+prompt)\b[^.!?\n]{0,40}\b(?:answer|select|choose|press|pick)\b/i,
  // 2026-07-21 incident (s_541144f117): the completion gate DIRECTED "run the daylight host deployment
  // and migration 0033" / "run the host-apply runbook" — production operations commanded to
  // manufacture sign-off evidence, and the agent complied. Challenges may ask what HAPPENED; they may
  // never command state-changing production work. Verb+target pairing keeps discussion/plans sendable.
  production_ops: /\b(?:run|execute|apply|perform|start|kick\s*off|trigger)\b[^.!?\n]{0,60}\b(?:migration\s*\d*|host[- ]apply|runbook|rollout|cut[- ]?over|production\s+(?:change|update|push))\b|\b(?:migration\s*\d+)\b[^.!?\n]{0,40}\b(?:run|execute|apply|now)\b/i,
  git_destructive: /\bpush\b[^.!?\n]{0,30}--force\b(?!-with-lease)|--force\b[^.!?\n]{0,20}\bpush\b|\breset\s+--hard\b|\bclean\s+-[a-z]*f[a-z]*\b|\bbranch\s+-D\b|\brm\s+-rf\s+[^ ]*\.git\b/i,
};

export const RESERVED_CLASSES = [...Object.keys(RESERVED_RX), 'card_lifecycle'];

export function reservedActionClass(text) {
  const t = String(text || '');
  for (const [cls, rx] of Object.entries(RESERVED_RX)) if (rx.test(t)) return cls;
  if (cardLifecycleDirective(t)) return 'card_lifecycle';
  return null;
}

export function emptyKernelState() {
  return {
    lastSendTs: 0,
    hour: [], // ts of sends in the rolling hour
    ring: [], // { h, sig, ts } of recent sends (bounded)
    circuit: { open: false, sigAtOpen: '', openedAt: 0, escalated: false },
    escalated: {}, // reason-class -> last escalation ts (one notification per incident)
    pending: null, // last allowed send awaiting a RECEIPT: { id, sig, ts } — resolved on the next evaluation
    budgets: {}, // budgetKey -> { count, firstTs, escalated } — claim-bound send budgets (S4: paraphrase-proof)
  };
}

// The transition function. proposal: { kind, text, paneSig, lease? } where lease = { paneSig } captured
// when the proposing brain STARTED reasoning. Returns a NEW state (never mutates). `escalate` is true when
// this block is worth exactly one operator notification (escalateKey dedupes). `receipt` reports the FATE
// of the previous allowed send, resolved by observation: the pane moved since → received; nothing moved
// within the timeout → not received (S3 metric: sends-without-receipt).
export function evaluateSend(state, proposal, t, cfg = {}) {
  const c = { ...KERNEL_DEFAULTS, ...cfg };
  const st = state && typeof state === 'object' ? state : emptyKernelState();
  const kind = String(proposal?.kind || '');
  const text = String(proposal?.text || '');
  const paneSig = String(proposal?.paneSig || '');
  const leaseSig = String(proposal?.lease?.paneSig || '');
  const intentName = String(proposal?.intentName || '');
  const reservedWaiver = String(proposal?.reservedWaiver || ''); // set by the wrapper AFTER consuming a matching operator-minted capability — never by a brain
  const budgetKey = String(proposal?.budgetKey || ''); // the WORK ITEM this send serves (rule/gate scope) — budgets bind here, not to wording (S4)

  // Operator relays are the operator's own words — never kernel business, never budgeted.
  if (kind === 'operator') return { allowed: true, reason: '', escalate: false, escalateKey: '', receipt: null, state: st };

  if (!kernelEnabled()) return { allowed: true, reason: 'kernel-disabled', escalate: false, escalateKey: '', receipt: null, state: st };

  // 0) RECEIPT resolution for the previous allowed send — pure observation bookkeeping that happens
  //    regardless of this proposal's fate. Receipt = the stabilized pane moved after the send.
  let receipt = null;
  let base = st;
  if (st.pending) {
    if (paneSig && st.pending.sig && paneSig !== st.pending.sig) {
      receipt = { id: st.pending.id, received: true, ms: t - st.pending.ts };
      base = { ...st, pending: null };
    } else if (t - st.pending.ts > c.receiptTimeoutMs) {
      receipt = { id: st.pending.id, received: false, ms: t - st.pending.ts };
      base = { ...st, pending: null };
    }
  }

  const verdict = (allowed, reason, escalate = false, escalateKey = '', next = base) =>
    ({ allowed, reason, escalate, escalateKey, receipt, state: next });

  // 1) kind allowlist — an undeclared/unknown kind is a programming error upstream; fail closed.
  if (!SEND_KINDS.includes(kind)) return verdict(false, 'kernel-kind-not-allowlisted');

  // 1b) require-intent (Phase 1 end-state, opt-in until every agent lane declares intents): free-form
  //     autonomous sends are refused, not just deprecated.
  if (intentRequired() && !intentName) return verdict(false, 'kernel-intent-required');

  // 2) LEASE (CAS semantics): the proposal was computed against a pane that has since moved — the
  //    operator typed, a menu appeared, the agent progressed. Refuse; the pane change itself fires the
  //    next brain pass (event gate), which re-decides against reality. No state consumed.
  if (leaseSig && paneSig && leaseSig !== paneSig) return verdict(false, 'kernel-lease-expired');

  // 3) reserved actions — structurally unsendable; escalate once per class per open incident.
  //    EXCEPTION: a capability waiver for exactly this class (consumed by the wrapper from an
  //    operator-minted capability) converts the block into a normal send — which still runs the
  //    lease/dedupe/rate/breaker checks below; a capability authorizes the ACTION, not spam.
  const reserved = reservedActionClass(text);
  if (reserved && reserved !== reservedWaiver) {
    const key = `reserved:${reserved}`;
    const last = st.escalated?.[key] || 0;
    const escalate = t - last > 60 * 60_000; // re-notify at most hourly if the brain keeps trying
    const next = escalate ? { ...base, escalated: { ...st.escalated, [key]: t } } : base;
    return verdict(false, `kernel-${key}`, escalate, key, next);
  }

  // 4) circuit maintenance — the pane changing is the ONLY thing that closes an open circuit.
  let circuit = st.circuit || emptyKernelState().circuit;
  if (circuit.open && paneSig && paneSig !== circuit.sigAtOpen) {
    circuit = { open: false, sigAtOpen: '', openedAt: 0, escalated: false };
  }
  if (circuit.open) {
    const escalate = !circuit.escalated;
    const next = { ...base, circuit: { ...circuit, escalated: true } };
    return verdict(false, 'kernel-circuit-open', escalate, 'circuit', escalate ? next : { ...base, circuit });
  }

  // 5) no-effect breaker — this proposal would be one more send into a pane that hasn't changed
  //    since the last `breakerThreshold` sends. Open instead of sending.
  const ring = Array.isArray(st.ring) ? st.ring : [];
  if (paneSig && ring.length >= c.breakerThreshold) {
    const tail = ring.slice(-c.breakerThreshold);
    if (tail.every((r) => r.sig && r.sig === paneSig)) {
      const opened = { open: true, sigAtOpen: paneSig, openedAt: t, escalated: true };
      return verdict(false, 'kernel-circuit-open', true, 'circuit', { ...base, circuit: opened });
    }
  }

  // 6) dedupe — identical text into an unchanged pane never re-sends; identical text anywhere is
  //    windowed so "the pane moved" doesn't relicense verbatim spam.
  const hash = h32(normText(text));
  for (const r of ring) {
    if (r.h !== hash) continue;
    if (paneSig && r.sig === paneSig) return verdict(false, 'kernel-duplicate-same-pane');
    if (t - r.ts < c.dedupeWindowMs) return verdict(false, 'kernel-duplicate-recent');
  }

  // 7) CLAIM-BOUND BUDGET (S4 completion, post-v4 observation): N allowed sends per WORK ITEM per
  //    window — rewording a demand does not reset it (the ~8-paraphrase "produce the report now"
  //    cluster, 2026-07-17). Exhaustion blocks with ONE escalation: requires human review.
  let budgets = st.budgets || {};
  if (budgetKey) {
    let b = budgets[budgetKey];
    if (b && t - b.firstTs > c.budgetWindowMs) b = null; // window elapsed -> fresh budget
    if (b && b.count >= c.budgetCap) {
      const escalate = !b.escalated;
      const next = { ...base, budgets: { ...budgets, [budgetKey]: { ...b, escalated: true } } };
      return verdict(false, 'kernel-budget-exhausted', escalate, `budget:${budgetKey}`, escalate ? next : base);
    }
  }

  // 8) rate bounds.
  if (st.lastSendTs && t - st.lastSendTs < c.minGapMs) return verdict(false, 'kernel-rate-min-gap');
  const hour = (Array.isArray(st.hour) ? st.hour : []).filter((ts) => t - ts < 60 * 60_000);
  if (hour.length >= c.hourlyCap) return verdict(false, 'kernel-rate-hourly-cap');

  // Allowed — record the send; it becomes the pending receipt until the pane is observed to move.
  const next = {
    ...base,
    lastSendTs: t,
    hour: [...hour, t],
    ring: [...ring, { h: hash, sig: paneSig, ts: t }].slice(-c.ringSize),
    circuit,
    pending: { id: `${hash}.${t.toString(36)}`, sig: paneSig, ts: t },
    budgets: budgetKey
      ? { ...budgets, [budgetKey]: (() => { const b = budgets[budgetKey]; return b && t - b.firstTs <= c.budgetWindowMs ? { ...b, count: b.count + 1 } : { count: 1, firstTs: t, escalated: false }; })() }
      : budgets,
  };
  return verdict(true, '', false, '', next);
}
