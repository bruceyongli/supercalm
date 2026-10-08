// Deterministic safety net for the voice concierge's most important transition:
// instruction -> confirmation -> delivery. Confirming an already-understood request must not
// depend on a second model call, especially when the operator adds one more requirement while
// saying yes. These helpers stay pure so the exact spoken sequence is cheap to regression-test.

const CONFIRM_PREFIX = /^(?:yes|yeah|yep|correct|that(?:'s| is) right|right|confirm(?:ed)?|go ahead|send (?:it|that)|do it|please do)\b/i;
const SOFT_CONFIRM_PREFIX = /^(?:okay|ok|sure)\b/i;
const CONFIRM_ONLY = /^(?:(?:and\s+)?(?:also\s+)?(?:go ahead|send (?:it|that)|do it|please|now|thanks?|thank you)[\s,.;!]*)+$/i;
const CONFIRM_QUESTION = /\b(?:confirm|send (?:it|that)|shall I|should I|want me to|is that right|did I get that right|sound right|correct)\b/i;
const ZH_CONFIRM = /^(?:确认发送|确认|发送吧|发送|发吧|就这么办|执行吧|是的|没错|对的|对|可以(?:发送|执行)(?:吧)?|好的?|可以|行)(?=$|[\s，。！？,.;!?]|另外|还有|并且|也|但是|不过)/u;
const ZH_CONFIRM_QUESTION = /(?:要不要|要|是否|可以|能否|需要).{0,16}(?:发送|发给|交给)|(?:确认发送|确认一下|我理解得对吗|这样对吗|这样可以吗|对吗|可以吗)/u;
const ZH_INFO = /^(?:(?:请|麻烦)(?:你)?|(?:能否|可否|可以|能不能|可不可以)(?:给我|帮我|你)?|你(?:可以|能)?(?:给我|帮我)?)?(?:解释|说明|讲(?:讲|一下)|说(?:说|一下)|告诉我|介绍|分析|读(?:一下)?|再说|重复|详细(?:说|讲)|展开)|^(?:为什么|为何|怎么|如何|什么|哪(?:个|些|里)|谁|什么时候|到底|这是(?:什么|怎么|哪|啥)|是不是|是否|有没有)|(?:我(?:是|刚才是)?(?:在)?问|我问的是)/u;
const ZH_ACTION = /^(?:(?:你)?(?:能不能|可不可以|可以|能否)|请|麻烦)?(?:你)?(?:帮我|替我)?(?:先)?(?:修复|修一下|修改|更新|增加|添加|移除|删除|实现|调整|改成|改为|改一下|继续(?:做|执行)|测试|运行)/u;
const ZH_NEXT = /^(?:下一个|下一项|跳过(?:这个|这一项)?|继续下一个)(?:吧)?$/u;
const ZH_DEFER = /^(?:(?:这个|这一项|这个项目)?(?:先放着|先留着|先不用处理|暂时不用处理)|我(?:会)?(?:稍后|晚点|之后|以后)再(?:看|审查|处理))(?:[，,。\s]+(?:我(?:会)?(?:稍后|晚点|之后|以后)再(?:看|审查|处理)|(?:看|继续)?下一个))?(?:吧)?$/u;
// A complete bilingual approval is not a clipped coding instruction. Match the
// WHOLE utterance: a question, correction or extra request must still be reasoned
// about, and only a server-scoped pending draft can turn this into delivery.
const NO_PROBLEM_APPROVAL = /^(?:(?:okay|ok|sure|好的?|可以)[\s,.;:!，。；：！-]*)?(?:没(?:有)?问题|no problems?)[\s,.;:!，。；：！-]*$/iu;

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

export function confirmationFrom(text) {
  const value = clean(text);
  if (NO_PROBLEM_APPROVAL.test(value)) return { additional: '' };
  const chinese = value.match(ZH_CONFIRM);
  const strong = chinese || value.match(CONFIRM_PREFIX);
  const soft = strong ? null : value.match(SOFT_CONFIRM_PREFIX);
  const match = strong || soft;
  if (!match) return null;
  let additional = value
    .slice(match[0].length)
    .replace(/^[\s,.;:!，。；：！-]+/, '')
    .replace(/^(?:and\s+)?(?:also\s+)?/i, '')
    .trim();
  if (chinese) additional = additional.replace(/^(?:另外|还有|并且|也)[，,\s]*/u, '').trim();
  // "Okay, but..." and "Yes, actually..." revise the pending request; they are not authorization
  // to send both the old and new versions.
  if (/^(?:but|instead|actually|wait|no\b|change\b|但是|但|不过|不是|等等|先别|不要|不对|改成)/iu.test(additional)) return null;
  if (chinese && /^(?:好|好的|可以|行)$/u.test(match[0]) && additional && !/^(?:另外|还有|并且)/u.test(value.slice(match[0].length).replace(/^[，,\s]+/, ''))
    && !isNavigationIntent(additional)) return null;
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
  if (reviewConversationIntent(userText)?.kind === 'defer') return null;
  const confirmation = confirmationFrom(userText);
  if (!confirmation) return null;
  // "Yes, what exactly failed?" acknowledges that we spoke but asks a follow-up; it is not approval
  // to append the question to the pending agent instruction.
  if (confirmation.additional && isVoiceInformationQuestion(confirmation.additional)) return null;
  return {
    say: /\p{Script=Han}/u.test(userText)
      ? confirmation.additional ? '好，我会把原来的指令和这项补充一起发送。' : '好，我现在发送这条指令。'
      : confirmation.additional
      ? "Got it. I'll send the original instruction with that additional request."
      : "Got it. I'll send that now.",
    action: 'send',
    message: combineVoiceInstructions(instruction, confirmation.additional),
    deterministic: true,
  };
}

export function asksForConfirmation(text) {
  return CONFIRM_QUESTION.test(clean(text)) || ZH_CONFIRM_QUESTION.test(clean(text));
}

const DISCOURSE_PREFIX = /^(?:(?:okay|ok|alright|all right|right|well)[\s,.;:!-]+)+/i;
const STOP = /^(?:stop(?: now| for now)?|done|that(?:'s| is) (?:all|enough)|end (?:this|the) (?:assistant|conversation|session))[\s.!]*$/i;
const NEXT = /^(?:skip(?: this| this one)?|pass|later|next|next one|move on|moving on|let(?:'s| us) move on|go (?:to )?(?:the )?next(?: one| item)?)[\s.!]*$/i;
const DEFER = /\b(?:(?:just\s+)?leave (?:it|this|this one)(?: alone)?|i(?:'ll| will) (?:(?:do|handle) (?:the |a )?review|review (?:it|this)|handle (?:it|this)) (?:myself )?later|i(?:'ll| will) (?:do|review|handle) (?:it|this) (?:myself )?later|nothing else (?:here|for (?:this|that)(?: item)?)|nothing (?:needs?|need) (?:the )?agent to do (?:right )?now|no(?:thing| action) (?:is )?needed (?:from (?:the )?agent )?(?:right )?now)\b/i;
const CANCEL_PENDING = /^(?:never mind|nevermind|cancel that|forget that|don'?t send (?:that|it)|do not send (?:that|it)|leave that unsent)[\s.!]*$/i;
const ACK_PREFIX = /^(?:(?:okay|ok|yes|yeah|yep|sure|alright|all right|right|great|very good|excellent|awesome|perfect|nice|thanks|thank you|sounds good|no problems?|that(?:'s| is) great|got it|understood)\b|好的?|可以|行|是的|没(?:有)?问题|没错|对的?|非常棒|太棒了|太好了|很好|不错|明白了?|知道了?|收到|谢谢)[\s,.;:!，。；：！-]*/iu;
const DEFER_CLAUSE = new RegExp(`^(?:${DEFER.source})$`, 'i');
const SELF_REVIEW_EN = /^i(?:'ll| will| can| am going to| plan to)\s+(?:(?:later|afterwards|tomorrow)\s+)?(?:do (?:a |the )?review|run (?:a |the )?test|review|test|verify|check|try)(?:\s+(?:it|this|that|this one|the update|the app|the report|the changes|the new version))?(?:\s+out)?(?:\s+myself)?(?:\s+(?:later|afterwards|tomorrow))?(?:\s+myself)?$/i;
const REVIEW_TIME_ZH = '(?:待会儿?|等会儿?|一会儿?|过一会儿?|晚点|稍后|回头|之后|以后)';
const SELF_REVIEW_ZH = new RegExp(`^我(?:自己)?(?:(?:会|来|准备|打算)?${REVIEW_TIME_ZH}(?:会|再|来|自己)?|(?:会|来|准备|打算)(?:自己)?)(?:测试|试用|验证|检查|复核|审查|评审|review|看看|试试|测测|看|试|测)(?:一下|一遍|下)?(?:这个(?:项目|版本|更新)?|这一项|它|效果)?(?:一下|一遍|下)?(?:${REVIEW_TIME_ZH})?(?:再说|吧)?$`, 'iu');

// A report response is not always a coding instruction. Consume the WHOLE utterance as known
// acknowledgement / owner-review / navigation clauses, so "great, I'll test later" works across
// languages without allowing "I'll review later, but fix the UI first" to discard real feedback.
function reviewConversationIntent(text) {
  const value = clean(text).replace(/[’‘]/g, "'");
  if (!value || /[?？]/u.test(value)) return null;
  const clauses = value.split(/[,.!;，。！；]+|\s+(?:and|so)\s+/iu).map(clean).filter(Boolean);
  let defer = false, next = false, acknowledged = false;
  for (let clause of clauses) {
    let match;
    while ((match = clause.match(ACK_PREFIX))) { acknowledged = true; clause = clause.slice(match[0].length).trim(); }
    if (!clause) continue;
    if (SELF_REVIEW_EN.test(clause) || SELF_REVIEW_ZH.test(clause) || DEFER_CLAUSE.test(clause) || ZH_DEFER.test(clause)) defer = true;
    else if (NEXT.test(clause) || ZH_NEXT.test(clause)) next = true;
    else return null;
  }
  return defer ? { kind: 'defer' } : next ? { kind: 'next' } : acknowledged ? { kind: 'ack' } : null;
}
const INFO_QUESTION = /^(?:what(?:'s| is| are| was| were| did| does| do| happened| should| would| could| can)\b|why\b|how(?:'s| is| are| did| does| do| should| would| could| can)?\b|when\b|where\b|who\b|which\b|more(?: details?)?\b|details?\b|tell me\b|explain\b|give me (?:more|details|the status)\b|read\b|repeat\b|do you think\b|(?:can|could|would) you (?:tell|explain|summarize|repeat|read|give me|check the status)\b|is (?:it|this|that|the|there)\b|are (?:they|these|those|the|there)\b|was (?:it|this|that|the|there)\b|were (?:they|these|those|the|there)\b|did (?:the|it|this|that|they)\b|does (?:the|it|this|that)\b|has (?:the|it|this|that)\b|have (?:the|it|this|that|they)\b)/i;
const POLITE_ACTION = /^(?:can|could|would|will) you (?!tell\b|explain\b|summarize\b|repeat\b|read\b|give me\b|check the status\b)/i;
const META_QUESTION = /\b(?:i (?:was|am|'m) (?:asking|wondering)|i asked|my question (?:was|is)|what i (?:asked|wanted to know))\b.{0,80}\b(?:detail|explain|why|what|how|status|happen|mean|think|recommend)/i;
const WAKE = /\b(?:hey[\s,]+|okay[\s,]+|ok[\s,]+)?super[\s-]*calm\b/i;
const REFERENTIAL_ACTION = /^(?:(?:yes|okay|ok|alright)[,\s]+)?(?:please\s+)?(?:just\s+)?(?:fix|change|update|improve|redo|remove|use|keep|make|do|handle|solve|approve|run|start|continue|commit|test|try|apply|choose)\b(?:\s+(?:it|this|that|them|these|those|the issue|the problem|what you (?:said|described)))?/i;
const UNRESOLVED_REFERENCE = /\b(?:it|this|that|them|these|those|what you (?:said|described))\b/i;
const DANGLING_DRAFT = /\b(?:to|and|or|because|by|with)\s*[.!?]*$/i;
const CONFIRMATION_AS_DRAFT = /^(?:yes|yeah|yep|okay|ok|sure|go ahead|send it|do it)\b/i;

export function isVoiceInformationQuestion(text) {
  const value = clean(text);
  if (POLITE_ACTION.test(value) || ZH_ACTION.test(value)) return false;
  const withoutPreface = value.replace(DISCOURSE_PREFIX, '').replace(/^(?:好的?|可以|行|是的|对的?|没错)[，,\s]+/u, '');
  return /[?？]$/.test(value) || ZH_INFO.test(value) || INFO_QUESTION.test(value) || META_QUESTION.test(value)
    || ZH_INFO.test(withoutPreface) || INFO_QUESTION.test(withoutPreface) || META_QUESTION.test(withoutPreface);
}

// Short live replies often use the assistant's immediately preceding report as their object:
// "fix it", "change that", "make it smaller". That is normal phone conversation, but the coding
// agent must receive the resolved object—not a useless pronoun or a clipped confirmation fragment.
export function isVagueVoiceInstruction(text) {
  const value = clean(text).replace(DISCOURSE_PREFIX, '');
  if (/^(?:请|帮我)?(?:修复|修一下|修改|更新|调整|改一下|处理|解决)(?:一下|它|这个|那个|这些|问题|这个问题|那个问题)?[。.!?？]*$/u.test(value)) return true;
  if (!REFERENTIAL_ACTION.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  return UNRESOLVED_REFERENCE.test(value) || words.length <= 2;
}

export function voiceDraftGrounding(userText, draft) {
  const message = clean(draft);
  if (!message) return { ok: false, reason: 'empty' };
  if (CONFIRMATION_AS_DRAFT.test(message) || DANGLING_DRAFT.test(message)
    || /^(?:好的?|可以|是的|对的?|没错|确认|发送吧?|发吧|就这么办|执行吧)[。.!?？]*$/u.test(message)) {
    return { ok: false, reason: 'incomplete' };
  }
  if (isVagueVoiceInstruction(userText)) {
    const same = message.toLowerCase() === clean(userText).toLowerCase();
    const han = [...message.matchAll(/\p{Script=Han}/gu)].length;
    if (same || UNRESOLVED_REFERENCE.test(message) || (han < 6 && message.split(/\s+/).length < 3)) {
      return { ok: false, reason: 'unresolved-reference' };
    }
  }
  return { ok: true, reason: '' };
}

export function isNavigationIntent(text) {
  const value = clean(text).replace(DISCOURSE_PREFIX, '').replace(/[。！？]+$/, '');
  const review = reviewConversationIntent(text);
  return !!value && (NEXT.test(value) || ZH_NEXT.test(value) || ZH_DEFER.test(value) || !!(review && review.kind !== 'ack'));
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
    say: /\p{Script=Han}/u.test(userText)
      ? `我的理解是：${spoken.slice(0, 220)}。要发送给这个会话吗？`
      : `I understood that as: ${spoken.slice(0, 220)}. Should I send that?`,
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
  const zh = intent.replace(/^(?:好的?|可以)[，,\s]+/u, '').replace(/[。！？.!?]+$/, '').trim();
  if (/^(?:停止|停|结束(?:对话|通话|助手))$/u.test(zh)) return { say: '好，结束对话。', action: 'stop', message: '', deterministic: true };
  if (/^(?:等等|等一下|暂停|别读了|先别说|先停一下)$/u.test(zh)) return { say: '好，我停下来听你说。', action: 'await', message: '', pause: true, deterministic: true };
  if (ZH_NEXT.test(zh) || ZH_DEFER.test(zh)) {
    return { say: hasPending ? '好，没有发送这条反馈。我们看下一项。' : '好，我们看下一项。', action: 'next', message: '', deterministic: true, discardedPending: hasPending };
  }
  if (hasPending && /^(?:取消(?:发送)?|别发(?:送)?(?:了)?|不要发(?:送)?|先别发(?:送)?|不用发(?:送)?)$/u.test(zh)) {
    return { say: '好，不发送。我们继续讨论这一项。', action: 'cancel', message: '', deterministic: true };
  }
  if (STOP.test(intent)) return { say: 'Okay, stopping.', action: 'stop', message: '', deterministic: true };
  if (NEXT.test(intent)) return {
    say: hasPending
      ? "Okay. I didn't send the pending feedback. Moving to the next item."
      : 'Okay, moving to the next item.',
    action: 'next', message: '', deterministic: true, discardedPending: hasPending,
  };
  if (hasPending && CANCEL_PENDING.test(intent)) return { say: "Okay, I won't send that. We can stay on this item.", action: 'cancel', message: '', deterministic: true };
  const review = reviewConversationIntent(message);
  if (review?.kind === 'next' && hasPending && CONFIRM_PREFIX.test(message) && confirmationFrom(message)) return null;
  if (review?.kind === 'ack' && hasPending && !confirmationFrom(message)) return {
    say: /\p{Script=Han}/u.test(message) ? '好，收到。反馈草稿还没发送，你可以修改、确认发送，或跳过。'
      : 'Understood. The draft is still unsent; you can revise it, confirm sending, or skip this item.',
    action: 'await', message: '', pause: true, deterministic: true, control: 'acknowledged-pending',
  };
  // A bare "okay" while confirming still approves that exact draft. Outside confirmation, a
  // positive acknowledgement means this report was heard—not an incomplete agent instruction.
  if (review && (review.kind !== 'ack' || !hasPending)) {
    const chinese = /\p{Script=Han}/u.test(message), deferred = review.kind === 'defer';
    const say = chinese
      ? `${hasPending ? '好，这条反馈没有发送。' : '好，收到。'}${deferred ? '留给你稍后验证，' : ''}我们看下一项。`
      : `${hasPending ? "Okay. I didn't send the pending feedback." : 'Okay, understood.'} ${deferred ? "I'll leave this for your later review and move to the next item." : 'Moving to the next item.'}`;
    return { say, action: 'next', message: '', deterministic: true, discardedPending: hasPending,
      control: deferred ? 'review-later' : review.kind === 'ack' ? 'report-acknowledged' : 'next' };
  }
  return null;
}

const DECLARED_ADVANCE = /\b(?:i(?:'ll| will| am|'m)\s+)?(?:am\s+)?moving (?:on|to the next)|\bi(?:'ll| will) move (?:on|to the next)|\bnext item\b/i;
const ASKED_ADVANCE = /\b(?:should|shall|may|can|would you like|do you want)\b.{0,35}\b(?:move|moving|go)\b.{0,15}\b(?:on|next)\b/i;

export function reconcileVoiceReply(reply, userText, { hasPending = false } = {}) {
  const out = { ...(reply || {}) };
  const operatorControl = voiceControlReply(userText, { hasPending });
  if (operatorControl) return operatorControl;
  // Queue movement is an operator-owned control. The model may explain, summarize, or compose a
  // draft, but it must never skip an item because it emitted `action:"next"` or happened to say
  // "moving on". The exact live failure classified "approve D-002 and run the decisive split" as
  // next, so no delivery handler ever ran. Only voiceControlReply(userText) may authorize movement.
  const modelTriedControl = !out.deterministic && (
    ['next', 'stop', 'cancel'].includes(out.action)
    || (out.action === 'await' && DECLARED_ADVANCE.test(clean(out.say)) && !ASKED_ADVANCE.test(clean(out.say)))
  );
  if (modelTriedControl) {
    if (isVoiceInformationQuestion(userText)) {
      return {
        ...out,
        action: 'await',
        message: '',
        say: clean(out.say) || "I'm staying on this item. What detail would you like?",
        reconciled: true,
      };
    }
    const orphanConfirmation = confirmationFrom(userText);
    const modelDraft = clean(out.message);
    const draft = (!isNavigationIntent(modelDraft) && modelDraft)
      || clean(orphanConfirmation?.additional)
      || clean(userText);
    const verdict = voiceDraftGrounding(userText, draft);
    if (verdict.ok) {
      return {
        ...out,
        action: 'await',
        message: draft,
        say: `I understood that as: ${draft.slice(0, 220)}. Should I send that?`,
        reconciled: true,
        rejectedModelControl: out.action,
      };
    }
    return {
      ...out,
      action: 'await',
      message: '',
      say: verdict.reason === 'unresolved-reference'
        ? "I'm staying on this item. What exactly should the agent approve or change?"
        : "I'm staying on this item because I don't have a complete instruction to send yet.",
      reconciled: true,
      rejectedModelControl: out.action,
    };
  }
  if (out.action === 'ignore') out.message = '';
  return out;
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
  if (reply?.pause) return prior;
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
  if (scopedVoicePending(prior, sessionId)
    && (isVoiceInformationQuestion(userText) || (reply?.action === 'await' && !clean(reply.message)))) return prior;
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
  const reply = reconcileVoiceReply(raw, userText, { hasPending: !!pending });
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
