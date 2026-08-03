// Deterministic safety net for the voice concierge's most important transition:
// instruction -> confirmation -> delivery. Confirming an already-understood request must not
// depend on a second model call, especially when the operator adds one more requirement while
// saying yes. These helpers stay pure so the exact spoken sequence is cheap to regression-test.

const CONFIRM_PREFIX = /^(?:yes|yeah|yep|correct|that(?:'s| is) right|right|confirm(?:ed)?|go ahead|send (?:it|that)|do it|please do)\b/i;
const SOFT_CONFIRM_PREFIX = /^(?:okay|ok|sure)\b/i;
const CONFIRM_ONLY = /^(?:(?:and\s+)?(?:also\s+)?(?:go ahead|send (?:it|that)|do it|please|now|thanks?|thank you)[\s,.;!]*)+$/i;
const CONFIRM_QUESTION = /\b(?:confirm|send (?:it|that)|shall I|should I|want me to|is that right|did I get that right|sound right|correct)\b/i;

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

export function confirmationFrom(text) {
  const value = clean(text);
  const strong = value.match(CONFIRM_PREFIX);
  const soft = strong ? null : value.match(SOFT_CONFIRM_PREFIX);
  const match = strong || soft;
  if (!match) return null;
  let additional = value
    .slice(match[0].length)
    .replace(/^[\s,.;:!-]+/, '')
    .replace(/^(?:and\s+)?(?:also\s+)?/i, '')
    .trim();
  // "Okay, but..." and "Yes, actually..." revise the pending request; they are not authorization
  // to send both the old and new versions.
  if (/^(?:but|instead|actually|wait|no\b|change\b)/i.test(additional)) return null;
  // "Okay" is a conversational acknowledgement, not a universal approval prefix. With substantive
  // words after it ("Okay, moving on" / "Okay, tell me more"), route the whole turn by its meaning.
  if (soft && additional && !CONFIRM_ONLY.test(additional)) return null;
  if (isNavigationIntent(additional)) additional = ''; // "Yes, move on" approves; moving on is automatic after delivery.
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

const DISCOURSE_PREFIX = /^(?:(?:okay|ok|alright|all right|right|well)[\s,.;:!-]+)+/i;
const STOP = /^(?:stop(?: now| for now)?|done|that(?:'s| is) (?:all|enough)|end (?:this|the) (?:assistant|conversation|session))[\s.!]*$/i;
const NEXT = /^(?:skip(?: this| this one)?|pass|later|next|next one|move on|moving on|let(?:'s| us) move on|go (?:to )?(?:the )?next(?: one| item)?)[\s.!]*$/i;
const DEFER = /\b(?:(?:just\s+)?leave (?:it|this|this one)(?: alone)?|i(?:'ll| will) (?:(?:do|handle) (?:the |a )?review|review (?:it|this)|handle (?:it|this)) (?:myself )?later|i(?:'ll| will) (?:do|review|handle) (?:it|this) (?:myself )?later|nothing (?:needs?|need) (?:the )?agent to do (?:right )?now|no(?:thing| action) (?:is )?needed (?:from (?:the )?agent )?(?:right )?now)\b/i;
const CANCEL_PENDING = /^(?:never mind|nevermind|cancel that|forget that|don'?t send (?:that|it)|do not send (?:that|it)|leave that unsent)[\s.!]*$/i;
const INFO_QUESTION = /^(?:what(?:'s| is| are| was| were| did| does| do| happened| should| would| could| can)\b|why\b|how(?:'s| is| are| did| does| do| should| would| could| can)?\b|when\b|where\b|who\b|which\b|more(?: details?)?\b|details?\b|tell me\b|explain\b|give me (?:more|details|the status)\b|read\b|repeat\b|do you think\b|(?:can|could|would) you (?:tell|explain|summarize|repeat|read|give me|check the status)\b|is (?:it|this|that|the|there)\b|are (?:they|these|those|the|there)\b|was (?:it|this|that|the|there)\b|were (?:they|these|those|the|there)\b|did (?:the|it|this|that|they)\b|does (?:the|it|this|that)\b|has (?:the|it|this|that)\b|have (?:the|it|this|that|they)\b)/i;
const POLITE_ACTION = /^(?:can|could|would|will) you (?!tell\b|explain\b|summarize\b|repeat\b|read\b|give me\b|check the status\b)/i;
const META_QUESTION = /\b(?:i (?:was|am|'m) (?:asking|wondering)|i asked|my question (?:was|is)|what i (?:asked|wanted to know))\b.{0,80}\b(?:detail|explain|why|what|how|status|happen|mean|think|recommend)/i;
const WAKE = /\b(?:hey[\s,]+|okay[\s,]+|ok[\s,]+)?super[\s-]*calm\b/i;
const REFERENTIAL_ACTION = /^(?:(?:yes|okay|ok|alright)[,\s]+)?(?:please\s+)?(?:just\s+)?(?:fix|change|update|improve|redo|remove|use|keep|make|do|handle|solve)\b(?:\s+(?:it|this|that|them|these|those|the issue|the problem|what you (?:said|described)))?/i;
const UNRESOLVED_REFERENCE = /\b(?:it|this|that|them|these|those|what you (?:said|described))\b/i;
const DANGLING_DRAFT = /\b(?:to|and|or|because|by|with)\s*[.!?]*$/i;
const CONFIRMATION_AS_DRAFT = /^(?:yes|yeah|yep|okay|ok|sure|go ahead|send it|do it)\b/i;

export function isVoiceInformationQuestion(text) {
  const value = clean(text);
  if (POLITE_ACTION.test(value)) return false;
  const withoutPreface = value.replace(DISCOURSE_PREFIX, '');
  return value.endsWith('?') || INFO_QUESTION.test(value) || META_QUESTION.test(value)
    || INFO_QUESTION.test(withoutPreface) || META_QUESTION.test(withoutPreface);
}

// Short live replies often use the assistant's immediately preceding report as their object:
// "fix it", "change that", "make it smaller". That is normal phone conversation, but the coding
// agent must receive the resolved object—not a useless pronoun or a clipped confirmation fragment.
export function isVagueVoiceInstruction(text) {
  const value = clean(text).replace(DISCOURSE_PREFIX, '');
  if (!REFERENTIAL_ACTION.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  return UNRESOLVED_REFERENCE.test(value) || words.length <= 2;
}

export function voiceDraftGrounding(userText, draft) {
  const message = clean(draft);
  if (!message) return { ok: false, reason: 'empty' };
  if (CONFIRMATION_AS_DRAFT.test(message) || DANGLING_DRAFT.test(message)) {
    return { ok: false, reason: 'incomplete' };
  }
  if (isVagueVoiceInstruction(userText)) {
    const same = message.toLowerCase() === clean(userText).toLowerCase();
    if (same || UNRESOLVED_REFERENCE.test(message) || message.split(/\s+/).length < 3) {
      return { ok: false, reason: 'unresolved-reference' };
    }
  }
  return { ok: true, reason: '' };
}

export function isNavigationIntent(text) {
  const value = clean(text).replace(DISCOURSE_PREFIX, '');
  return !!value && (NEXT.test(value) || DEFER.test(value));
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

// A model may infer that a short reply confirms an instruction even when the server never staged
// that instruction (for example, after an earlier response was clipped). The server-owned dialogue
// state is authoritative: preserve the model's useful standalone draft, but turn its claimed send
// into an explicit confirmation turn. Reusing "Sending now. Moving on." here previously let the
// reconciliation step discard the recovered draft as navigation without ever delivering it.
export function requireVoiceConfirmation(reply, {
  pending = '',
  userText = '',
  spokenMessage = '',
} = {}) {
  const out = { ...(reply || {}) };
  if (out.action !== 'send' || clean(pending)) return out;
  const message = clean(out.message) || clean(userText);
  if (!message) return { ...out, action: 'await', message: '' };
  const spoken = clean(spokenMessage) || message;
  return {
    ...out,
    action: 'await',
    message,
    say: `I understood that as: ${spoken.slice(0, 220)}. Should I send that?`,
    confirmationRequired: true,
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
export function voiceControlReply(userText, { hasPending = false } = {}) {
  const message = clean(userText);
  if (!message) return null;
  const intent = message.replace(DISCOURSE_PREFIX, '');
  if (STOP.test(intent)) return { say: 'Okay, stopping.', action: 'stop', message: '', deterministic: true };
  if (NEXT.test(intent)) return { say: 'Okay, moving to the next item.', action: 'next', message: '', deterministic: true };
  if (DEFER.test(intent)) return { say: "Okay. I'll leave this item for your later review and move to the next one.", action: 'next', message: '', deterministic: true };
  if (hasPending && CANCEL_PENDING.test(intent)) return { say: "Okay, I won't send that. We can stay on this item.", action: 'cancel', message: '', deterministic: true };
  return null;
}

const DECLARED_ADVANCE = /\b(?:i(?:'ll| will| am|'m)\s+)?(?:am\s+)?moving (?:on|to the next)|\bi(?:'ll| will) move (?:on|to the next)|\bnext item\b/i;
const ASKED_ADVANCE = /\b(?:should|shall|may|can|would you like|do you want)\b.{0,35}\b(?:move|moving|go)\b.{0,15}\b(?:on|next)\b/i;

export function reconcileVoiceReply(reply, userText) {
  const out = { ...(reply || {}) };
  if (out.action === 'await' && DECLARED_ADVANCE.test(clean(out.say)) && !ASKED_ADVANCE.test(clean(out.say))) {
    out.action = 'next';
    out.message = '';
    out.reconciled = true;
  }
  if (['next', 'stop', 'cancel', 'ignore'].includes(out.action)) out.message = '';
  // A deterministic navigation reading always wins over an LLM's contradictory draft.
  return voiceControlReply(userText) || out;
}

export function createVoiceDialogueState() {
  return { phase: 'listening', pending: null };
}

export function scopedVoicePending(dialogue, sessionId) {
  const pending = dialogue?.phase === 'confirming' ? dialogue.pending : null;
  return pending?.sessionId === sessionId ? String(pending.text || '') : '';
}

export function reduceVoiceDialogue(dialogue, { reply, userText, sessionId }) {
  const prior = dialogue || createVoiceDialogueState();
  if (reply?.action === 'ignore') return prior; // ambient speech cannot mutate a real pending turn
  if (['send', 'next', 'stop', 'cancel'].includes(reply?.action)) return createVoiceDialogueState();
  const canStage = reply?.action === 'await'
    && !!clean(reply.message)
    && asksForConfirmation(reply.say)
    && !isVoiceInformationQuestion(userText);
  if (canStage) {
    return {
      phase: 'confirming',
      pending: { sessionId, text: clean(reply.message) },
    };
  }
  // Detail questions while confirming do not silently approve or destroy the draft. A later explicit
  // yes can still send it; presenting another session will fail the session-id scope check.
  if (scopedVoicePending(prior, sessionId) && isVoiceInformationQuestion(userText)) return prior;
  return createVoiceDialogueState();
}

// One authoritative reducer for a live turn. Ordering is the safety contract: navigation/global
// controls first, confirmation only against a scoped draft second, contextual reasoning last. The
// reply and next dialogue state are returned together so spoken behavior and server state cannot drift.
export async function resolveVoiceTurn({ dialogue, sessionId, userText, brain }) {
  const pending = scopedVoicePending(dialogue, sessionId);
  const raw = voiceControlReply(userText, { hasPending: !!pending })
    || confirmedPendingReply(pending, userText)
    || await brain();
  const reply = reconcileVoiceReply(raw, userText);
  return {
    reply,
    dialogue: reduceVoiceDialogue(dialogue, { reply, userText, sessionId }),
  };
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
  const grounding = voiceDraftGrounding(instruction, instruction);
  if (!grounding.ok) {
    return {
      say: grounding.reason === 'unresolved-reference'
        ? `I heard you, but my response service is unavailable, so I can't safely resolve what "it" refers to. Nothing was sent.`
        : `I heard you, but that instruction sounded incomplete and my response service is unavailable. Nothing was sent.`,
      action: 'await',
      message: '',
      providerFailed: true,
    };
  }
  return {
    say: `I heard you, but my response service is temporarily unavailable. I saved what you said. Say send it to pass it to ${destination || 'the agent'}.`,
    action: 'await',
    message: instruction,
    providerFailed: true,
  };
}
