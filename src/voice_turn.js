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
  // "Yes, what exactly failed?" acknowledges that we spoke but asks a follow-up; it is not approval
  // to append the question to the pending agent instruction.
  if (confirmation.additional && isVoiceInformationQuestion(confirmation.additional)) return null;
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
const META_QUESTION = /\b(?:i (?:was|am|'m) (?:asking|wondering)|i asked|my question (?:was|is)|what i (?:asked|wanted to know))\b.{0,80}\b(?:detail|explain|why|what|how|status|happen|mean|think|recommend)/i;
const WAKE = /\b(?:hey[\s,]+|okay[\s,]+|ok[\s,]+)?super[\s-]*calm\b/i;

export function isVoiceInformationQuestion(text) {
  const value = clean(text);
  if (POLITE_ACTION.test(value)) return false;
  return value.endsWith('?') || INFO_QUESTION.test(value) || META_QUESTION.test(value);
}

// Strong conversational models sometimes answer an obvious follow-up directly despite the request
// for JSON. Rejecting that useful answer made Voice say its response service had failed. Plain prose
// is safe as an assistant-only "await" turn; it can never cross the delivery boundary. For a new
// statement we also keep the original words as a pending draft so a later confirmation is explicit.
export function parseVoiceBrainOutput(content, userText) {
  const raw = clean(content);
  if (!raw) throw new Error('empty voice model response');
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return {
    say: raw,
    action: 'await',
    message: isVoiceInformationQuestion(userText) ? '' : clean(userText),
    plain: true,
  };
}

// "Supercalm" remains a useful optional address when the room is noisy, but it is not a password for
// every conversational turn. Once the assistant has briefed the owner and is visibly listening, a
// natural follow-up such as "can you tell me about this?" must reach the same brain as manual Voice.
export function normalizeVoiceAddress(text) {
  const value = clean(text);
  const match = WAKE.exec(value);
  if (!match) return value;
  const after = value.slice(match.index + match[0].length).replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '');
  return clean(after) || value;
}

// Stop/next are shared deterministic controls. All feedback and questions otherwise go through the
// same context-aware Voice Assistant brain, regardless of whether the conversation was manually
// started or proactively announced.
export function voiceControlReply(userText) {
  const message = clean(userText);
  if (!message) return null;
  if (STOP.test(message)) return { say: 'Okay, stopping.', action: 'stop', message: '', deterministic: true };
  if (NEXT.test(message)) return { say: 'Okay, skipping this one.', action: 'next', message: '', deterministic: true };
  return null;
}

// Compatibility exports for older callers/tests during the user-facing rename. They intentionally
// inherit the unified conversational behavior; there is no separate delivery-mode brain anymore.
export function addressedOnTheGoSpeech(text) {
  const message = normalizeVoiceAddress(text);
  return { addressed: true, message };
}
export const onTheGoControlReply = voiceControlReply;

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
