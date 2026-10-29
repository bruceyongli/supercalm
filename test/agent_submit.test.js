import assert from 'node:assert/strict';
import { createAgentSubmission, serializeAgentInput, observeComposer } from '../src/agent_submit.js';
import { agentInputReady, operatorInputPlan, pendingComposerDraft } from '../src/agent_input_ready.js';
import { deliverVoiceFeedback } from '../src/voice_delivery.js';
import { CLAUDE_COMPOSER_FOOTER, claudePasteReady } from '../src/claude_composer.js';

const idle = '› Ask Codex to do anything\n\nGPT-6.1-Sol max · /fixture';
const draft = text => `› ${text}\n\nGPT-6.1-Sol max · /fixture`;
for (const hint of ['Ask Codex to do anything', 'Improve documentation in @filename']) {
  const screen = idle.replace('Ask Codex to do anything', hint);
  assert.equal(agentInputReady(screen), true);
  assert.equal(pendingComposerDraft(screen), null);
  assert.deepEqual(operatorInputPlan(screen, 'fix it'), { ready: true, target: 'composer' });
}
async function run({ screen, timeoutMs = 2400, ...options }) {
  let t = 0;
  const enters = [];
  const submit = createAgentSubmission({
    pasteCompleted: true, timeoutMs,
    clock: () => t, pause: async ms => { t += ms; },
    readScreen: async () => screen({ time: t, enters: enters.length }),
    pressEnter: async () => { enters.push(t); },
    ...options,
  });
  return { result: await submit(), enters, submit };
}
let r = await run({ screen: ({ enters }) => enters ? idle : draft('fix it') });
assert.equal(r.result.accepted, true); assert.equal(r.enters.length, 1);
assert.deepEqual(r.result.trace.map(t => t.phase), ['submitted', 'accepted']);
assert.equal((await r.submit()).accepted, true);
assert.equal(r.enters.length, 1, 'reusing a completed transaction cannot send twice');

// The payload was written as a complete bracketed paste. Presentation differences may NOT veto
// Enter, including the incident's Chinese wide-character wrapping, quotes, icons and path manifest.
for (const display of [
  '一些icon比如◔，请按设计实现。\nAttached files:\n/fixture/截图 01.06.00.png',
  '只剩下视口内的后半段', '[Pasted Content 9000 chars]', 'first row\n• quoted bullet\n› quoted prompt\nlast row',
  'Chinese 你\n好 emoji 🧪\n分割的URL https://exa\nmple.test/long', 'temporarily duplicated stale rows',
]) {
  r = await run({ screen: ({ enters }) => enters ? idle : draft(display) });
  assert.equal(r.result.accepted, true, display);
  assert.equal(r.enters.length, 1);
  assert.equal(r.enters[0], 320, 'complete transport write, not reconstructed pixels, authorizes submit');
}
r = await run({ screen: ({ enters }) => enters >= 2 ? idle : draft('wrapped/clipped view') });
assert.equal(r.result.accepted, true); assert.equal(r.enters.length, 2);
assert.ok(r.enters[1] - r.enters[0] >= 800);
r = await run({ screen: () => draft('request'), pasteCompleted: false });
assert.equal(r.enters.length, 0, 'unowned/partial writes cannot authorize submission');
assert.equal(r.result.reason, 'paste-unowned');
r = await run({ screen: () => draft('request') });
assert.equal(r.result.accepted, false); assert.equal(r.enters.length, 3);
assert.equal(r.result.reason, 'submit-unconfirmed');
r = await run({ screen: () => idle });
assert.equal(r.result.accepted, false, 'unchanged idle screen is never a receipt');
assert.equal(r.enters.length, 1, 'even delayed rendering gets its first ordered Enter, but no empty retry');
r = await run({ screen: () => 'Loading session…' });
assert.equal(r.enters.length, 1, 'complete write is not held hostage to screen capture');
assert.equal(r.result.accepted, false);
for (const screen of [
  'Choose a recovery path:\n› 1. Resume from summary\n  2. Resume full session as-is\nEnter to confirm',
  'Folder access\nTrust this folder?\n› 1. Trust and continue\n  2. Quit\nenter continue · esc quit',
  'Delete files? (y/n)',
]) {
  r = await run({ screen: () => screen });
  assert.equal(r.enters.length, 0, 'never blindly confirm a modal which replaced the composer');
}
let changed = false;
r = await run({ screen: ({ enters }) => { changed = enters > 0; return draft(changed ? 'new human draft' : 'our draft'); },
  inputUnchanged: () => !changed });
assert.equal(r.result.reason, 'input-changed'); assert.equal(r.enters.length, 1);
assert.equal((await r.submit()).reason, 'input-changed', 'an invalidated lease cannot be revived by retry');
r = await run({ screen: () => draft('request'), inputUnchanged: () => false });
assert.equal(r.enters.length, 0);
let native = false;
r = await run({ screen: ({ enters }) => { native = enters > 0; return 'redraw unrelated to contents'; },
  confirmSubmission: async () => native ? { receipt: 'native-queue', queued: true } : null });
assert.equal(r.result.accepted, true); assert.equal(r.result.queued, true);
assert.equal(r.enters.length, 1);
r = await run({ screen: ({ enters }) => enters ? idle : draft('request'), confirmSubmission: async () => null });
assert.equal(r.result.accepted, true, 'native image transformations/history-disabled modes retain verified composer-clear receipts');
assert.equal(r.result.receipt, 'composer-cleared');
assert.equal(r.enters.length, 1);
r = await run({ screen: () => draft('already accepted'), inputUnchanged: () => false,
  confirmSubmission: async () => ({ receipt: 'native-manual-enter' }) });
assert.equal(r.result.accepted, true); assert.equal(r.enters.length, 0, 'manual Enter wins before a stale lease');
let keyMayHaveLanded = false;
r = await run({ screen: () => draft('request'),
  pressEnter: async () => { keyMayHaveLanded = true; throw new Error('tmux timed out'); },
  confirmSubmission: async () => keyMayHaveLanded ? { receipt: 'native-after-timeout' } : null });
assert.equal(r.result.accepted, true, 'a transport timeout reconciles acknowledgement without a fresh paste');
assert.equal(r.result.attempts, 1);

// Claude-specific asynchronous image processing is a readiness adapter, not text reconstruction.
const claudeIdle = '❯\n  paste again to expand';
const chips = display => `❯ ${display}\n  paste again to expand`;
r = await run({ draftFooterPattern: CLAUDE_COMPOSER_FOOTER,
  pasteReady: view => claudePasteReady(view, 'Review /fixture/a.png and /fixture/b.png'),
  screen: ({ time, enters }) => enters ? claudeIdle : chips(time < 1200 ? '[Image #1][Image #2]' : '[Image #1][Image #2][Pasted text #3 +4 lines]') });
assert.equal(r.result.accepted, true); assert.equal(r.enters.length, 1);
assert.ok(r.enters[0] >= 1200, 'do not submit images before their associated text');
assert.deepEqual(observeComposer('no composer'), { kind: 'unknown' });

const order = [];
let release;
const gate = new Promise(resolve => { release = resolve; });
const first = serializeAgentInput('same-pane', async () => { order.push('first-start'); await gate; order.push('first-end'); });
const second = serializeAgentInput('same-pane', async () => { order.push('second'); });
await serializeAgentInput('other-pane', async () => { order.push('other'); });
assert.deepEqual(order, ['first-start', 'other']);
release(); await Promise.all([first, second]);
assert.deepEqual(order, ['first-start', 'other', 'first-end', 'second']);
await assert.rejects(serializeAgentInput('same-pane', async () => { throw new Error('send failed'); }));
assert.equal(await serializeAgentInput('same-pane', async () => 'next'), 'next');
for (const reason of ['submit-unconfirmed', 'input-changed']) {
  let calls = 0;
  const response = await deliverVoiceFeedback({
    item: { sessionId: 'test', project: 'test' }, reply: { message: 'fix it' },
    getSession: () => ({ status: 'waiting' }), answeredElsewhere: () => false,
    deliverReply: async () => { calls++; return { inputBlocked: true, reason }; },
  });
  assert.equal(response.sent, false); assert.equal(response.retry, true); assert.equal(calls, 1);
  assert.doesNotMatch(response.say, /Moving on|safe agent input box/);
}
console.log('agent_submit: transaction ownership, native receipt, Enter-only retry, modal/raw edit fencing and Claude adapter passed');
