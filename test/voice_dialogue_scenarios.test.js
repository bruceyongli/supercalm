import assert from 'node:assert/strict';
import {
  createVoiceDialogueState,
  reduceVoiceDialogue,
  resolveVoiceTurn,
  scopedVoicePending,
} from '../src/voice_turn.js';

const staged = (text = 'Make the report shorter.', sessionId = 's_current') => reduceVoiceDialogue(
  createVoiceDialogueState(),
  {
    sessionId,
    userText: text,
    reply: { action: 'await', say: `I understood: ${text} Should I send that?`, message: text },
  },
);

async function resolve(userText, { dialogue = createVoiceDialogueState(), sessionId = 's_current', brainReply = null } = {}) {
  let brainCalls = 0;
  const result = await resolveVoiceTurn({
    dialogue,
    sessionId,
    userText,
    brain: async () => {
      brainCalls++;
      return brainReply || { action: 'await', say: 'Tell me what you would like to do.', message: '' };
    },
  });
  return { ...result, brainCalls };
}

for (const utterance of [
  "Just leave it. I'll do a review later.",
  "I'll later do a review myself so nothing need the agent to do right now.",
  'Moving on.',
  'Okay, moving on.',
  'Skip this one.',
  'Go to the next item.',
]) {
  const result = await resolve(utterance, { dialogue: staged() });
  assert.equal(result.reply.action, 'next', `${utterance} advances the pass`);
  assert.equal(result.reply.message, '', `${utterance} never becomes agent feedback`);
  assert.equal(result.brainCalls, 0, `${utterance} does not depend on a model interpretation`);
  assert.equal(scopedVoicePending(result.dialogue, 's_current'), '', `${utterance} clears the old draft`);
}

{
  const result = await resolve("Don't send that.", { dialogue: staged() });
  assert.equal(result.reply.action, 'cancel');
  assert.equal(result.reply.message, '');
  assert.equal(result.brainCalls, 0);
  assert.equal(scopedVoicePending(result.dialogue, 's_current'), '');
}

{
  const result = await resolve('Okay.', { dialogue: staged() });
  assert.equal(result.reply.action, 'send', 'bare okay confirms only because the state is explicitly confirming');
  assert.equal(result.reply.message, 'Make the report shorter.');
}

{
  const result = await resolve('Yes, and also keep the current voice.', { dialogue: staged() });
  assert.equal(result.reply.action, 'send');
  assert.match(result.reply.message, /Make the report shorter/);
  assert.match(result.reply.message, /keep the current voice/);
}

{
  const result = await resolve('Yes, move on.', { dialogue: staged() });
  assert.equal(result.reply.action, 'send');
  assert.equal(result.reply.message, 'Make the report shorter.', 'navigation language is not appended to the coding-agent message');
}

{
  const pending = staged();
  const result = await resolve('Okay, tell me what is currently too long?', {
    dialogue: pending,
    brainReply: { action: 'await', say: 'The project preamble is repeated before the actual update.', message: '' },
  });
  assert.equal(result.reply.action, 'await');
  assert.equal(result.brainCalls, 1, 'a follow-up question reaches contextual reasoning');
  assert.equal(scopedVoicePending(result.dialogue, 's_current'), 'Make the report shorter.',
    'a follow-up question neither sends nor erases the draft');
}

{
  const result = await resolve('No, make it shorter but keep the cause.', {
    dialogue: staged(),
    brainReply: {
      action: 'await',
      say: 'I understood: shorten it but retain the cause. Should I send that?',
      message: 'Shorten the report but retain the cause.',
    },
  });
  assert.equal(result.reply.action, 'await');
  assert.equal(scopedVoicePending(result.dialogue, 's_current'), 'Shorten the report but retain the cause.',
    'a one-step correction replaces the pending draft instead of appending to it');
}

{
  const result = await resolve('people nearby are discussing dinner', {
    dialogue: staged(),
    brainReply: { action: 'ignore', say: '', message: '' },
  });
  assert.equal(result.reply.action, 'ignore');
  assert.equal(scopedVoicePending(result.dialogue, 's_current'), 'Make the report shorter.',
    'ambient speech cannot approve or mutate the draft');
}

assert.equal(scopedVoicePending(staged('Change session one.', 's_one'), 's_two'), '',
  'a pending instruction is unusable after the conversation advances to another session');

// Exact bilingual live failure: the transcript reached /turn, but the old English-only navigation
// vocabulary rejected the model's correct next action as an "incomplete instruction".
for (const utterance of [
  'OK,非常棒,我待会儿会测试一下。',
  'OK，非常棒，我待会儿会测试一下。',
  '非常棒我待会儿会测试一下',
  '好的，我自己晚点再验证。',
  '收到，我稍后再看一下。谢谢。',
  '太好了，我会测试一下。',
  "Sounds good, I'll try it out later.",
  "Great. I'll test the update myself later. Thanks!",
  'Okay, I will review this tomorrow.',
]) {
  for (const dialogue of [createVoiceDialogueState(), staged()]) {
    const result = await resolve(utterance, { dialogue });
    assert.equal(result.reply.action, 'next', utterance);
    assert.equal(result.reply.control, 'review-later', utterance);
    assert.equal(result.reply.message, '', 'owner review is never agent feedback');
    assert.equal(result.brainCalls, 0, 'an acknowledgement must not need a model round-trip');
    assert.equal(result.dialogue.phase, 'listening');
    assert.equal(scopedVoicePending(result.dialogue, 's_current'), '', 'deferral discards, never sends, a pending draft');
  }
}

for (const utterance of ['好的，谢谢。', '非常棒', 'Great, thanks!', 'Okay.']) {
  const result = await resolve(utterance);
  assert.equal(result.reply.action, 'next'); assert.equal(result.reply.control, 'report-acknowledged');
  assert.equal(result.reply.message, ''); assert.equal(result.brainCalls, 0);
}
{
  const result = await resolve('Great, thanks!', { dialogue: staged() });
  assert.equal(result.reply.action, 'await');
  assert.equal(scopedVoicePending(result.dialogue, 's_current'), 'Make the report shorter.',
    'thanks alone cannot send or erase an unconfirmed instruction');
  assert.equal(result.brainCalls, 0);
}

for (const utterance of [
  'OK,非常棒,我待会儿会测试一下，但请先修复输入框。',
  '我稍后再看，不过需要你现在修复这个错误',
  "Great, I'll test it later, but first fix the UI.",
  'Okay, I will test it after you deploy the fix.',
  "I'll review later and run the migration now.",
  '非常棒，可以解释一下怎么修复的吗？',
  '我待会儿会测试一下吗？',
]) {
  const result = await resolve(utterance);
  assert.equal(result.reply.action, 'await', 'mixed instructions/questions cannot be discarded as navigation: ' + utterance);
  assert.equal(result.brainCalls, 1, 'substantive feedback still reaches reasoning');
}

{
  const instruction = 'approve D-002 and run the decisive split';
  const result = await resolve(instruction, {
    brainReply: { action: 'next', say: 'Okay, moving on.', message: '' },
  });
  assert.equal(result.reply.action, 'await', 'a model cannot interpret an instruction as queue navigation');
  assert.equal(result.reply.message, instruction);
  assert.equal(scopedVoicePending(result.dialogue, 's_current'), instruction,
    'the misclassified instruction remains available for explicit confirmation');
}

console.log('voice_dialogue_scenarios.test ok');
