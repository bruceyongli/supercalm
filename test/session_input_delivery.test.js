import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const exec = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'aios-input-delivery-'));
const socket = `aios-input-${process.pid}`;
const wrapper = join(scratch, 'tmux.sh');
const realTmux = (await exec('which', ['tmux'])).stdout.trim();
const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
// Exec the real binary directly. A Node + spawnSync wrapper on every capture
// adds scheduling overhead to the production five-second confirmation window.
writeFileSync(wrapper, `#!/bin/sh\nTMUX='' exec ${shellQuote(realTmux)} -L ${shellQuote(socket)} "$@"\n`, { mode: 0o755 });
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
process.env.AIOS_DATA = join(scratch, 'data');
process.env.AIOS_TMUX = wrapper;
process.env.AIOS_HOST = '127.0.0.1';
process.env.AIOS_PORT = String(port);
process.env.AIOS_SUBMIT_DELAY = '30';
process.env.AIOS_CODEX_SESSIONS_DIR = join(scratch, 'codex');
mkdirSync(process.env.AIOS_CODEX_SESSIONS_DIR);
delete process.env.AIOS_NO_LISTEN;

let store;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  spawnSync(realTmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 3000 });
  try { store?.db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
// The parallel runner terminates siblings when a different suite fails. Private daemons and fixtures
// must also disappear on that path, not just on an ordinary pass or assertion failure.
process.once('exit', cleanup);
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
try {
  const { featureReady } = await import('../src/server.js');
  await featureReady;
  store = await import('../src/store.js');
  const { projectCheckpoint } = await import('../src/sessions.js');
  store.createProject({ id: 'p_checkpoint', name: 'isolated checkpoint fixture', path: scratch });
  let time = 0;
  const budgets = [];
  const runGit = async (root, args, options) => {
    budgets.push(options.timeout);
    if (args.includes('--is-inside-work-tree')) { time += 400; return { text: 'true', error: '' }; }
    return { text: '', error: '' };
  };
  await projectCheckpoint({ project_id: 'p_checkpoint' }, { runGit, clock: () => time });
  assert.deepEqual(budgets, [1000, 600, 600, 600], 'git metadata shares one short send-path budget');
  time = 0;
  assert.equal(await projectCheckpoint({ project_id: 'p_checkpoint' }, {
    clock: () => time, runGit: async () => { time = 1200; return { text: 'true', error: '' }; },
  }), null, 'expired optional bookkeeping is skipped before the prompt is sent');
  const fixture = fileURLToPath(new URL('./fixtures/submit_agent_tui.mjs', import.meta.url));
  async function start(name, mode, family, nativeFile = '', nativeId = '') {
    const trace = join(scratch, `${name}.ndjson`);
    // Ignore stdio so starting this private daemon cannot keep an execFile pipe open forever.
    await new Promise((resolve, reject) => {
      const child = spawn(wrapper, ['new-session', '-d', '-s', name, '-x', '100', '-y', '30',
        process.execPath, fixture, trace, mode, family, nativeFile, nativeId], { stdio: 'ignore' });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`tmux exit ${code}`)));
    });
    for (let i = 0; i < 40; i++) {
      const screen = (await exec(wrapper, ['capture-pane', '-p', '-t', name])).stdout;
      if (/GPT-6-Astra|bypass permissions|Enter to confirm/.test(screen)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
      if (i === 39) throw new Error('fixture never became ready');
    }
    store.createSession({ id: name, tool: family, tmux: name });
    store.updateSession(name, { status: 'waiting' });
    return () => readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  }
  async function send(id, text, options = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api/session/${id}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...options }),
    });
    return { status: response.status, body: await response.json() };
  }
  const onceId = 's_once_delivery';
  const onceTrace = await start(onceId, 'ignore-first', 'codex');
  const onceText = 'One operator send must reach the coding agent only once.';
  const onceKey = { client_message_id: 'send-once-fixture' };
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => send(onceId, onceText, onceKey)));
  assert.equal(concurrent.every(r => r.status === 200), true, JSON.stringify(concurrent));
  assert.equal(new Set(concurrent.map(r => r.body.message.id)).size, 1, 'concurrent HTTP retries share one stored receipt');
  const repeated = await send(onceId, onceText, onceKey);
  assert.equal(repeated.body.duplicate, true, 'a completed retry uses the durable receipt rather than sending again');
  assert.equal(repeated.body.message.id, concurrent[0].body.message.id);
  assert.deepEqual(onceTrace().filter(r => r.event === 'accepted').map(r => r.text), [onceText]);
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE session_id=? AND direction='in'").get(onceId).n, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE session_id=? AND type='input'").get(onceId).n, 1);
  const conflict = await send(onceId, 'Changed content may not reuse an accepted identity.', onceKey);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.reason, 'idempotency-conflict');
  assert.equal((await send(onceId, onceText, { client_message_id: 'send-new-fixture' })).status, 200);
  assert.equal(onceTrace().filter(r => r.event === 'accepted').length, 2, 'an intentional new send of identical words is not suppressed');
  assert.equal((await send(onceId, onceText, { client_message_id: '../bad' })).status, 400);
  console.log(JSON.stringify({ handler: 'POST /api/session/:id/input', scenario: 'five concurrent retries plus completed retry', requests: 6, accepted: 1, persisted: 1 }));
  const asyncId = 's_async_delivery';
  const asyncTrace = await start(asyncId, 'partial-paste', 'codex');
  const uuid = '12345678-1234-1234-1234-123456789abc';
  store.updateSession(asyncId, { status: 'working', codex_uuid: uuid });
  const nativeFile = join(process.env.AIOS_CODEX_SESSIONS_DIR, `rollout-test-${uuid}.jsonl`);
  const ask = { type: 'function_call', name: 'request_user_input_async', call_id: 'call_async_delivery',
    arguments: JSON.stringify({ questions: [{ title: 'Which runtime?', options: ['Node', 'Bun'] }, { title: 'Which checks?', options: ['Focused', 'Full'] }] }) };
  const nativeRow = payload => JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload }) + '\n';
  writeFileSync(nativeFile, nativeRow(ask) + nativeRow({ type: 'function_call_output', call_id: ask.call_id, output: '{"accepted":true}' }));
  const { refreshCodexQuestions } = await import('../src/codex_questions.js');
  await refreshCodexQuestions(store.getSession(asyncId));
  let home = await (await fetch(`http://127.0.0.1:${port}/api/phone/home`)).json();
  const attention = home.sessions.find(s => s.id === asyncId);
  assert.equal(attention.status, 'working', 'async attention does not invent a paused agent state');
  assert.equal(attention.pending_input, true);
  assert.equal(attention.category, 'decision');
  assert.equal(attention.unread, 1);
  assert.equal(attention.option_events.length, 2, 'home gets persisted choices without a transcript parse');
  let story = await (await fetch(`http://127.0.0.1:${port}/api/session/${asyncId}/story`)).json();
  assert.equal(story.events.filter(e => e.kind === 'ask' && !e.answered).length, 2);
  const answers = [{ ask_id: ask.call_id, question: 'Which runtime?', values: [{ label: 'Node' }] },
    { ask_id: ask.call_id, question: 'Which checks?', values: [{ label: 'Full' }] }];
  const sendAnswers = body => fetch(`http://127.0.0.1:${port}/api/session/${asyncId}/answers`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: body }),
  });
  assert.equal((await sendAnswers([{ ...answers[0], values: [{ label: 'Invented choice' }] }, answers[1]])).status, 409,
    'unrecognized/stale choices cannot be delivered');
  const asyncResponse = await sendAnswers(answers);
  assert.equal(asyncResponse.status, 200, await asyncResponse.text());
  const acceptedAsync = asyncTrace().filter(r => r.event === 'accepted');
  assert.deepEqual(acceptedAsync.map(r => r.text), ['Which runtime?: Node\nWhich checks?: Full'],
    'two async choices reach the native composer as one complete operator turn');
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE session_id=? AND direction='in'").get(asyncId).n, 1);
  assert.equal((await sendAnswers(answers)).status, 200, 'a lost acknowledgement replays the same receipt');
  assert.equal(asyncTrace().filter(r => r.event === 'accepted').length, 1, 'answer retry does not submit again');
  home = await (await fetch(`http://127.0.0.1:${port}/api/phone/home`)).json();
  assert.equal(home.sessions.find(s => s.id === asyncId).pending_input, false);
  assert.equal(home.sessions.find(s => s.id === asyncId).unread, 0);
  story = await (await fetch(`http://127.0.0.1:${port}/api/session/${asyncId}/story`)).json();
  assert.equal(story.events.filter(e => e.kind === 'ask' && !e.answered).length, 0,
    'another browser sees the accepted reply before Codex consumes its queued native turn');
  const newAsk = { ...ask, call_id: 'call_async_next', arguments: JSON.stringify({ questions: [{ title: 'New question?', options: ['Proceed', 'Wait'] }] }) };
  const partial = nativeRow(newAsk);
  appendFileSync(nativeFile, partial.slice(0, -8));
  await refreshCodexQuestions(store.getSession(asyncId));
  assert.equal(JSON.parse(store.getSession(asyncId).structured_question).id, ask.call_id, 'partial native writes do not invent a question');
  appendFileSync(nativeFile, partial.slice(-8));
  await refreshCodexQuestions(store.getSession(asyncId));
  assert.equal(JSON.parse(store.getSession(asyncId).structured_question).id, newAsk.call_id, 'the next complete native question reopens attention');
  assert.equal((await sendAnswers(answers)).status, 409, 'the old question cannot answer the new one');
  console.log(JSON.stringify({ handler: 'POST /api/session/:id/answers', nativeTool: ask.name,
    questions: 2, acknowledgementIsAnswer: false, acceptedNativeTurns: 1, persistedReplies: 1,
    delivered: acceptedAsync[0].text, crossDevicePendingAfterDelivery: false, staleReply: 409 }));
  for (const family of ['codex', 'claude']) {
    const sid = `s_${family}_delivery`;
    const trace = await start(sid, 'ignore-first', family);
    const message = `Deliver once to ${family}, even if the first Enter is ignored.`;
    const response = await send(sid, message);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const records = trace();
    assert.equal(records.filter(r => r.event === 'enter').length, 2);
    assert.deepEqual(records.filter(r => r.event === 'accepted').map(r => r.text), [message]);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE session_id=? AND direction='in'").get(sid).n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE session_id=? AND type='composer-draft-archived'").get(sid).n, 0,
      'idle placeholders never trigger draft replacement or extra HTTP requests');
    const receipt = JSON.parse(store.db.prepare("SELECT payload FROM events WHERE session_id=? AND type='input-delivery' ORDER BY id DESC LIMIT 1").get(sid).payload);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.attempts, 2);
    store.updateSession(sid, { status: 'waiting', question: 'Conversation interrupted — tell the model what to do differently.' });
    const idleStory = await (await fetch(`http://127.0.0.1:${port}/api/session/${sid}/story`)).json();
    assert.equal(idleStory.pendingQuestion, null, 'an idle/interrupted composer is not a Story question despite a stored waiting summary');
    console.log(JSON.stringify({ family, handler: 'POST /api/session/:id/input', http: response.status, enters: 2, accepted: 1, persisted: 1 }));
  }
  const queuedId = 's_claude_queued';
  const claudeUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const queuedFile = join(scratch, `${claudeUuid}.jsonl`);
  writeFileSync(queuedFile, '');
  const queuedTrace = await start(queuedId, 'claude-queued', 'claude', queuedFile, claudeUuid);
  store.updateSession(queuedId, { status: 'working', claude_transcript: queuedFile });
  const queuedMessage = 'Report the acceptance outcome while keeping the current work running.';
  const queuedResponse = await send(queuedId, queuedMessage, { client_message_id: 'claude-queued-proof' });
  assert.equal(queuedResponse.status, 200, JSON.stringify(queuedResponse.body));
  assert.equal(queuedResponse.body.queued, true, 'accepted native queue clears the web composer before the model reads it');
  assert.equal(queuedTrace().filter(r => r.event === 'enter').length, 1);
  assert.equal(queuedTrace().filter(r => r.event === 'accepted').length, 1);
  assert.equal((await send(queuedId, queuedMessage, { client_message_id: 'claude-queued-proof' })).body.duplicate, true);
  assert.equal(queuedTrace().filter(r => r.event === 'accepted').length, 1, 'queued receipt retry never pastes again');
  console.log(JSON.stringify({ family: 'claude', handler: 'POST /api/session/:id/input', native: 'queue-operation/enqueue',
    http: queuedResponse.status, queued: queuedResponse.body.queued, enters: 1, accepted: 1, receipt: 'claude-native-queue' }));
  const oldLongDraft = Array.from({ length: 33 }, (_, i) => `Old request line ${i}: 保留之前输入，不要拼进新问题。`).join('\n');
  const longId = 's_claude_long';
  const longTrace = await start(longId, 'claude-long-old', 'claude');
  store.updateSession(longId, { status: 'working' });
  const newShortMessage = "So, iteration 23, that's the one that we could claim we achieved our goal?";
  const longBlocked = await send(longId, newShortMessage, { client_message_id: 'claude-long-proof' });
  assert.equal(longBlocked.status, 409);
  assert.equal(longBlocked.body.reason, 'pending-draft', 'tall Claude draft is not mistaken for an active empty input');
  assert.equal(longTrace().filter(r => r.event === 'enter').length, 0);
  assert.equal(longTrace().filter(r => r.event === 'stash').length, 0);
  const longAccepted = await send(longId, newShortMessage, { client_message_id: 'claude-long-proof', replace_pending: true });
  assert.equal(longAccepted.status, 200, JSON.stringify(longAccepted.body));
  assert.deepEqual(longTrace().filter(r => r.event === 'accepted').map(r => r.text), [newShortMessage], 'only the new question reaches the CLI');
  assert.deepEqual(longTrace().filter(r => r.event === 'stash').map(r => r.text), [oldLongDraft], 'all 33 old lines stashed once without interrupting');
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE session_id=? AND type='composer-draft-archived'").get(longId).n, 1);
  assert.equal((await send(longId, newShortMessage, { client_message_id: 'claude-long-proof' })).body.duplicate, true);
  const nextShortMessage = 'Please explain the actual result.';
  assert.equal((await send(longId, nextShortMessage, { client_message_id: 'claude-next-proof' })).status, 200);
  assert.deepEqual(longTrace().filter(r => r.event === 'accepted').map(r => r.text), [newShortMessage, nextShortMessage], 'next send does not restore the old stash');
  assert.equal(longTrace().filter(r => r.event === 'stash').length, 1);
  console.log(JSON.stringify({ family: 'claude', handler: 'POST /api/session/:id/input', scenario: '33-line draft cropped by phone viewport',
    firstHTTP: 409, replacementHTTP: 200, stashes: 1, delivered: newShortMessage, oldTextMixedIn: false, retryDuplicates: 0, nextSend: 'clean' }));
  const sameLongId = 's_claude_same_long';
  const sameLongTrace = await start(sameLongId, 'claude-long-old', 'claude');
  assert.equal((await send(sameLongId, oldLongDraft)).status, 200);
  assert.equal(sameLongTrace().filter(r => r.event === 'stash').length, 0, 'same long draft gets Enter only');
  assert.deepEqual(sameLongTrace().filter(r => r.event === 'accepted').map(r => r.text), [oldLongDraft]);
  const noClearId = 's_claude_no_clear';
  const noClearTrace = await start(noClearId, 'claude-stash-blocked', 'claude');
  const noClear = await send(noClearId, newShortMessage, { replace_pending: true });
  assert.equal(noClear.status, 409);
  assert.equal(noClear.body.reason, 'draft-clear-unconfirmed');
  assert.equal(noClearTrace().filter(r => r.event === 'stash').length, 1);
  assert.equal(noClearTrace().filter(r => r.event === 'enter').length, 0, 'never submit if clear was not confirmed');
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE session_id=? AND direction='in'").get(noClearId).n, 0);
  const failLongId = 's_claude_long_fail';
  const failLongTrace = await start(failLongId, 'claude-long-fail', 'claude');
  const failLong = await send(failLongId, newShortMessage, { replace_pending: true });
  assert.equal(failLong.status, 409);
  assert.equal(failLong.body.reason, 'submit-unconfirmed');
  assert.equal(failLongTrace().filter(r => r.event === 'stash').length, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE session_id=? AND type='composer-draft-archived'").get(failLongId).n, 1, 'stashed old draft survives even when new submission fails');
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE session_id=? AND direction='in'").get(failLongId).n, 0);
  const partialId = 's_partial_delivery';
  const partialTrace = await start(partialId, 'partial-paste', 'codex');
  const multiline = 'where is the map html for each codebase, I want to inspect visually,\n\nDo you think better model will result a better reconstruction? Should we try gpt6-sol and deepseek-flash-next in parallel to do a side by side comparison of the 4 models?';
  const partialResponse = await send(partialId, multiline);
  assert.equal(partialResponse.status, 200, JSON.stringify(partialResponse.body));
  assert.equal(partialTrace().filter(r => r.event === 'premature').length, 0, 'never submit a partial paste');
  assert.deepEqual(partialTrace().filter(r => r.event === 'accepted').map(r => r.text), [multiline]);
  console.log(JSON.stringify({ handler: 'POST /api/session/:id/input', scenario: 'slow multiline paste', http: 200, enters: 1, accepted: 1 }));
  const redrawId = 's_redraw_delivery';
  const redrawTrace = await start(redrawId, 'redraw-paste', 'codex');
  const manifest = 'Check both screenshots.\n\nAttached files available locally to this coding CLI:\n1. screenshot.png (PNG, image/png): /project/attachments/screenshot.png\n2. other.png (PNG, image/png): /project/attachments/other.png\n\nOpen these paths directly when you need the uploaded content.';
  const redrawResponse = await send(redrawId, manifest);
  assert.equal(redrawResponse.status, 200, JSON.stringify(redrawResponse.body));
  assert.equal(redrawTrace().filter(r => r.event === 'premature').length, 0, 'no Enter on a half-painted manifest');
  assert.deepEqual(redrawTrace().filter(r => r.event === 'accepted').map(r => r.text), [manifest], 'the complete attachment request is accepted exactly once');
  assert.equal(redrawTrace().filter(r => r.event === 'enter').length, 2, 'a settled draft gets an Enter-only retry');
  console.log(JSON.stringify({ handler: 'POST /api/session/:id/input', scenario: 'half-painted attachment paste and ignored first Enter', http: 200, enters: 2, accepted: 1 }));
  await start('s_native_question', 'question', 'codex');
  store.updateSession('s_native_question', { question: 'outdated heuristic summary' });
  const header = await (await fetch(`http://127.0.0.1:${port}/api/session/s_native_question?surface=header`)).json();
  assert.equal(header.id, 's_native_question');
  assert.equal(header.tool, 'codex');
  assert.ok(Array.isArray(header.composer_history));
  for (const heavy of ['messages', 'events', 'snapshot']) assert.equal(heavy in header, false, `lean header omits ${heavy}`);
  for (let n = 0; n < 65; n++) store.addMessage('s_native_question', 'out', 'fixture', `Recent report ${n}`);
  const phone = await (await fetch(`http://127.0.0.1:${port}/api/session/s_native_question?surface=phone`)).json();
  assert.equal(phone.messages.length, 60);
  assert.equal(phone.messages.at(-1).text, 'Recent report 64', 'phone gets the newest reports, not the earliest 200 records');
  for (const heavy of ['events', 'snapshot']) assert.equal(heavy in phone, false, `phone omits ${heavy}`);
  const questionStory = await (await fetch(`http://127.0.0.1:${port}/api/session/s_native_question/story`)).json();
  assert.equal(questionStory.pendingQuestion?.body, 'Choose a recovery path:', 'a real terminal-only question still appears verbatim');
  assert.deepEqual(questionStory.pendingQuestion.options.map(o => o.label), ['Resume from summary', 'Resume full session as-is']);
  const blocked = 's_blocked_delivery';
  const trace = await start(blocked, 'ignore-all', 'codex');
  const response = await send(blocked, 'This must not be marked as sent.', { client_message_id: 'send-failed-fixture' });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'submit-unconfirmed');
  const blockedEnters = trace().filter(r => r.event === 'enter').length;
  // Real tmux captures take wall time. A loaded release host may reach the five-
  // second deadline before attempt three; the contract is bounded retries with
  // no false acceptance, not an exact retry count (covered by the fake-clock unit test).
  assert.ok(blockedEnters >= 1 && blockedEnters <= 3, `bounded retries: ${blockedEnters}`);
  assert.equal(trace().filter(r => r.event === 'accepted').length, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE session_id=? AND direction='in'").get(blocked).n, 0);
  assert.equal(store.inputReceipt(blocked, 'send-failed-fixture'), undefined, 'failed delivery never poisons a later retry identity');
  console.log(JSON.stringify({ handler: 'POST /api/session/:id/input', http: 409, reason: response.body.reason, enters: blockedEnters, accepted: 0, persisted: 0 }));
  console.log('session_input_delivery: passed (private tmux, no live sessions or projects modified)');
} finally {
  cleanup();
}
process.exit(0);
