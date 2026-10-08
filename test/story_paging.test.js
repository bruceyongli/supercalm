import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoryPage, readStoryWindow } from '../src/story_reader.js';

const root = await mkdtemp(join(tmpdir(), 'aios-story-paging-'));
const ts = n => new Date(1_700_000_000_000 + n * 10_000).toISOString();
const record = (n, type, payload) => JSON.stringify({ timestamp: ts(n), type, payload }) + '\n';
const request = n => record(n * 3, 'event_msg', { type: 'user_message', message: `Request ${n}` })
  + record(n * 3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Request ${n}` }] });
const report = n => record(n * 3 + 2, 'response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `Report ${n}` }] });
try {
  const file = join(root, 'codex.jsonl');
  await writeFile(file, Array.from({ length: 25 }, (_, n) => request(n) + record(n * 3 + 1, 'response_item', {
    type: 'function_call_output', call_id: `tool_${n}`, output: 'x'.repeat(20_000),
  }) + report(n)).join('') + request(25));
  const latest = await readStoryPage({ file });
  assert.deepEqual(latest.events.filter(e => e.kind === 'you').map(e => e.body), ['Request 24', 'Request 25']);
  assert.deepEqual(latest.events.filter(e => e.kind === 'report').map(e => e.body), ['Report 24']);
  assert.ok(latest.meta.scannedBytes < latest.meta.totalBytes, 'initial view reads a tail, not the entire transcript');
  let cursor = latest.meta.cursor, previousOffset = Infinity;
  const seen = [];
  while (cursor) {
    const offset = JSON.parse(Buffer.from(cursor, 'base64url')).offset;
    assert.ok(offset < previousOffset, 'each page progresses toward the beginning');
    previousOffset = offset;
    const page = await readStoryPage({ file, cursor });
    const reports = page.events.filter(e => e.kind === 'report');
    assert.equal(reports.length, 1, 'exactly one earlier exchange per page');
    assert.equal(page.events.filter(e => e.kind === 'you').length, 1, 'mirrored user records never straddle pages');
    seen.push(reports[0].body);
    cursor = page.meta.cursor;
  }
  assert.deepEqual(seen, Array.from({ length: 24 }, (_, i) => `Report ${23 - i}`));
  const before = await readStoryWindow({ file, cursor: latest.meta.cursor });
  await appendFile(file, report(25) + request(26));
  const after = await readStoryWindow({ file, cursor: latest.meta.cursor });
  assert.deepEqual(after.events, before.events, 'appended activity cannot shift an earlier cursor page');
  const other = join(root, 'other.jsonl'); await writeFile(other, request(0) + report(0));
  await assert.rejects(readStoryPage({ file: other, cursor: latest.meta.cursor }), { code: 'STORY_CURSOR_INVALID' });

  const huge = join(root, 'huge.jsonl');
  await writeFile(huge, request(0) + record(1, 'response_item', { type: 'function_call_output', output: 'y'.repeat(9_000_000) }) + report(0));
  let ticks = 0;
  const interval = setInterval(() => ticks++, 1);
  const bigPage = await readStoryPage({ file: huge });
  clearInterval(interval);
  assert.ok(ticks > 1, 'large tool-result parsing runs off the event loop');
  assert.equal(bigPage.events.find(e => e.kind === 'you')?.body, 'Request 0', 'a giant partial JSONL line does not hide the request');
  assert.equal(bigPage.events.find(e => e.kind === 'report')?.body, 'Report 0');
  const oversized = join(root, 'oversized.jsonl');
  await writeFile(oversized, request(0) + record(1, 'response_item', { type: 'function_call_output', output: 'z'.repeat(34 * 1024 * 1024) }) + report(0));
  let large = await readStoryPage({ file: oversized }), prior = Infinity;
  while (large.meta.cursor) {
    const offset = JSON.parse(Buffer.from(large.meta.cursor, 'base64url')).offset;
    assert.ok(offset < prior, 'even an oversized tool-result line cannot trap the cursor on an empty page');
    prior = offset;
    large = await readStoryPage({ file: oversized, cursor: large.meta.cursor });
  }
  assert.equal(large.events.find(e => e.kind === 'you')?.body, 'Request 0');

  const claude = join(root, 'claude.jsonl');
  await writeFile(claude, Array.from({ length: 3 }, (_, n) =>
    JSON.stringify({ timestamp: ts(n * 2), type: 'user', message: { content: `Claude request ${n}` } }) + '\n'
    + JSON.stringify({ timestamp: ts(n * 2 + 1), type: 'assistant', message: { content: [{ type: 'text', text: `Claude report ${n}` }] } }) + '\n').join(''));
  const c = await readStoryPage({ file: claude });
  assert.equal(c.events.filter(e => e.kind === 'report').length, 1);
  const cp = await readStoryPage({ file: claude, cursor: c.meta.cursor });
  assert.equal(cp.events.find(e => e.kind === 'report')?.body, 'Claude report 1');

  const helpers = join(root, 'claude-helpers.jsonl');
  const native = (n, type, text, isSidechain = false) => JSON.stringify({ timestamp: ts(n), type, isSidechain,
    message: { id: `helper-${n}`, content: text, stop_reason: type === 'assistant' ? 'end_turn' : undefined } }) + '\n';
  await writeFile(helpers, native(0, 'user', 'Previous operator request')
    + native(1, 'assistant', 'Previous completed report')
    + native(2, 'user', 'Current operator request')
    + native(3, 'user', 'Machine instruction to a helper', true)
    + native(4, 'assistant', 'Helper completed its own work', true));
  const helperPage = await readStoryPage({ file: helpers });
  assert.deepEqual(helperPage.events.filter(e=>e.kind==='you'&&!e.indent).map(e=>e.body), ['Previous operator request', 'Current operator request'],
    'a helper request/completion cannot close the parent round or hide its previous report');
  assert.equal(helperPage.events.find(e=>e.body==='Machine instruction to a helper')?.indent, true);
  assert.equal(helperPage.events.find(e=>e.body==='Previous completed report')?.kind, 'report');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('story_paging: bounded cursor pages, concurrent append, identity and non-blocking parsing passed');
