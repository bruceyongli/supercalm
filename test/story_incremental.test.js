import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readStoryWindow, readStoryPage, readStoryImage } from '../src/story_reader.js';
import { parseSessionLog, trimToRecentRounds } from '../src/story.js';

const root = await mkdtemp(join(tmpdir(), 'aios-story-incremental-'));
let tick = 0;
const timestamp = () => new Date(1700000000000 + tick++ * 1000).toISOString();
const codex = payload => ({ timestamp: timestamp(), type: 'response_item', payload });
const event = payload => ({ timestamp: timestamp(), type: 'event_msg', payload });
const claude = (type, message, extra = {}) => ({ timestamp: timestamp(), type, message, ...extra });
const line = row => JSON.stringify(row) + '\n';
const plain = events => events.map(({ shotRef, ...e }) => e);
async function exercise(name, rows) {
  const file = join(root, name + '.jsonl'); let text = line(rows[0]);
  await writeFile(file, text); await readStoryPage({ file });
  for (const row of rows.slice(1)) {
    const added = line(row); text += added; await appendFile(file, added);
    const result = await readStoryPage({ file });
    assert.equal(result.meta.readMode, 'incremental', name + ': same worker retains native parser state');
    assert.deepEqual(plain(result.events), trimToRecentRounds(parseSessionLog(text), 1).events,
      name + ': incremental output must match the existing whole-window adapter');
    assert.ok(result.meta.ioBytes <= Buffer.byteLength(added) + 8192);
    assert.equal(result.meta.parsedRecords, 1, 'old tool results are never parsed again');
  }
  return file;
}
try {
  await exercise('codex', [
    event({ type: 'user_message', message: '修复页面，保留报告和附件。' }),
    codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复页面，保留报告和附件。' }] }),
    codex({ type: 'function_call', name: 'exec_command', call_id: 'grep', arguments: JSON.stringify({ cmd: 'rg missing' }) }),
    codex({ type: 'function_call_output', call_id: 'grep', output: JSON.stringify({ exit_code: 1, output: 'no match' }) }),
    codex({ type: 'function_call', name: 'request_user_input', call_id: 'ask', arguments: JSON.stringify({ questions: [{ id: 'a', question: 'Which?', options: [{ label: 'A', description: 'First' }] }] }) }),
    codex({ type: 'function_call_output', call_id: 'ask', output: '{"answers":{"a":"A"}}' }),
    codex({ type: 'message', role: 'assistant', id: 'm1', phase: 'commentary', content: [{ type: 'output_text', text: '检查中。' }] }),
    codex({ type: 'message', role: 'assistant', id: 'm2', phase: 'final_answer', content: [{ type: 'output_text', text: '## 修复完成\n\n[说明](plan.md)' }] }),
    event({ type: 'task_complete', last_agent_message: '## 修复完成\n\n[说明](plan.md)' }),
    event({ type: 'user_message', message: '下一步' }),
    event({ type: 'stream_error', message: 'Selected model is at capacity.', will_retry: false }),
    codex({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Next complete' }] }),
  ]);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.alloc(20000, 42).toString('base64') } };
  const cfile = await exercise('claude', [
    claude('user', { content: '修复布局' }, { uuid: 'user1' }),
    claude('assistant', { id: 'a', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'create', name: 'TaskCreate', input: { subject: 'Repair layout' } }] }),
    claude('user', { content: [{ type: 'tool_result', tool_use_id: 'create', content: 'Task #1 created successfully' }] }, { toolUseResult: { task: { id: '1', subject: 'Repair layout', status: 'pending' } } }),
    claude('assistant', { id: 'b', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Choose style', options: [{ label: 'Calm' }] }] } }] }),
    claude('user', { content: [{ type: 'tool_result', tool_use_id: 'ask', content: 'Your questions have been answered: "Choose style"="Calm"' }] }),
    claude('assistant', { id: 'c', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'shot', name: 'Bash', input: { command: 'inspect', description: 'Inspect layout' } }] }),
    claude('user', { content: [{ type: 'tool_result', tool_use_id: 'shot', content: [image] }] }),
    claude('assistant', { id: 'report', content: [{ type: 'text', text: '修复完成。' }] }, { apiBlockIndex: 0 }),
    claude('assistant', { id: 'report', stop_reason: 'end_turn', content: [{ type: 'text', text: '完整说明。' }] }, { apiBlockIndex: 1 }),
  ]);
  const picture = (await readStoryPage({ file: cfile })).events.find(e => e.shotRef);
  assert.ok(picture, 'an appended screenshot keeps its lazy reference');
  assert.equal((await readStoryImage({ file: cfile, ref: picture.shotRef })).data.length, 20000);

  const file = join(root, 'large.jsonl');
  const user = event({ type: 'user_message', message: 'A long-running task' });
  const tool = codex({ type: 'function_call_output', output: 'x'.repeat(9 * 1024 * 1024) });
  const report = codex({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] });
  await writeFile(file, line(user) + line(tool) + line(report));
  const cold = await readStoryWindow({ file });
  const addition = line(event({ type: 'user_message', message: 'Now keep going' }));
  await appendFile(file, addition);
  const warm = await readStoryWindow({ file });
  assert.equal(warm.meta.readMode, 'incremental');
  assert.ok(warm.meta.ioBytes < 10000, '9 MiB of old tool output becomes <10 KiB of anchor + append IO');
  assert.equal(warm.meta.parsedRecords, 1);
  assert.ok(warm.events.some(e => e.body === 'Done'), 'in-flight work keeps the previous completed report');
  console.log(JSON.stringify({ coldIoBytes: cold.meta.ioBytes, appendIoBytes: warm.meta.ioBytes, appendParsedRecords: warm.meta.parsedRecords }));

  const partial = line(codex({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '中文完整回复' }] }));
  const partialBytes = Buffer.from(partial), cut = partialBytes.indexOf(Buffer.from('中文')) + 1;
  await appendFile(file, partialBytes.subarray(0, cut));
  assert.equal((await readStoryWindow({ file })).events.some(e => e.body === '中文完整回复'), false);
  await appendFile(file, partialBytes.subarray(cut));
  const completed = await readStoryWindow({ file });
  assert.equal(completed.meta.readMode, 'incremental');
  assert.equal(completed.events.filter(e => e.body === '中文完整回复').length, 1, 'partial JSON and UTF-8 are retried from the last complete record');
  const same = await readStoryWindow({ file });
  assert.equal(same.meta.ioBytes, 0);
  assert.equal(same.meta.parsedRecords, 0);
  await rename(file, file + '.old');
  await writeFile(file, line(event({ type: 'user_message', message: 'New identity' })) + line(report));
  assert.equal((await readStoryWindow({ file })).events[0].body, 'New identity');
  await writeFile(file, line(event({ type: 'user_message', message: 'Rewritten same inode, longer content' })) + line(report));
  const rewritten = await readStoryWindow({ file });
  assert.equal(rewritten.meta.readMode, 'tail');
  assert.equal(rewritten.events[0].body, 'Rewritten same inode, longer content');
  await writeFile(file, line(user));
  assert.equal((await readStoryWindow({ file })).meta.readMode, 'tail', 'truncation discards state');
  const noNewline = line(report).trimEnd();
  await appendFile(file, noNewline);
  assert.equal((await readStoryWindow({ file })).events.filter(e => e.body === 'Done').length, 1);
  await appendFile(file, '\n');
  assert.equal((await readStoryWindow({ file })).events.filter(e => e.body === 'Done').length, 1,
    'a newline completing an already valid JSON record cannot duplicate its report');

  const oversized = join(root, 'oversized-state.jsonl');
  const big = codex({ type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'r'.repeat(9 * 1024 * 1024) }] });
  await writeFile(oversized, line(user) + line(big));
  const first = await readStoryWindow({ file: oversized });
  const second = await readStoryWindow({ file: oversized });
  assert.equal(second.meta.readMode, 'tail', 'oversized parser states are not retained in RAM');
  assert.equal(second.events.find(e => e.kind === 'report').body.length, 9 * 1024 * 1024,
    'the memory budget cannot truncate a human report');
  assert.deepEqual(second.events, first.events);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('story_incremental: Codex/Claude parity, native answers, mirrors, tasks, images, partial appends and rewrite fences passed');
