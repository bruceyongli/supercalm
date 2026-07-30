// Deterministic safety net for the voice concierge's most important transition:
// instruction -> confirmation -> delivery. Confirming an already-understood request must not
// depend on a second model call, especially when the operator adds one more requirement while
// saying yes. These helpers stay pure so the exact spoken sequence is cheap to regression-test.

const CONFIRM_PREFIX = /^(?:yes|yeah|yep|correct|that(?:'s| is) right|right|confirm(?:ed)?|go ahead|send (?:it|that)|do it|please do|okay|ok|sure)\b/i;
const CONFIRM_ONLY = /^(?:(?:and\s+)?(?:also\s+)?(?:go ahead|send (?:it|that)|do it|please|now|thanks?|thank you)[\s,.;!]*)+$/i;
const CONFIRM_QUESTION = /\b(?:confirm|send (?:it|that)|shall I|should I|want me to|is that right|did I get that right|sound right|correct)\b/i;

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

export function confirmationFrom(text) {
  const value = clean(text);
  const match = value.match(CONFIRM_PREFIX);
  if (!match) return null;
  let additional = value
    .slice(match[0].length)
    .replace(/^[\s,.;:!-]+/, '')
    .replace(/^(?:and\s+)?(?:also\s+)?/i, '')
    .trim();
  // "Okay, but..." and "Yes, actually..." revise the pending request; they are not authorization
  // to send both the old and new versions.
  if (/^(?:but|instead|actually|wait|no\b|change\b)/i.test(additional)) return null;
  if (CONFIRM_ONLY.test(additional)) additional = '';
  return { additional };
}

export function combineVoiceInstructions(pending, additional = '') {
  const first = clean(pending);
  const extra = clean(additional);
  if (!first) return extra;
  if (!extra) return first;
  return `${first}\n\nAdditional request from the operator: ${extra}`;
}

export function confirmedPendingReply(pending, userText) {
  const instruction = clean(pending);
  if (!instruction) return null;
  const confirmation = confirmationFrom(userText);
  if (!confirmation) return null;
  return {
    say: confirmation.additional
      ? "Got it. I'll send the original instruction with that additional request."
      : "Got it. I'll send that now.",
    action: 'send',
    message: combineVoiceInstructions(instruction, confirmation.additional),
    deterministic: true,
  };
}

export function asksForConfirmation(text) {
  return CONFIRM_QUESTION.test(clean(text));
}

// A provider outage is not a speech-recognition failure. Preserve the transcript as a pending
// instruction and give the operator a deterministic next step; "send it" on the next turn then
// succeeds without calling any model.
export function providerFailureReply(userText, project = '') {
  const instruction = clean(userText);
  const destination = clean(project);
  return {
    say: `I heard you, but my response service is temporarily unavailable. I saved what you said. Say send it to pass it to ${destination || 'the agent'}.`,
    action: 'await',
    message: instruction,
    providerFailed: true,
  };
}
