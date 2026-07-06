// Operator STANCE — the supervisor's DURABLE model of what the operator wants it to do, replacing the
// per-message, 1h-decaying, regex-classified "intent". A directive like "finish all phases nonstop" must
// keep steering the supervisor for hours without re-instruction; the old code forgot it after an hour and
// then went silent (incident s_0e9e27b282). Stance is persisted in supervisor state and re-read by decide.js.
//
// This module is PURE (no db/model imports) so decide.js and the replay harness use it without a model. The
// LLM that READS operator messages into a stance lives in supervisor.js (updateOperatorStance) and calls
// classifyStanceFromText() here only as a deterministic fallback when the model is unreachable.

export const STANCES = ['autopilot', 'hold', 'answer_only', 'normal'];
export function isStance(s) { return STANCES.includes(String(s || '')); }

// The durable stance for a tick: the persisted operator stance if the LLM has set one, else 'normal'.
// (Autonomy affects whether nudges actually SEND — canSend — not the stance itself; autopilot is only ever
// set by an explicit operator directive, so a full-autonomy session isn't silently pushed through plan gates.)
export function resolveStance(persisted) {
  return isStance(persisted) ? persisted : 'normal';
}

// System prompt for the LLM stance classifier (used by supervisor.js via callJson). Semantic, not regex.
export const STANCE_SYS = `You read a human operator's recent messages to a SUPERVISOR that watches an autonomous coding agent, and output the operator's current STANDING STANCE — how they want the supervisor to behave until they clearly change it. This is a DURABLE directive derived from the operator's strongest recent INSTRUCTION, not from whatever their latest sentence happens to be.

Stances:
- "autopilot": the operator has delegated finishing the work — keep the agent going through the REMAINING phases/tasks on its own, without stopping for per-step approval. Set by instructions like "finish all the phases", "keep going nonstop", "continue to get all phases done", "go ahead and do everything", "don't stop". Once set this way it STAYS autopilot while the agent works and while the operator checks progress — it is only cancelled by a clear change of direction (see hold / answer_only / an explicit "that's enough").
- "hold": the operator explicitly wants the supervisor to wait / stop / stand down / stay quiet / not send anything for now.
- "answer_only": the operator explicitly restricted the supervisor to ANSWERING — "just answer my question", "don't fix anything", "answer only, no changes", "read-only". A plain question on its own is NOT answer_only.
- "normal": ordinary supervision. Use when no standing directive has been set.

Decisive rules:
1. A QUESTION, STATUS-CHECK, ACKNOWLEDGEMENT, or a forwarded agent report is NOT itself a stance change. E.g. "did you deploy all phases?", "what's the status?", "ok I see" do NOT set answer_only or hold — they KEEP the CURRENT STANCE. If the current stance is autopilot and the operator merely asks how it's going, stay autopilot.
2. Only change the stance when a message is a genuine new INSTRUCTION about how the supervisor should behave. Otherwise return the CURRENT STANCE unchanged.
3. Weigh the operator's strongest STANDING directive across the recent messages, not just the last line. "Go ahead with P3, nonstop, continue to get all phases done" is autopilot and remains so even if a later message is a progress question.
Return STRICT minified JSON ONLY: {"stance":"autopilot|hold|answer_only|normal","reason":"<one short clause>"}`;

// Build the user content: the operator's recent messages, oldest→newest.
export function buildStanceUserText(messages = [], { currentStance = '', goal = '' } = {}) {
  const lines = (messages || [])
    .slice(-8)
    .map((m) => `- ${String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`)
    .filter((l) => l.length > 2);
  return [
    goal ? `GOAL (context): ${String(goal).replace(/\s+/g, ' ').trim().slice(0, 240)}` : '',
    currentStance ? `CURRENT STANCE: ${currentStance}` : '',
    'OPERATOR MESSAGES (oldest first, newest last):',
    lines.join('\n') || '(none)',
  ].filter(Boolean).join('\n');
}

// Deterministic fallback ONLY for when the model is unreachable — intentionally conservative: it recognizes
// the two unambiguous standing directives (a clear all-the-work "keep going" and an explicit stop) and
// otherwise keeps the current stance or 'normal'. NOT the driver; the LLM is.
const CLEAR_AUTOPILOT = /\b(finish (?:all|the rest|everything|the remaining)|(?:keep|carry on) going|continue (?:until|through|to get) (?:all|the rest|everything|it'?s all|done)|do (?:all|everything|the rest)|non-?stop|don'?t stop until)\b/i;
const CLEAR_HOLD = /\b(stand down|stop\b|hold on|wait\b|do nothing|stay quiet|don'?t (?:send|do) anything|pause\b)\b/i;
export function classifyStanceFromText(text, current = 'normal') {
  const t = String(text || '');
  if (CLEAR_HOLD.test(t) && !CLEAR_AUTOPILOT.test(t)) return 'hold';
  if (CLEAR_AUTOPILOT.test(t)) return 'autopilot';
  return isStance(current) ? current : 'normal';
}
