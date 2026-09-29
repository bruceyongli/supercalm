import assert from 'node:assert/strict';
import { submitAgentComposer, serializeAgentInput } from '../src/agent_submit.js';
import { agentInputReady, operatorInputPlan, pendingComposerDraft } from '../src/agent_input_ready.js';
import { deliverVoiceFeedback } from '../src/voice_delivery.js';

const idle = '› Ask Codex to do anything\n\nGPT-6-Astra xhigh · /tmp/test';
const draft = text => `› ${text}\n\nGPT-6-Astra xhigh · /tmp/test`;
const accepted = text => `› ${text}\n\n• Working (esc to interrupt)\n\n${idle}`;
for (const hint of ['Ask Codex to do anything', 'Improve documentation in @filename']) {
  const screen = idle.replace('Ask Codex to do anything', hint);
  assert.equal(agentInputReady(screen), true);
  assert.equal(pendingComposerDraft(screen), null);
  assert.deepEqual(operatorInputPlan(screen, 'fix it'), { ready: true, target: 'composer' });
}
assert.equal(pendingComposerDraft(accepted('fix it')), null, 'submitted transcript text is not a pending draft');
assert.equal(pendingComposerDraft('❯ prior request\n\n❯\n  bypass permissions on'), null, 'empty Claude composer bounds the search');

async function run({ screen, onEnter = () => {}, text = 'fix it', before = idle, timeoutMs = 2400 }) {
  let t = 0;
  const enters = [];
  const result = await submitAgentComposer({
    text, before, timeoutMs,
    clock: () => t,
    pause: async ms => { t += ms; },
    readScreen: async () => screen({ time: t, enters: enters.length }),
    pressEnter: async () => { enters.push(t); onEnter(enters.length); },
  });
  return { result, enters, elapsed: t };
}

let r = await run({ screen: ({ enters }) => enters ? accepted('fix it') : draft('fix it') });
assert.equal(r.result.accepted, true);
assert.equal(r.result.verified, true);
assert.equal(r.enters.length, 1, 'ordinary sends need one Enter');

r = await run({ screen: ({ time, enters }) => time < 900 ? idle : enters >= 2 ? accepted('fix it') : draft('fix it') });
assert.equal(r.result.accepted, true);
assert.equal(r.enters.length, 2, 'an ignored Enter is retried without repasting');
assert.ok(r.enters[0] >= 900, 'wait for the actual pasted draft rather than submitting a stale screen');
assert.ok(r.enters[1] - r.enters[0] >= 800, 'a retained draft must settle before another Enter');

r = await run({ screen: () => draft('fix it') });
assert.equal(r.result.accepted, false);
assert.equal(r.result.reason, 'submit-unconfirmed');
assert.equal(r.enters.length, 3, 'bounded recovery never loops forever');
assert.equal(r.result.pendingDraft, 'fix it');

r = await run({ screen: ({ enters }) => draft(enters ? 'a different human draft' : 'fix it') });
assert.equal(r.result.reason, 'input-changed');
assert.equal(r.enters.length, 1, 'never submits a changed human draft');

r = await run({ screen: () => idle });
assert.equal(r.result.accepted, false);
assert.equal(r.enters.length, 0, 'no fake receipt when the paste never appears');

r = await run({ screen: ({ enters }) => enters ? 'Loading session…' : draft('fix it') });
assert.equal(r.result.reason, 'submit-unconfirmed');
assert.equal(r.enters.length, 1, 'unknown/loading screens do not authorize more Enter presses');

r = await run({ screen: ({ enters }) => enters ? accepted('long request') : draft('[Pasted text #1 +32 lines]'), text: 'long request' });
assert.equal(r.result.accepted, true, 'a new folded paste token is an observable draft');
r = await run({ before: draft('[Pasted text #1 +32 lines]'), screen: () => draft('[Pasted text #1 +32 lines]'), text: 'another request' });
assert.equal(r.enters.length, 0, 'an existing folded paste is never blindly submitted');

const long = Array.from({ length: 35 }, (_, i) => `request line ${i}`).join('\n');
r = await run({ text: long, screen: ({ enters }) => enters ? idle : draft(long) });
assert.equal(r.result.accepted, true, 'tall wrapped composers are supported during verification');
r = await run({ text: 'check https://example.test/averylongpath', screen: ({ enters }) => enters ? idle : draft('check https://example.test/avery\nlongpath') });
assert.equal(r.result.accepted, true, 'soft wraps within a URL do not look like a different human draft');
r = await run({ text: 'fix it', screen: () => draft('fixit') });
assert.equal(r.result.accepted, false, 'meaningful spaces are not discarded when comparing drafts');
const quoted = 'Review this terminal report:\n• First finding\n› an example prompt\nThen fix the issue.';
r = await run({ text: quoted, screen: ({ enters }) => enters ? idle : draft(quoted) });
assert.equal(r.result.accepted, true, 'quoted terminal bullets and prompts inside an owned paste are valid text');

const order = [];
let release;
const gate = new Promise(resolve => { release = resolve; });
const first = serializeAgentInput('same-pane', async () => { order.push('first-start'); await gate; order.push('first-end'); });
const second = serializeAgentInput('same-pane', async () => { order.push('second'); });
await serializeAgentInput('other-pane', async () => { order.push('other'); });
assert.deepEqual(order, ['first-start', 'other'], 'different sessions remain independent');
release();
await Promise.all([first, second]);
assert.deepEqual(order, ['first-start', 'other', 'first-end', 'second'], 'one pane has ordered send transactions');
await assert.rejects(serializeAgentInput('same-pane', async () => { throw new Error('send failed'); }));
assert.equal(await serializeAgentInput('same-pane', async () => 'next'), 'next', 'a failed send releases the queue');
for (const reason of ['submit-unconfirmed', 'input-changed']) {
  let calls = 0;
  const response = await deliverVoiceFeedback({
    item: { sessionId: 'test', project: 'test' }, reply: { message: 'fix it' },
    getSession: () => ({ status: 'waiting' }), answeredElsewhere: () => false,
    deliverReply: async () => { calls++; return { inputBlocked: true, reason }; },
  });
  assert.equal(response.sent, false);
  assert.equal(response.retry, true);
  assert.equal(calls, 1, 'voice must not repaste after a bounded uncertain submit');
  assert.doesNotMatch(response.say, /Moving on|safe agent input box/);
}
console.log('agent_submit: passed');
