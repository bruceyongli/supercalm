import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'aios-story-http-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
Object.assign(process.env, { AIOS_DATA: join(root, 'data'), AIOS_WORKTREE_ROOT: join(root, 'worktrees'),
  AIOS_CODEX_SESSIONS_DIR: join(root, 'native'), AIOS_TMUX: '/usr/bin/false', AIOS_HOST: '127.0.0.1', AIOS_PORT: String(port), AIOS_SUMMARY_PORT: '1' });
delete process.env.AIOS_NO_LISTEN;
const uuid = '11111111-1111-4111-8111-111111111111';
const dir = join(root, 'native', '2026', '10', '31');
await mkdir(dir, { recursive: true });
const file = join(dir, `rollout-2026-10-31T10-00-00-${uuid}.jsonl`);
const row = (payload, n, type = 'response_item') => JSON.stringify({ type, timestamp: new Date(1700000000000 + n * 1000).toISOString(), payload }) + '\n';
const message = (role, text, n) => row({ type: 'message', role, phase: 'final_answer', content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] }, n);
let store;
try {
  await writeFile(file, message('user', 'Keep my complete report', 1)
    + row({ type: 'function_call_output', call_id: 'large', output: 'x'.repeat(9 * 1024 * 1024) }, 2)
    + message('assistant', 'Complete report, including [plan](plan.md)', 3));
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  store.createProject({ id: 'p_http', name: 'HTTP fixture', path: root });
  store.createSession({ id: 's_http', project_id: 'p_http', tool: 'codex', tmux: 'nonexistent-fixture', status: 'exited' });
  store.updateSession('s_http', { codex_uuid: uuid, status_reason: 'operator-kill' });
  const before = store.getSession('s_http');
  const get = async () => {
    const began = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/session/s_http/story`, { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('server-timing'), /source;dur=[\d.]+, stat;dur=[\d.]+/);
    const result = await res.json();
    assert.equal(result.sessionId, 's_http');
    assert.equal(result.meta.file, file);
    assert.ok(result.events.some(e => e.body === 'Complete report, including [plan](plan.md)'));
    return { result, ms: Math.round(performance.now() - began), timing: res.headers.get('server-timing') };
  };
  const cold = await get();
  await appendFile(file, message('user', 'Continue with the next step', 4));
  const fresh = await get();
  assert.ok(fresh.result.events.some(e => e.body === 'Continue with the next step'));
  assert.equal(fresh.result.meta.readMode, 'incremental');
  assert.ok(fresh.result.meta.ioBytes < 10000);
  const unchanged = await get();
  assert.equal(unchanged.result.meta.readMode, 'cached');
  assert.equal(unchanged.result.meta.ioBytes, 0, 'a cached payload must not report the previous request\'s IO');
  const after = store.getSession('s_http');
  assert.equal(after.codex_uuid, before.codex_uuid);
  assert.equal(after.last_activity, before.last_activity);
  assert.equal(after.status, before.status);
  await appendFile(file, row({ type: 'function_call', name: 'request_user_input_async', call_id: 'instant_question',
    arguments: JSON.stringify({ questions: [{ title: 'Which check?', options: ['Phone', 'Desktop'] },
      { title: 'Which scope?', options: ['Focused', 'All'] }] }) }, 5));
  const question = await get();
  assert.equal(question.result.events.filter(e => e.askId === 'instant_question' && !e.answered).length, 2);
  const stored = JSON.parse(store.getSession('s_http').structured_question);
  assert.equal(stored.id, 'instant_question', 'the real answers handler has durable identity before controls are returned');
  assert.deepEqual(stored.questions.map(q => q.question), ['Which check?', 'Which scope?']);
  console.log(JSON.stringify({ handler: 'real HTTP Story route', exactIdentity: true, fullReport: true,
    coldMs: cold.ms, appendMs: fresh.ms, appendIoBytes: fresh.result.meta.ioBytes, timing: fresh.timing }));
} finally {
  // Feature timers are process-scoped; stop before the disposable fixture can be reused.
  store?.db.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(0);
