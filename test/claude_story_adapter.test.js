import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionLog } from '../src/story.js';
import { readStoryPage } from '../src/story_reader.js';

// Claude Code 2.1.291's observed native JSONL envelope. No model/network/live DB required.
const row = (second, type, message, extra = {}) => JSON.stringify({
  type, timestamp: new Date(Date.UTC(2026, 9, 6, 8, 0, second)).toISOString(),
  version: '2.1.291', isSidechain: false, message, ...extra,
});
const text = (second, value, stop_reason, id = `msg_${second}`, apiBlockIndex = 0) =>
  row(second, 'assistant', { id, role: 'assistant', content: [{ type: 'text', text: value }], stop_reason }, { apiBlockIndex });
const call = (second, id, name, input) => row(second, 'assistant', {
  id: `call_${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }],
});
const result = (second, id, content, is_error = false, toolUseResult) => row(second, 'user', {
  role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }],
}, { toolUseResult });
const parse = rows => parseSessionLog(rows.join('\n'));

for (const reason of ['tool_use', 'pause_turn', 'max_tokens', 'stop_sequence']) {
  assert.equal(parse([text(0, 'Still checking.', reason)]).at(-1).kind, 'note', `${reason} never invents a completed report at a live tail`);
}
assert.equal(parse([text(0, 'Finished.', 'end_turn'), call(1, 'bg', 'Monitor', { description: 'Wait for the background trial' })])[0].kind,
  'report', 'end_turn remains a report even with later background work');
assert.equal(parse([text(0, 'Old unphased final.', undefined)]).at(-1).kind, 'report', 'old transcripts remain supported');

const split = parse([
  text(0, 'Partial', null, 'split', 1), text(1, 'Complete first paragraph.', 'end_turn', 'split', 1),
  text(2, 'Second paragraph.', 'end_turn', 'split', 2),
  text(3, 'Second paragraph.', 'end_turn', 'split', 2),
  text(4, 'Second paragraph.', 'end_turn', 'different', 1),
]);
assert.equal(split.length, 2, 'rewritten/replayed API blocks yield one report per message, not duplicated paragraphs');
assert.equal(split[0].body, 'Complete first paragraph.\n\nSecond paragraph.');
assert.ok(split[0].messageId && split[0].messageId !== split[1].messageId, 'identities distinguish real repeated wording');
assert.equal(parse([row(0, 'assistant', { id: 'multi', stop_reason: 'end_turn', content: [
  { type: 'text', text: 'First.' }, { type: 'text', text: 'Second.' },
] }, { apiBlockIndex: 0 })])[0].body, 'First.\n\nSecond.', 'a multi-block envelope never overwrites its first paragraph');
const staleReplay = parse([text(0, 'Partial.', 'tool_use', 'replay', 1), text(1, 'Complete.', 'end_turn', 'replay', 1),
  text(0, 'Partial.', 'tool_use', 'replay', 1)]);
assert.equal(staleReplay[0].body, 'Complete.');
assert.equal(staleReplay[0].kind, 'report', 'replayed earlier blocks cannot roll a completed report backward');
assert.doesNotThrow(() => parse([row(0, 'assistant', { content: { unexpected: true } })]), 'unknown content envelopes do not crash Story');
assert.equal(parse([row(0, 'assistant', { content: 'String report.', stop_reason: 'end_turn' })])[0].body, 'String report.');
const user = parse([row(0, 'user', { content: [{ type: 'text', text: 'Fix the parser.' }, { type: 'text', text: 'Keep my reports.' }] })]);
assert.equal(user.length, 1, 'one native operator message with multiple blocks is one bubble');
assert.equal(user[0].body, 'Fix the parser.\n\nKeep my reports.');
const queuedUser = row(3, 'attachment', undefined, { uuid: 'attachment-copy', attachment: {
  type: 'queued_command', prompt: 'Report when acceptance is done.', origin: { kind: 'human' },
  commandMode: 'prompt', humanTurn: true, source_uuid: 'operator-message', delivery_id: 'delivery-1',
  timestamp: new Date(Date.UTC(2026, 9, 6, 8, 0, 2)).toISOString(),
} });
const queuedEvents = parse([queuedUser, queuedUser, row(4, 'user', { content: 'Report when acceptance is done.' }, { uuid: 'operator-message' }),
  row(5, 'attachment', undefined, { attachment: { type: 'queued_command', prompt: 'Background task completed.', origin: { kind: 'task-notification' } } }),
  row(6, 'user', { content: 'A background task completed.' }, { promptSource: 'system', origin: { kind: 'task-notification' } })]);
assert.equal(queuedEvents.length, 1, 'consumed human mid-turn input appears once; automated notifications are not operator input');
assert.equal(queuedEvents[0].body, 'Report when acceptance is done.');
assert.equal(queuedEvents[0].ts, Date.UTC(2026, 9, 6, 8, 0, 2), 'the original enqueue timestamp survives delivery');
assert.equal(parse([row(0, 'assistant', { id: 'api-error', content: 'API Error: billing required', stop_reason: 'end_turn' },
  { isApiErrorMessage: true })])[0].kind, 'fail', 'an API failure is not a completed report');
assert.equal(parse([call(0, 'handback', 'SubagentHandback', { message: 'The parser loses queued human messages.' })])[0].body,
  'The parser loses queued human messages.', 'native helper handback content remains inspectable');

const failureOutput = 'Exit code 1\nok\nimport ok\nTraceback (most recent call last):\n  File "sample.py", line 29\nTypeError: argument of type NoneType is not iterable';
const operations = parse([
  call(0, 'read', 'Bash', { command: 'sed -n 1,60p sample.py', description: 'Read the consensus tails of the three stages' }),
  call(1, 'check', 'Bash', { command: 'python sample.py', description: 'Test the list parser' }),
  call(2, 'check', 'Bash', { command: 'python sample.py', description: 'Test the list parser' }),
  result(3, 'read', 'ok'), result(4, 'check', failureOutput, true),
]);
assert.equal(operations[0].title, 'Test the list parser', 'specific CLI description survives the generic cluster headline');
assert.equal(operations[0].steps.length, 2, 'a replayed tool id is not another step');
const fail = operations.find(e => e.kind === 'fail');
assert.equal(fail.title, 'Failed: Test the list parser', 'parallel result attributed by tool_use_id, not nearest/previous call');
assert.equal(fail.exitCode, 1);
assert.equal(fail.body, 'TypeError: argument of type NoneType is not iterable', 'the real diagnostic replaces Exit code 1 · ok');
assert.equal(fail.steps[0].cmd, 'python sample.py');
assert.equal(fail.steps[0].output, failureOutput, 'bounded original output remains available for inspection');
const huge = parse([result(0, 'unknown', 'x'.repeat(12000) + '\nError: useful tail', true)])[0];
assert.equal(huge.body, 'Error: useful tail');
assert.equal(huge.steps[0].output.length, 8000, 'tool output is bounded even on long results');
assert.equal(parse([result(0, 'shell', 'Exit code 1\nsource\n(eval):1: ===== not found', true)])[0].body, '(eval):1: ===== not found');
assert.equal(parse([result(0, 'blocked', '<tool_use_error>Blocked: sleep 240 followed by: long command\ncontinued command</tool_use_error>', true)])[0].body,
  'Blocked: sleep 240', 'CLI policy errors show the reason, not a fragment of the quoted command');
assert.equal(parse([call(0, 'file', 'Write', { file_path: '/approved/atlas.py' })])[0].title,
  'Edited a file (atlas.py)', 'file tools without descriptions retain the file being changed');
assert.equal(parse([call(0, 'helper', 'Agent', { description: 'Investigate the parser regression' })])[0].kind, 'sub', 'new Agent tool retains subagent semantics');
assert.equal(parse([call(0, 'new', 'NewTool', {})])[0].title, 'NewTool', 'unknown tools remain visible rather than mislabeled as code reading');

const tasks = parse([
  call(0, 'create', 'TaskCreate', { subject: 'Repair the Story adapter' }),
  result(1, 'create', 'Created.', false, { task: { id: '1', subject: 'Repair the Story adapter', status: 'pending' } }),
  call(2, 'working', 'TaskUpdate', { taskId: '1', status: 'in_progress' }), result(3, 'working', 'Updated.'),
  call(4, 'failed', 'TaskUpdate', { taskId: '1', status: 'completed' }), result(5, 'failed', 'Error: update rejected', true),
  call(6, 'complete', 'TaskUpdate', { taskId: '1', status: 'completed' }), result(7, 'complete', 'Updated.'),
  call(8, 'delete', 'TaskUpdate', { taskId: '1', status: 'deleted' }), result(9, 'delete', 'Deleted.'),
]);
assert.deepEqual(tasks.filter(e => e.kind === 'plan').map(e => e.planItems?.[0]?.status),
  ['pending', 'in_progress', undefined, 'completed', undefined], 'task mutations update a checklist only after successful results');
assert.deepEqual(tasks.at(-1).planItems, [], 'deleted last task is not resurrected');
assert.equal(parse([call(0, 'legacy-create', 'TaskCreate', { subject: 'Verify compatibility' }),
  result(1, 'legacy-create', 'Task #2 created successfully: Verify compatibility')])[0].planItems[0].text, 'Verify compatibility');
assert.equal(parse([call(0, 'pending', 'TaskCreate', { subject: 'Wait for result' })])[0].title, 'Wait for result', 'pending/unknown task output does not vanish');
assert.deepEqual(parse([call(0, 'list', 'TaskList', {}), result(1, 'list', 'Listed.', false,
  { tasks: [{ id: '8', subject: 'Publish the fix', status: 'completed' }] })])[0].planItems,
[{ text: 'Publish the fix', status: 'completed' }], 'a tail-page task inventory recovers its actual subjects');
assert.doesNotThrow(() => parse([call(0, 'unknown-list', 'TaskList', {}), result(1, 'unknown-list', 'Unknown.', false, { tasks: {} })]),
  'an unknown task-result shape stays inspectable instead of crashing the whole Story');
const helperCall = JSON.parse(call(2, 'helper-create', 'TaskCreate', { subject: 'Helper task' }));
helperCall.isSidechain = true; helperCall.agentId = 'helper';
const isolatedTasks = parse([call(0, 'main-create', 'TaskCreate', { subject: 'Main task' }),
  result(1, 'main-create', 'Created.', false, { task: { id: '1', subject: 'Main task' } }), JSON.stringify(helperCall),
  result(3, 'helper-create', 'Created.', false, { task: { id: '1', subject: 'Helper task' } }),
  call(4, 'main-update', 'TaskUpdate', { taskId: '1', status: 'completed' }), result(5, 'main-update', 'Updated.')]);
assert.deepEqual(isolatedTasks.at(-1).planItems, [{ text: 'Main task', status: 'completed' }], 'helper task ids do not overwrite the main checklist');

const questions = { questions: [
  { question: 'Which approach?', header: 'Approach', options: [{ label: 'A' }, { label: 'B' }] },
  { question: 'Which targets?', header: 'Targets', options: [{ label: 'Phone' }, { label: 'Tablet' }], multiSelect: true },
] };
const asked = call(0, 'ask', 'AskUserQuestion', questions);
const answered = parse([asked, result(1, 'ask', 'Answered.', false, { answers: { 'Which approach?': 'B', 'Which targets?': ['Phone', 'Tablet'] } })]);
assert.deepEqual(answered.map(e => e.answeredWith), ['B', 'Phone, Tablet']);
assert.ok(answered.every(e => e.answered), 'structured native answers survive reopening without local browser state');
const partial = parse([asked, result(1, 'ask', 'Answered.', false, { answers: { 'Which approach?': 'A' } }),
  row(2, 'user', { content: 'Wait a moment.' })]);
assert.equal(partial[0].answered, true);
assert.ok(!partial[1].answered, 'an unrelated operator message is not proof that the remaining question was answered');
const cancelled = parse([asked, result(1, 'ask', 'User cancelled the question.', true)]);
assert.ok(cancelled.filter(e => e.kind === 'ask').every(e => e.cancelled && e.answered), 'cancelled prompts no longer present actionable stale options');
assert.ok(parse([asked, call(1, 'ask', 'AskUserQuestion', { ...questions, answers: { 'Which approach?': 'B' } })])[0].answered,
  'resumed updatedInput answers are recognized without replaying the prompt');

const dir = await mkdtemp(join(tmpdir(), 'aios-claude-story-'));
try {
  const file = join(dir, 'native.jsonl');
  await writeFile(file, [row(0, 'user', { content: 'Previous request.' }), text(1, 'Previous report.', 'end_turn'),
    row(2, 'user', { content: 'Current request.' }), text(3, 'Still investigating.', 'tool_use')].join('\n') + '\n');
  const page = await readStoryPage({ file, rounds: 1 });
  assert.equal(page.events.filter(e => e.kind === 'report').length, 1);
  assert.equal(page.events.at(-1).kind, 'note', 'actual reader-worker paging does not promote a live commentary tail');
  assert.equal(page.events[0].body, 'Previous request.', 'previous completed exchange remains loaded while a new request is in flight');
  await writeFile(file, [row(0, 'user', { content: 'Previous request.' }), text(1, 'Previous report.', 'end_turn'), queuedUser,
    text(4, 'Latest report.', 'end_turn')].join('\n') + '\n');
  const queuedPage = await readStoryPage({ file, rounds: 1 });
  assert.equal(queuedPage.events[0].body, 'Report when acceptance is done.', 'pagination recognizes the queued human conversation boundary');
  const older = await readStoryPage({ file, cursor: queuedPage.meta.cursor, rounds: 1 });
  assert.equal(older.events[0].body, 'Previous request.', 'older pagination neither repeats nor skips the queued round');
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('claude_story_adapter: native 2.1.291 reports/blocks/tools/tasks/questions/errors and worker paging passed');
