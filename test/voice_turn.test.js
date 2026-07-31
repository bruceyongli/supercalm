import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  asksForConfirmation,
  confirmationFrom,
  confirmedPendingReply,
  isVoiceInformationQuestion,
  normalizeVoiceAddress,
  parseVoiceBrainOutput,
  voiceControlReply,
  providerFailureReply,
} from '../src/voice_turn.js';
import { deliverVoiceFeedback } from '../src/voice_delivery.js';

const pending = 'Fix the report ordering and keep dismissed sessions hidden.';

assert.deepEqual(confirmationFrom('Yes.'), { additional: '' });
assert.deepEqual(confirmationFrom('Okay, go ahead and send it.'), { additional: '' });
assert.deepEqual(
  confirmationFrom('Yes, and also make the controls larger on iPhone.'),
  { additional: 'make the controls larger on iPhone.' },
);
assert.equal(confirmationFrom('No, change the layout first.'), null, 'a correction is not mistaken for confirmation');
assert.equal(confirmationFrom('Okay, but change the layout first.'), null, 'a qualified correction still needs reasoning');

const confirmed = confirmedPendingReply(pending, 'Yes, and also make the controls larger on iPhone.');
assert.equal(confirmed.action, 'send');
assert.match(confirmed.say, /additional request/);
assert.match(confirmed.message, /Fix the report ordering/);
assert.match(confirmed.message, /Additional request from the operator: make the controls larger/);

assert.equal(confirmedPendingReply('', 'Yes'), null, 'a bare yes cannot send without a pending instruction');
assert.equal(confirmedPendingReply(pending, 'Yes, what exactly failed?'), null,
  'an acknowledgment followed by a question stays in the assistant conversation');
assert.equal(asksForConfirmation('I understood the change. Should I send that?'), true);
assert.equal(asksForConfirmation('Here is more detail about the report.'), false);

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
assert.equal(voiceControlReply('I prefer option two.'), null,
  'feedback goes through contextual intent reasoning instead of an unconditional send shortcut');

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
assert.match(voiceSource, /normalizeVoiceAddress\(rawUserText\)/,
  'manual and proactive entry points normalize speech through the same conversation path');
assert.match(voiceSource, /isVoiceInformationQuestion\(userText\)[\s\S]*\['send', 'ignore'\]/,
  'explicit questions have a deterministic never-send guard');
assert.match(voiceSource, /action === 'send' && !vs\.pendingInstruction/,
  'a new instruction is confirmed before either Voice entry point can deliver it');
assert.doesNotMatch(voiceSource, /ON_THE_GO_SYS/,
  'proactive announcements no longer use a weaker second assistant policy');
assert.match(voiceSource, /voice-delivery/, 'every attempted handoff leaves a durable delivery audit');
assert.match(voiceSource, /draft: String\(r\.message \|\| userText\)/, 'an attempted handoff keeps a recoverable private draft');
assert.match(voiceSource, /requestAlive: voiceSessions\.has\(vs\.id\)/,
  'an active voice session owns delivery even after the HTTP upload stream closes');
assert.doesNotMatch(voiceSource, /requestAlive:\s*!req\.destroyed/,
  'request-stream teardown is never mistaken for conversation cancellation');

console.log('voice_turn.test ok');
