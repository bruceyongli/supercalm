import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'aios-space-perf-'));
process.env.AIOS_DATA = join(root, 'data');
process.env.AIOS_USAGE_CODEX_DIR = join(root, 'rollouts');
process.env.AIOS_NO_LISTEN = '1';
const { readSpace, readSpaceWindow, readTranscriptRange } = await import('../src/session_space_reader.js');
const { buildSpace } = await import('../src/session_space_parser.js');
const store = await import('../src/store.js');
const { buildSessionSpace, ensureSessionSpace, sourceSliceFor } = await import('../src/session_space.js');
store.db.prepare('UPDATE label_meta SET enabled=0').run(); // No live model calls in a fixture test.
const record = (type, payload) => JSON.stringify({ type, timestamp: '2026-09-30T12:00:00Z', payload }) + '\n';
const request = label => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: label }] });
const call = label => record('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: label }) });
const usage = record('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } } });
const session = { id: 's_graph', tool: 'codex', title: 'Graph fixture', ended_at: Date.parse('2026-09-30T12:00:01Z') };
try {
  const file = join(root, 'large.jsonl');
  const prefix = record('response_item', { type: 'function_call_output', output: '旧'.repeat(900_000) });
  const tail = request('修复移动端加载') + call('rg mobile') + usage;
  await writeFile(file, prefix + tail);
  assert.equal((await readTranscriptRange(file)).length, 4096, 'locator reads only a head, even on a multi-megabyte file');
  const page = await readSpaceWindow({ file, session, maxBytes: 8192 });
  assert.equal(page.bytesRead, 8192);
  assert.equal(page.offset, Buffer.byteLength(prefix), 'partial first line is skipped and absolute UTF-8 offsets are retained');
  assert.equal(page.space.totals.requests, 1);
  assert.equal(page.space.totals.calls, 1);
  assert.equal(page.space.totals.tokens, 100);
  const system = page.space.systems[0];
  const turn = system.children[0].children[0];
  assert.equal(system.source.start, Buffer.byteLength(prefix));
  assert.equal((await readTranscriptRange(file, turn.source.start, turn.source.end - turn.source.start)).toString('utf8'), call('rg mobile'));
  const shifted = buildSpace(tail, session, Buffer.byteLength(prefix));
  assert.deepEqual(shifted.systems, page.space.systems, 'worker extraction preserves deterministic graph output');

  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const threaded = await readSpace({ file, session });
  clearInterval(timer);
  assert.ok(ticks > 1, 'large JSON parsing never monopolizes the HTTP thread');
  assert.equal(threaded.space.totals.calls, 1);
  assert.ok(threaded.bytesRead <= 32 * 1024 * 1024);

  const claude = join(root, 'claude.jsonl');
  await writeFile(claude, JSON.stringify({ type: 'user', message: { content: 'Improve scrolling' } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/fixture/mobile.js' } }], usage: { input_tokens: 80, output_tokens: 20 } } }) + '\n');
  const c = await readSpace({ file: claude, session: { ...session, tool: 'claude' } });
  assert.equal(c.space.totals.calls, 1);
  assert.equal(c.space.totals.tokens, 100);

  await mkdir(process.env.AIOS_USAGE_CODEX_DIR);
  const uuid = '11111111-2222-3333-4444-555555555555';
  const bound = join(process.env.AIOS_USAGE_CODEX_DIR, `rollout-2026-09-30T12-00-00-${uuid}.jsonl`);
  await writeFile(bound, record('session_meta', { cwd: '/different/worktree' }) + tail);
  const project = store.createProject({ id: 'p_graph', name: 'Fixture', path: '/fixture/project' });
  store.createSession({ ...session, project_id: project.id, tmux: 'fixture-never-started', status: 'exited' });
  const live = store.updateSession(session.id, { codex_uuid: uuid });
  const graph = await buildSessionSpace(live);
  assert.equal(graph.source_file, bound, 'conversation UUID locates a log even when cwd differs');
  const slice = await sourceSliceFor(live.id, graph.space.systems[0].children[0].children[0].id);
  assert.equal(slice.text, call('rg mobile'));
  const cached = await ensureSessionSpace(live);
  assert.equal(cached.built_at, graph.built_at, 'unchanged source only checks metadata, never reparses');
  const missing = await buildSessionSpace({ ...live, id: 's_missing', codex_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(missing.space, null, 'a missing bound log never falls back to a sibling conversation');
  const capturedClaude = await buildSessionSpace({ ...live, id: 's_claude', tool: 'claude', claude_transcript: claude });
  assert.equal(capturedClaude.source_file, claude, 'captured Claude hook identity avoids directory-wide searches');
  assert.equal(Math.round((await stat(bound)).mtimeMs), store.db.prepare('SELECT source_mtime FROM session_space WHERE session_id=?').get(live.id).source_mtime);
} finally {
  store.db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('session_space_performance: bounded I/O, off-thread parsing, absolute source links and authoritative identity passed');
