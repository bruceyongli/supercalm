import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  asksForConfirmation,
  confirmationFrom,
  confirmedPendingReply,
  createVoiceDialogueState,
  isVoiceInformationQuestion,
  isVagueVoiceInstruction,
  normalizeVoiceAddress,
  parseVoiceBrainOutput,
  requireVoiceConfirmation,
  reconcileVoiceReply,
  reduceVoiceDialogue,
  resolveVoiceTurn,
  scopedVoicePending,
  voiceControlReply,
  voiceDraftGrounding,
  providerFailureReply,
} from '../src/voice_turn.js';
import { deliverVoiceFeedback } from '../src/voice_delivery.js';

const pending = 'Fix the report ordering and keep dismissed sessions hidden.';

// Actual Oct 8 Whisper output: complete Chinese acknowledgment was rejected as
// a cut-off instruction, and the failed reasoning then erased the pending draft.
for (const approval of ['OK,没有问题。', 'OK 没有问题。', 'OK没有问题。', '没问题。', '没有问题。', '好的，没问题。', 'No problem.', 'Okay, no problem.']) {
  const sessionId = 's_acknowledgment';
  const staged = reduceVoiceDialogue(createVoiceDialogueState(), { sessionId,
    userText: pending, reply: { action: 'await', say: 'Should I send that?', message: pending } });
  const brain = async () => { throw Error('Complete acknowledgment must not need model reasoning'); };
  const heard = await resolveVoiceTurn({ dialogue: createVoiceDialogueState(), sessionId, userText: approval, brain });
  assert.equal(heard.reply.action, 'next', approval);
  assert.equal(heard.reply.message, '', 'report acknowledgment never becomes agent input');
  const confirmed = await resolveVoiceTurn({ dialogue: staged, sessionId, userText: approval, brain });
  assert.equal(confirmed.reply.action, 'send', approval);
  assert.equal(confirmed.reply.message, pending, 'approval sends only the exact scoped draft');
  const other = await resolveVoiceTurn({ dialogue: staged, sessionId: 's_another', userText: approval, brain });
  assert.equal(other.reply.action, 'next', 'approval cannot send a different project draft');
  const uncertain = reduceVoiceDialogue(staged, { sessionId, userText: 'Unclear response',
    reply: { action: 'await', say: 'Please clarify.', message: '' } });
  assert.equal(scopedVoicePending(uncertain, sessionId), pending, 'failed/unclear reasoning preserves the confirmation draft');
}
for (const mixed of ['OK，没有问题？', '没问题，但是先不要发送', 'OK，没有问题，为什么还会出错？', '没问题，请先修复手机输入']) {
  assert.equal(confirmationFrom(mixed), null, 'qualified statements/questions are not bare approval');
  assert.equal(voiceControlReply(mixed), null, 'mixed feedback must not silently advance');
}

// Chinese must follow the same instruction -> clarification -> confirmation -> delivery contract.
{
  const instruction = '修复 iPhone 语音输入，并保留中英文自动识别。';
  const sessionId = 's_chinese';
  const staged = reduceVoiceDialogue(createVoiceDialogueState(), {
    sessionId, userText: '修一下',
    reply: { action: 'await', say: '我的理解是修复手机语音输入。要发送给这个会话吗？', message: instruction },
  });
  assert.equal(staged.phase, 'confirming', 'Chinese confirmation wording stages the draft');
  assert.equal(scopedVoicePending(staged, sessionId), instruction);
  assert.equal(scopedVoicePending(staged, 's_other'), '', 'Chinese drafts cannot cross session boundaries');
  for (const question of ['为什么', '可以解释一下吗', '好，为什么', '能不能告诉我哪里出了问题', '我问的是更新的细节']) {
    assert.equal(isVoiceInformationQuestion(question), true, question);
    assert.equal(confirmedPendingReply(instruction, question), null, 'Chinese questions are not approval');
    const clarified = await resolveVoiceTurn({ dialogue: staged, sessionId, userText: question,
      brain: async () => ({ action: 'await', say: '之前把浏览器的英文设置当成了唯一的语音语言。', message: '' }) });
    assert.equal(clarified.reply.action, 'await');
    assert.equal(scopedVoicePending(clarified.dialogue, sessionId), instruction, 'clarification preserves the pending instruction');
  }
  for (const approval of ['好的', '可以', '确认发送', '发送吧']) {
    const resolved = await resolveVoiceTurn({ dialogue: staged, sessionId, userText: approval,
      brain: async () => { throw new Error('Chinese confirmation must not need another model call'); } });
    assert.equal(resolved.reply.action, 'send');
    assert.equal(resolved.reply.message, instruction);
    assert.equal(resolved.dialogue.phase, 'listening');
    assert.equal(scopedVoicePending(resolved.dialogue, sessionId), '', 'delivery clears the Chinese draft');
  }
  assert.equal(confirmedPendingReply('', '确认发送'), null, 'approval cannot manufacture a missing instruction');
  assert.deepEqual(confirmationFrom('可以，另外保留中文'), { additional: '保留中文' });
  assert.equal(confirmationFrom('好的，但是先不要发布'), null, 'a revision must be reconsidered before sending');
  assert.equal(confirmationFrom('可以解释一下吗'), null);
  assert.equal(isVoiceInformationQuestion('可以修复中文输入吗？'), false, 'a polite Chinese action is feedback');
  assert.equal(isVoiceInformationQuestion('这是需要修复的手机输入框'), false, 'a Chinese statement is not automatically a question');
  assert.equal(isVagueVoiceInstruction('修一下'), true);
  assert.equal(voiceDraftGrounding('修一下', '修一下').ok, false);
  assert.equal(voiceDraftGrounding('修一下', instruction).ok, true, 'a resolved Chinese target does not need English word boundaries');
  assert.equal(voiceDraftGrounding('好的', '好的').ok, false);
  const restaged = requireVoiceConfirmation({ action: 'send', say: '正在发送', message: instruction }, { userText: '修一下' });
  assert.equal(restaged.action, 'await');
  assert.match(restaged.say, /要发送给这个会话吗/);
  const paused = await resolveVoiceTurn({ dialogue: staged, sessionId, userText: '暂停',
    brain: async () => { throw new Error('pause is deterministic'); } });
  assert.equal(paused.reply.pause, true);
  assert.equal(scopedVoicePending(paused.dialogue, sessionId), instruction, 'pause keeps the conversation and draft alive');
  for (const control of ['下一个', '跳过这个', '先放着', '我晚点再看', '先放着，我晚点再看']) {
    const skipped = await resolveVoiceTurn({ dialogue: staged, sessionId, userText: control,
      brain: async () => { throw new Error('navigation is deterministic'); } });
    assert.equal(skipped.reply.action, 'next');
    assert.equal(skipped.reply.message, '', 'navigation is never delivered to the coding agent');
    assert.equal(scopedVoicePending(skipped.dialogue, sessionId), '');
  }
  assert.equal(voiceControlReply('停止').action, 'stop');
  assert.equal(voiceControlReply('不要发送', { hasPending: true }).action, 'cancel');
  assert.equal(voiceControlReply('先放着，不过请先修复输入框', { hasPending: true }), null,
    'mixed feedback cannot be discarded just because its first words sound like deferral');
}

assert.deepEqual(confirmationFrom('Yes.'), { additional: '' });
assert.deepEqual(confirmationFrom('Okay, go ahead and send it.'), { additional: '' });
assert.deepEqual(
  confirmationFrom('Yes, and also make the controls larger on iPhone.'),
  { additional: 'make the controls larger on iPhone.' },
);
assert.equal(confirmationFrom('No, change the layout first.'), null, 'a correction is not mistaken for confirmation');
assert.equal(confirmationFrom('Okay, but change the layout first.'), null, 'a qualified correction still needs reasoning');
assert.equal(confirmationFrom('Okay, moving on.'), null, 'an acknowledgement plus navigation is not approval');

const confirmed = confirmedPendingReply(pending, 'Yes, and also make the controls larger on iPhone.');
assert.equal(confirmed.action, 'send');
assert.match(confirmed.say, /additional request/);
assert.match(confirmed.message, /Fix the report ordering/);
assert.match(confirmed.message, /Additional request from the operator: make the controls larger/);

assert.equal(confirmedPendingReply('', 'Yes'), null, 'a bare yes cannot send without a pending instruction');
assert.equal(confirmedPendingReply(pending, 'Yes, what exactly failed?'), null,
  'an acknowledgment followed by a question stays in the assistant conversation');
assert.equal(confirmedPendingReply(pending, 'Okay, moving on.'), null,
  'navigation can never be appended to a stale agent draft');
assert.equal(asksForConfirmation('I understood the change. Should I send that?'), true);
assert.equal(asksForConfirmation('Here is more detail about the report.'), false);

// Exact lost-reply regression: a model recovered a complete instruction and said it was sending and
// moving on, but the server had no scoped pending draft. That must become a real confirmation, retain
// the draft, and stage it for a deterministic "yes" instead of reconciling to navigation.
{
  const recoveredDraft = 'Run a driven end-to-end interaction test and capture the grounded answer.';
  const restaged = requireVoiceConfirmation({
    action: 'send',
    say: 'Sending it now. Moving on to the next item.',
    message: recoveredDraft,
  }, { pending: '', userText: 'Okay, send that now.', spokenMessage: recoveredDraft });
  assert.equal(restaged.action, 'await');
  assert.equal(restaged.message, recoveredDraft);
  assert.match(restaged.say, /Should I send that\?$/);
  assert.doesNotMatch(restaged.say, /sending|moving on/i);
  const staged = reduceVoiceDialogue(createVoiceDialogueState(), {
    sessionId: 's_recovered',
    userText: 'Okay, send that now.',
    reply: restaged,
  });
  assert.equal(staged.phase, 'confirming');
  assert.equal(scopedVoicePending(staged, 's_recovered'), recoveredDraft);
  const approved = await resolveVoiceTurn({
    dialogue: staged,
    sessionId: 's_recovered',
    userText: 'Yes, send it.',
    brain: async () => { throw new Error('confirmation must not call the model'); },
  });
  assert.equal(approved.reply.action, 'send');
  assert.equal(approved.reply.message, recoveredDraft);
}

// Exact outage recovery: the transcript is preserved, then confirmation succeeds locally without
// calling another model and without repeating "I had trouble understanding."
const failed = providerFailureReply('Add the new request to the same session.', 'AIOS');
assert.equal(failed.action, 'await');
assert.equal(failed.message, 'Add the new request to the same session.');
assert.match(failed.say, /response service is temporarily unavailable/);
assert.doesNotMatch(failed.say, /trouble understanding|say that again/i);
const recovered = confirmedPendingReply(failed.message, 'Send it');
assert.equal(recovered.action, 'send');
assert.equal(recovered.message, failed.message);
const vagueFailure = providerFailureReply('Fix it.', 'AIOS');
assert.equal(vagueFailure.message, '', 'a provider outage never turns an unresolved pronoun into a pending draft');
assert.match(vagueFailure.say, /Nothing was sent/);
assert.equal(providerFailureReply('Yes, go ahead ask the agent to', 'AIOS').message, '',
  'a provider outage cannot save a clipped phrase for later confirmation');

assert.equal(isVoiceInformationQuestion('What happened to the deployment?'), true);
assert.equal(isVoiceInformationQuestion('Why is this session blocked'), true, 'STT does not need question punctuation');
assert.equal(isVoiceInformationQuestion('Is it deployed'), true);
assert.equal(isVoiceInformationQuestion('Can you tell me what changed'), true);
assert.equal(isVoiceInformationQuestion('I was asking for the details'), true,
  'a correction about an earlier question cannot become agent feedback');
assert.equal(isVoiceInformationQuestion('Can you make the button larger on iPhone?'), false, 'a polite instruction is feedback, not an information question');
assert.deepEqual(
  parseVoiceBrainOutput('The wake gate dropped that follow-up. Both entry points now share one conversation.', 'Can you tell me about this?'),
  {
    say: 'The wake gate dropped that follow-up. Both entry points now share one conversation.',
    action: 'await',
    message: '',
    plain: true,
  },
  'a useful plain-language answer remains inside the assistant instead of becoming a provider failure',
);
assert.equal(
  parseVoiceBrainOutput('{"say":"","action":"ignore","message":""}', 'I will meet you at the coffee shop.').action,
  'ignore',
  'structured ambient-speech classification is preserved',
);
assert.equal(normalizeVoiceAddress('Can you tell me about this?'), 'Can you tell me about this?',
  'a natural follow-up reaches the assistant without a repeated wake phrase');
assert.equal(
  normalizeVoiceAddress('People nearby are talking. Supercalm, what failed in verification?'),
  'what failed in verification',
  'an optional address still isolates the words intended for the assistant in a noisy room',
);
assert.equal(normalizeVoiceAddress('Hey super calm, I prefer option two and larger mobile controls.'),
  'I prefer option two and larger mobile controls');
assert.equal(voiceControlReply('stop').action, 'stop');
assert.equal(voiceControlReply('next').action, 'next');
assert.equal(voiceControlReply('Okay, moving on.', { hasPending: true }).action, 'next');
assert.match(voiceControlReply('Okay, moving on.', { hasPending: true }).say, /didn't send the pending feedback/i,
  'an intentional skip explicitly reports that staged feedback was not sent');
assert.equal(voiceControlReply("Just leave it. I'll do a review later.", { hasPending: true }).action, 'next');
assert.equal(voiceControlReply("I'll later do a review myself so nothing need the agent to do right now.").action, 'next',
  'the previously misdelivered live utterance deterministically defers the item');
assert.equal(voiceControlReply("Don't send that.", { hasPending: true }).action, 'cancel');
assert.equal(voiceControlReply('I prefer option two.'), null,
  'feedback goes through contextual intent reasoning instead of an unconditional send shortcut');

assert.equal(isVagueVoiceInstruction('Fix it.'), true);
assert.equal(isVagueVoiceInstruction('Make that smaller.'), true);
assert.equal(isVagueVoiceInstruction('Fix the iPhone composer spacing.'), false);
assert.deepEqual(voiceDraftGrounding('Fix it.', 'Fix it.'), { ok: false, reason: 'unresolved-reference' },
  'the assistant cannot parrot an unresolved pronoun into confirmation');
assert.deepEqual(
  voiceDraftGrounding('Fix it.', 'Fix the extra space between the iPhone composer and keyboard.'),
  { ok: true, reason: '' },
  'a model-resolved reference becomes a standalone agent instruction',
);
assert.deepEqual(
  voiceDraftGrounding('Please continue', 'Yes, go ahead ask the agent to'),
  { ok: false, reason: 'incomplete' },
  'a clipped live phrase cannot be staged and later delivered',
);
assert.deepEqual(voiceDraftGrounding('Use option A', 'Use option A.'), { ok: true, reason: '' });

// Explicit dialogue state: a draft exists only while this exact item awaits confirmation.
{
  const initial = createVoiceDialogueState();
  const staged = reduceVoiceDialogue(initial, {
    sessionId: 's_one',
    userText: 'Make the report shorter.',
    reply: { action: 'await', say: 'I understood: make the report shorter. Should I send that?', message: 'Make the report shorter.' },
  });
  assert.equal(staged.phase, 'confirming');
  assert.equal(scopedVoicePending(staged, 's_one'), 'Make the report shorter.');
  assert.equal(scopedVoicePending(staged, 's_two'), '', 'a draft cannot cross into the next session');
  const afterQuestion = reduceVoiceDialogue(staged, {
    sessionId: 's_one',
    userText: 'What is currently too long?',
    reply: { action: 'await', say: 'The opening repeats the same context.', message: '' },
  });
  assert.equal(scopedVoicePending(afterQuestion, 's_one'), 'Make the report shorter.',
    'asking detail does not approve or silently discard the pending draft');
  const afterMove = reduceVoiceDialogue(afterQuestion, {
    sessionId: 's_one',
    userText: 'Okay, moving on.',
    reply: voiceControlReply('Okay, moving on.', { hasPending: true }),
  });
  assert.equal(afterMove.phase, 'listening');
  assert.equal(scopedVoicePending(afterMove, 's_one'), '');
  const ambient = reduceVoiceDialogue(staged, {
    sessionId: 's_one', userText: 'people nearby talking', reply: { action: 'ignore', say: '', message: '' },
  });
  assert.equal(scopedVoicePending(ambient, 's_one'), 'Make the report shorter.', 'ambient speech cannot mutate the pending state');
}

assert.equal(
  reconcileVoiceReply({ action: 'await', say: 'Understood. Moving on.', message: 'moving on' }, 'Nothing else here.').action,
  'next',
  'the operator’s own defer language—not the assistant wording—moves to the next item',
);
assert.equal(
  reconcileVoiceReply({ action: 'await', say: 'Understood. Moving on.', message: 'moving on' }, 'I prefer option two.').action,
  'await',
  'assistant movement wording alone cannot advance the queue',
);

// Exact live regression: the voice brain mislabeled an explicit approval as navigation. The model
// cannot own the queue pointer; preserve the instruction and ask for confirmation instead.
{
  const instruction = 'approve D-002 and run the decisive split';
  const recovered = reconcileVoiceReply({
    action: 'next', say: 'Okay, moving on.', message: '',
  }, instruction);
  assert.equal(recovered.action, 'await');
  assert.equal(recovered.message, instruction);
  assert.match(recovered.say, /Should I send that\?$/);
  assert.equal(recovered.rejectedModelControl, 'next');
  const staged = reduceVoiceDialogue(createVoiceDialogueState(), {
    sessionId: 's_trading', userText: instruction, reply: recovered,
  });
  assert.equal(scopedVoicePending(staged, 's_trading'), instruction);
  const sent = await resolveVoiceTurn({
    dialogue: staged,
    sessionId: 's_trading',
    userText: 'Yes, send it.',
    brain: async () => { throw new Error('confirmation must stay deterministic'); },
  });
  assert.equal(sent.reply.action, 'send');
  assert.equal(sent.reply.message, instruction);
  let delivered = '';
  const outcome = await deliverVoiceFeedback({
    item: { sessionId: 's_trading', project: 'trading', presentedAt: 10 },
    reply: sent.reply,
    getSession: () => ({ status: 'waiting' }),
    answeredElsewhere: () => false,
    deliverReply: async (_sid, message) => { delivered = message; return { ok: true }; },
  });
  assert.equal(outcome.sent, true);
  assert.equal(delivered, instruction, 'the recovered approval reaches the intended coding-agent handler');
}

{
  const result = reconcileVoiceReply({ action: 'next', say: 'Moving on.', message: '' }, 'Why did the test fail?');
  assert.equal(result.action, 'await');
  assert.equal(result.message, '', 'a model navigation error cannot turn an information question into agent input');
}

// End-to-end turn selection: navigation short-circuits the model and cannot inherit a stale draft.
{
  const confirming = reduceVoiceDialogue(createVoiceDialogueState(), {
    sessionId: 's_live',
    userText: 'Change the layout.',
    reply: { action: 'await', say: 'Should I send that?', message: 'Change the layout.' },
  });
  let brainCalls = 0;
  const moved = await resolveVoiceTurn({
    dialogue: confirming,
    sessionId: 's_live',
    userText: 'Okay, moving on.',
    brain: async () => { brainCalls++; throw new Error('must not call'); },
  });
  assert.equal(moved.reply.action, 'next');
  assert.equal(moved.reply.message, '');
  assert.equal(scopedVoicePending(moved.dialogue, 's_live'), '');
  assert.equal(brainCalls, 0);

  const deferred = await resolveVoiceTurn({
    dialogue: confirming,
    sessionId: 's_live',
    userText: "Just leave it. I'll do a review later.",
    brain: async () => { brainCalls++; throw new Error('must not call'); },
  });
  assert.equal(deferred.reply.action, 'next');
  assert.equal(deferred.reply.message, '');
  assert.equal(brainCalls, 0);

  const approved = await resolveVoiceTurn({
    dialogue: confirming,
    sessionId: 's_live',
    userText: 'Yes, send it.',
    brain: async () => { throw new Error('must not call'); },
  });
  assert.equal(approved.reply.action, 'send');
  assert.equal(approved.reply.message, 'Change the layout.');
}

// Complete delivery boundary: a context-classified send reaches the shared delivery path, and
// success is not announced until that delivery resolves.
{
  const reply = { action: 'send', message: 'Use the calmer layout and keep the dismissed items hidden.' };
  let delivered = '';
  const outcome = await deliverVoiceFeedback({
    item: { sessionId: 's_target', project: 'AIOS', presentedAt: 10 },
    reply,
    getSession: () => ({ status: 'waiting' }),
    answeredElsewhere: () => false,
    deliverReply: async (_sid, message) => { delivered = message; return { ok: true }; },
  });
  assert.equal(delivered, reply.message);
  assert.equal(outcome.sent, true);
  assert.equal(outcome.delivery.status, 'sent');
  assert.match(outcome.say, /^Sent your feedback to AIOS/);
}
{
  const outcome = await deliverVoiceFeedback({
    item: { sessionId: 's_target', project: 'AIOS' },
    reply: { message: 'feedback' },
    getSession: () => ({ status: 'waiting' }),
    answeredElsewhere: () => false,
    deliverReply: async () => ({ inputBlocked: true, reason: 'resume-choice' }),
  });
  assert.equal(outcome.sent, false);
  assert.equal(outcome.retry, true);
  assert.equal(outcome.delivery.status, 'input-blocked');
  assert.match(outcome.say, /recovery-choice screen/i);
  assert.doesNotMatch(outcome.say, /still resuming/i);
}
{
  const outcome = await deliverVoiceFeedback({
    item: { sessionId: 's_target', project: 'AIOS' },
    reply: { message: 'feedback' },
    getSession: () => ({ status: 'waiting' }),
    answeredElsewhere: () => false,
    deliverReply: async () => ({ inputBlocked: true, reason: 'input-unavailable' }),
  });
  assert.equal(outcome.sent, false);
  assert.match(outcome.say, /couldn't identify a safe agent input box/i);
  assert.doesNotMatch(outcome.say, /still resuming/i,
    'unknown input state is reported honestly instead of invented as recovery');
}
{
  const deliveryOptions = [];
  let deliveryAttempts = 0;
  const outcome = await deliverVoiceFeedback({
    item: { sessionId: 's_target', project: 'AIOS' },
    reply: { message: 'feedback' },
    getSession: () => ({ status: 'waiting' }),
    answeredElsewhere: () => false,
    deliverReply: async (_sid, _message, options) => {
      deliveryOptions.push(options);
      deliveryAttempts++;
      if (deliveryAttempts === 1) return { inputBlocked: true, reason: 'pending-draft' };
      return { ok: true, replacedDraft: true };
    },
  });
  assert.equal(outcome.sent, true);
  assert.deepEqual(deliveryOptions, [
    { replacePendingDraft: true },
    { replacePendingDraft: true },
  ], 'a confirmed voice send overrides a stale native Terminal draft, including a repaint race');
  assert.equal(outcome.delivery.archivedTerminalDraft, true,
    'the displaced draft is reported as archived instead of blocking the instruction');
  assert.doesNotMatch(outcome.say, /unfinished Terminal draft|policy|did not replace/i);
}
{
  const outcome = await deliverVoiceFeedback({
    item: { sessionId: 's_target', project: 'AIOS' },
    reply: { message: 'feedback' },
    getSession: () => ({ status: 'waiting' }),
    answeredElsewhere: () => false,
    deliverReply: async () => { throw new Error('tmux unavailable'); },
  });
  assert.equal(outcome.sent, false);
  assert.equal(outcome.delivery.status, 'failed');
  assert.doesNotMatch(outcome.say, /^Sent/);
}

const voiceSource = readFileSync(new URL('../src/voice.js', import.meta.url), 'utf8');
assert.doesNotMatch(
  voiceSource,
  /\.\.\.vs\.history,\s*\{\s*role:\s*['"]user['"]/,
  'the current transcript is not appended a second time after it was recorded in history',
);
assert.doesNotMatch(voiceSource, /onTheGoImmediateReply\(userText\)/,
  'On the go no longer treats every transcript as immediate feedback');
assert.match(voiceSource, /voiceTranscriptDisposition\(rawUserText[\s\S]*normalizeVoiceAddress\(disposition\.text\)/,
  'manual and proactive entry points share transcript validation and conversation normalization');
assert.match(voiceSource, /if \(!disposition\.accepted\)[\s\S]*voice-input-ignored[\s\S]*ignoredReason: disposition\.reason/,
  'the server rejects phone fragments before dialogue or model reasoning, including for stale PWA clients');
assert.match(voiceSource, /deliverReply: \(sid, message, options = \{\}\)[\s\S]*\{ \.\.\.options, source: 'voice' \}/,
  'the voice route forwards the explicit draft-replacement option into the shared delivery handler');
assert.doesNotMatch(voiceSource, /(?:emptyTurns|fragmentTurns)\s*>=\s*3/,
  'silence and unclear speech never terminate the conversation');
assert.match(voiceSource, /api\/voice\/keepalive/,
  'a silently listening client keeps its live conversation beyond the abandoned-session TTL');
assert.match(voiceSource, /voiceDraftGrounding\(userText, message\)/,
  'unresolved references and clipped drafts fail closed before confirmation or delivery');
assert.match(voiceSource, /isVoiceInformationQuestion\(userText\)[\s\S]*\['send', 'ignore'\]/,
  'explicit questions have a deterministic never-send guard');
assert.match(voiceSource, /requireVoiceConfirmation\(/,
  'a new instruction is confirmed before either Voice entry point can deliver it');
assert.doesNotMatch(voiceSource, /vs\.pendingInstruction/,
  'unscoped pending text has been replaced by explicit per-session dialogue state');
const voiceTurnSource = readFileSync(new URL('../src/voice_turn.js', import.meta.url), 'utf8');
assert.match(voiceTurnSource, /voiceControlReply\(userText, \{ hasPending: !!pending \}\)[\s\S]*confirmedPendingReply/,
  'navigation and cancellation are resolved before confirmation');
assert.doesNotMatch(voiceSource, /ON_THE_GO_SYS/,
  'proactive announcements no longer use a weaker second assistant policy');
assert.match(voiceSource, /voice-delivery/, 'every attempted handoff leaves a durable delivery audit');
assert.match(voiceSource, /transcript: userText\.slice\(0, 8000\)/,
  'accepted voice turns persist the recoverable transcript instead of only its character count');
assert.match(voiceSource, /rejected_model_control: r\.rejectedModelControl/,
  'the audit identifies when model output tried to move the operator queue');
assert.match(voiceSource, /status: 'skipped'[\s\S]*voice-delivery/,
  'moving past an item creates an explicit non-delivery receipt');
assert.match(voiceSource, /if \(outcome\.retry\)[\s\S]*phase: 'confirming'[\s\S]*pending: \{ sessionId: it\.sessionId, text: retryMessage \}/,
  'a retryable delivery keeps the confirmed voice draft scoped to the same session');
assert.match(voiceSource, /r\.message \? \{ draft: String\(r\.message\)/,
  'a staged instruction is recoverable before the final delivery turn');
assert.match(voiceSource, /requestAlive: voiceSessions\.has\(vs\.id\)/,
  'an active voice session owns delivery even after the HTTP upload stream closes');
assert.doesNotMatch(voiceSource, /requestAlive:\s*!req\.destroyed/,
  'request-stream teardown is never mistaken for conversation cancellation');

console.log('voice_turn.test ok');
