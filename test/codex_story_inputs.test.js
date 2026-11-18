import assert from 'node:assert/strict';
import { parseSessionLog, createSessionLogParser, trimToRecentRounds } from '../src/story.js';
import { reconcileStoryInputs, nativeInputEvidence } from '../src/story_inputs.js';

const base = 1794986600000;
const row = (n, payload, metadata) => ({ timestamp: new Date(base + n * 1000).toISOString(), type: 'response_item', payload, metadata });
const user = (n, text, id) => row(n, { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] });
const assistant = (n, text, phase = 'commentary', metadata) => row(n, { type: 'message', role: 'assistant', id: `assistant-${n}`,
  phase, content: [{ type: 'output_text', text }] }, metadata);
const event = (n, payload) => ({ ...row(n, payload), type: 'event_msg' });
const parse = rows => parseSessionLog(rows.map(r => JSON.stringify(r)).join('\n'));
const prefix = 'Please preserve the original messages. '.repeat(10);
const rows = [user(0, 'Previous request', 'previous'), assistant(1, 'Previous answer', 'final_answer'),
  user(2, prefix + 'Keep the first change.', 'first'), assistant(3, 'Checking.'),
  user(4, prefix + 'Also fix the second change.', 'second'),
  assistant(5, '## Active task\n\nInternal handoff, not the answer.', 'final_answer', { compaction_output: true, client_authored: false }),
  { ...row(6, { message: 'Internal summary', replacement_history: [user(0, 'Do not replay old input', 'old').payload] }), type: 'compacted' },
  assistant(7, 'Continuing with both requests.'),
];
const parsed = parse(rows);
assert.deepEqual(parsed.filter(e => e.kind === 'you').map(e => e.messageId), ['previous', 'first', 'second']);
assert.deepEqual(parsed.filter(e => e.kind === 'report').map(e => e.body), ['Previous answer'], 'native compaction flag excludes handoff without prose heuristics');
assert.ok(trimToRecentRounds(parsed, 1).events.some(e => e.body === 'Previous request'), 'compaction cannot complete the in-flight turn and page away its earlier request');
assert.ok(parse([assistant(0, '## Active task\n\nA real requested summary.', 'final_answer')]).some(e => e.kind === 'report'), 'ordinary summaries remain visible');
const incremental = createSessionLogParser();
for (let i = 0; i < rows.length; i++) {
  incremental.append(rows[i]);
  assert.deepEqual(incremental.events(), parse(rows.slice(0, i + 1)), 'batch/incremental provenance and interjections agree');
}
const mirrors = parse([event(0, { type: 'user_message', message: 'Continue' }), user(1, 'Continue', 'one'),
  user(2, 'Continue', 'two'), event(3, { type: 'user_message', message: 'Continue' }),
  user(4, 'Continue', 'two')]);
assert.deepEqual(mirrors.filter(e => e.kind === 'you').map(e => e.messageId), ['one', 'two'], 'mirrors dedupe but distinct identical sends survive');
assert.equal(parse([user(0, 'Continue'), user(1, 'Continue')]).filter(e => e.kind === 'you').length, 2, 'legacy repeated response-only sends survive');
assert.equal(parse([user(0, prefix + 'A'), user(1, prefix + 'B')]).filter(e => e.kind === 'you').length, 2, 'same-prefix requests never dedupe');
const attachment = path => 'Inspect this.\n\nAttached files available locally to this coding CLI:\n1. sample.txt (TXT, text/plain): ' + path;
assert.equal(parse([event(0, { type: 'user_message', message: attachment('/fixture/.aios/attachments/s_test/a-sample.txt') }),
  user(1, attachment('/fixture/.aios/attachments/s_test/b-sample.txt'), 'upload-b')]).filter(e => e.kind === 'you').length, 2, 'different uploads are not mirrors');

const saved = [2, 4].map((n, i) => ({ id: i + 1, ts: base + n * 1000, direction: 'in', source: 'text',
  text: rows[n].payload.content[0].text, client_message_id: `send-${i}`, delivery_state: 'sent' }));
const noInterjection = parse(rows.filter(r => r.payload.id !== 'second'));
const before = reconcileStoryInputs(noInterjection, saved, { receipts: nativeInputEvidence(noInterjection).inputReceipts });
assert.equal(before.events.find(e => e.inputMessageId === 2).delivery, 'sent', 'accepted mid-turn input survives absent native record');
const after = reconcileStoryInputs(parsed, saved, { receipts: nativeInputEvidence(parsed).inputReceipts });
assert.equal(after.events.find(e => e.inputMessageId === 2).delivery, 'read');
assert.equal(after.events.filter(e => e.body === saved[1].text).length, 1);
assert.deepEqual(after.readInputIds, [1, 2]);
console.log('codex_story_inputs: compaction provenance, same-prefix/repeated sends, mirrors, uploads and durable mid-turn input passed');
