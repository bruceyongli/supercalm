// TYPED INTENTS — Phase 1 of the v4 control plane (traceability S2/S6/S7; ARCHITECTURE.md §2).
//
// The brain proposes an INTENT (name + params); this module renders the outbound pane text from a
// vetted template. Free-form autonomous text dies here: contradiction checking becomes decidable
// (CONTINUE vs PARK is a state conflict, prose is not), placeholder pathologies are unrenderable,
// and the reserved-action scan runs against known shapes instead of arbitrary language.
//
// The ONE deliberate exception: ANSWER_QUESTION carries brain-authored content in its {text} param —
// an answer to "which approach should I take?" cannot be templated, and answers were the highest-
// value sends in the 10-session review. That content still passes the kernel's reserved scan,
// dedupe, rate, and breaker; Phase 2 binds it to evidence. Everything else is template-locked.
//
// PURE module (send_policy.js precedent): no db/model/store imports; unit- and mutation-testable.

import { SEND_KINDS } from './supervisor/send_policy.js';

const clamp = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Placeholder hygiene (traceability S7): the supervisor once sent a literal `/path/to/model` five
// times until the OPERATOR debugged it. Rendered text carrying an unresolved template variable, a
// scaffold path, or an angle-bracket stub is refused outright.
const UNRESOLVED_RX = /\{[a-z_]+\}|\/path\/to\/|<[a-z_-]+>|\bTODO\b|\bFIXME\b/i;

// Slash-commands the RECOVER lane may issue (state-changing rescues; each traces to a reviewed
// recovery flow). Anything else — including /login, /logout, arbitrary args — is unsendable.
const RECOVER_COMMANDS = new Set(['/compact', '/clear', '/fast']);

// The allowlist. Each intent: its send lane (send_policy kind), required params (name -> validator),
// and a template fn producing the EXACT outbound text. Templates are terse on purpose — the review's
// verbose boilerplate challenges (×122 verbatim) were noise the agent learned to ignore.
export const INTENTS = {
  CONTINUE: {
    kind: 'nudge',
    params: { reason: (v) => typeof v === 'string' && v.trim().length >= 3 },
    render: (p) => `Continue: ${clamp(p.reason, 240)}`,
  },
  ANSWER_MENU: {
    kind: 'answer',
    params: { option: (v) => Number.isInteger(v) && v >= 0 && v <= 9 },
    render: (p) => String(p.option),
  },
  ANSWER_QUESTION: {
    kind: 'answer',
    params: { text: (v) => typeof v === 'string' && v.trim().length >= 2 },
    render: (p) => clamp(p.text, 1200),
  },
  REQUEST_EVIDENCE: {
    kind: 'challenge',
    params: {
      claim: (v) => typeof v === 'string' && v.trim().length >= 3,
      types: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((t) => typeof t === 'string' && /^[a-z_ -]{2,32}$/i.test(t)),
    },
    render: (p) => `Evidence needed for "${clamp(p.claim, 160)}": ${p.types.map((t) => clamp(t, 32)).join(', ')}.`,
  },
  CHALLENGE_CLAIM: {
    kind: 'challenge',
    params: {
      claim: (v) => typeof v === 'string' && v.trim().length >= 3,
      gap: (v) => typeof v === 'string' && v.trim().length >= 3,
    },
    render: (p) => `On "${clamp(p.claim, 140)}": ${clamp(p.gap, 300)}`,
  },
  RECOVER_COMMAND: {
    kind: 'recover',
    params: { command: (v) => typeof v === 'string' && RECOVER_COMMANDS.has(v.trim()) },
    render: (p) => p.command.trim(),
  },
  // Code-authored fixed template (moved verbatim from runKeepWorking so the shape is vetted HERE):
  // drives an idle-but-unfinished agent to resume. The "real evidence, not prose" framing is load-
  // bearing — it pushes back on fake-done drift; keep it intact.
  KEEP_WORKING: {
    kind: 'nudge',
    params: { focus: (v) => v == null || typeof v === 'string' },
    render: (p) => `You stopped mid-task but the work is not finished. Resume now — take the next concrete step on the current focus${p.focus && String(p.focus).trim() ? ': ' + clamp(p.focus, 200) : ''}. If that step is genuinely the operator's (an approval, a credential, access), say so explicitly and ask them — do not idle silently. If the current phase is done, continue into the next unblocked sequenced/future/when-ready phase instead of stopping on the label. Keep going until every acceptance criterion is met with REAL evidence (files, command output, passing tests), not prose; if you hit a genuine blocker, state it specifically instead of pausing.`,
  },
  // LLM-authored content lanes (like ANSWER_QUESTION): declared passthroughs with hygiene screens —
  // the unstick brain's specific direction, and recovery context notes. Both remain kernel-scanned,
  // dedupe/rate/breaker-bounded, and lease-carrying (unstick) per dispatch rules.
  UNSTICK_DIRECTION: {
    kind: 'nudge',
    params: { text: (v) => typeof v === 'string' && v.trim().length >= 3 },
    render: (p) => clamp(p.text, 600),
  },
  RECOVER_NOTE: {
    kind: 'recover',
    params: { text: (v) => typeof v === 'string' && v.trim().length >= 3 },
    render: (p) => clamp(p.text, 600),
  },
};

export const INTENT_NAMES = Object.keys(INTENTS);

// Render an intent to its outbound send: { ok, text, kind } or { ok:false, error }. Fail-closed on
// unknown intents, missing/invalid params, unexpected extra params, and unresolved placeholders —
// a render failure upstream becomes a non-send (and a decision-log row), never improvised text.
export function renderIntent(name, params = {}) {
  const spec = INTENTS[name];
  if (!spec) return { ok: false, error: `unknown intent '${String(name).slice(0, 40)}' — not on the allowlist` };
  if (!SEND_KINDS.includes(spec.kind)) return { ok: false, error: `intent '${name}' maps to unknown kind '${spec.kind}'` };
  for (const [key, valid] of Object.entries(spec.params)) {
    if (!valid(params[key])) return { ok: false, error: `intent '${name}': param '${key}' missing or invalid` };
  }
  for (const key of Object.keys(params)) {
    if (!spec.params[key]) return { ok: false, error: `intent '${name}': unexpected param '${key}'` };
  }
  let text;
  try { text = spec.render(params); } catch (e) { return { ok: false, error: `render failed: ${String(e?.message || e)}` }; }
  if (!text || !String(text).trim()) return { ok: false, error: `intent '${name}' rendered empty text` };
  const passthrough = name === 'ANSWER_QUESTION' || name === 'UNSTICK_DIRECTION' || name === 'RECOVER_NOTE';
  if (!passthrough && UNRESOLVED_RX.test(text)) return { ok: false, error: `intent '${name}' rendered unresolved placeholder content` };
  if (passthrough && /\/path\/to\//i.test(text)) return { ok: false, error: `${name} content carries a scaffold path placeholder` };
  return { ok: true, text: String(text), kind: spec.kind };
}
