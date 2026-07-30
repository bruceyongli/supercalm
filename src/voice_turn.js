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

const STOP = /^(?:stop(?: now| for now)?|done|that(?:'s| is) (?:all|enough)|end (?:this|the) (?:assistant|conversation|session))[\s.!]*$/i;
const NEXT = /^(?:skip(?: this| this one)?|pass|later|next|next one|move on)[\s.!]*$/i;
const INFO_QUESTION = /^(?:what(?:'s| is| are| was| were| did| does| do| happened| should| would| could| can)\b|why\b|how(?:'s| is| are| did| does| do| should| would| could| can)?\b|when\b|where\b|who\b|which\b|more(?: details?)?\b|details?\b|tell me\b|explain\b|give me (?:more|details|the status)\b|read\b|repeat\b|do you think\b|(?:can|could|would) you (?:tell|explain|summarize|repeat|read|give me|check the status)\b|is (?:it|this|that|the|there)\b|are (?:they|these|those|the|there)\b|was (?:it|this|that|the|there)\b|were (?:they|these|those|the|there)\b|did (?:the|it|this|that|they)\b|does (?:the|it|this|that)\b|has (?:the|it|this|that)\b|have (?:the|it|this|that|they)\b)/i;
const POLITE_ACTION = /^(?:can|could|would|will) you (?!tell\b|explain\b|summarize\b|repeat\b|read\b|give me\b|check the status\b)/i;

export function isVoiceInformationQuestion(text) {
  const value = clean(text);
  if (POLITE_ACTION.test(value)) return false;
  return value.endsWith('?') || INFO_QUESTION.test(value);
}

// Enabling On the go is the operator's standing authorization to hand their ordinary feedback to
// the session they are currently discussing. Manual Voice keeps confirm-before-send; On the go
// sends statements/opinions/answers immediately and reserves the model for genuine questions.
export function onTheGoImmediateReply(userText) {
  const message = clean(userText);
  if (!message) return null;
  if (STOP.test(message)) return { say: 'Okay, stopping.', action: 'stop', message: '', deterministic: true };
  if (NEXT.test(message)) return { say: 'Okay, skipping this one.', action: 'next', message: '', deterministic: true };
  if (isVoiceInformationQuestion(message)) return null;
  return {
    say: "Got it. I'm sending your feedback now.",
    action: 'send',
    message,
    deterministic: true,
    onTheGoImmediate: true,
  };
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
