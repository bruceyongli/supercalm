import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = await mkdtemp(join(tmpdir(), 'aios-model-bridge-'));
const captures = [];
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  captures.push({ path: req.url, headers: req.headers, body });
  if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 3 })); return; }
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'); return;
  }
  res.end(JSON.stringify({ type: 'message', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
});
let agyCalls = 0;
const agy = createServer((req, res) => { agyCalls++; res.writeHead(403); res.end('Wrong provider'); });
const probe = createServer();
for (const server of [mock, agy, probe]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
process.env.AIOS_DATA = join(dir, 'data'); process.env.AIOS_WORKTREE_ROOT = join(dir, 'worktrees');
process.env.AIOS_TMUX = '/usr/bin/false'; process.env.AIOS_HOST = '127.0.0.1'; process.env.AIOS_PORT = String(port);
process.env.AIOS_PROXY_KEY = 'bridge-fixture-key'; delete process.env.AIOS_NO_LISTEN;
const request = (path, body) => fetch(`http://127.0.0.1:${port}/api/cli-proxy/v1/${path}`, body ? {
  method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': 'tools-test' }, body: JSON.stringify(body),
} : {});
let store;
try {
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  const { applyCatalog } = await import('../src/model_catalog.js');
  const { scanProvider } = await import('../src/model_inventory.js');
  const retained = await scanProvider({ proxy: 'claude', port: mock.address().port, nativeFor: ['claude'], up: true,
    inventoryFilter: 'latest', models: [{ id: 'claude-opus-5-5' }] }, null, 'fixture', {
    fetcher: async () => new Response('temporarily unavailable', { status: 503 }),
  });
  applyCatalog([{ proxy: 'antigravity', port: agy.address().port, models: [{ id: 'claude-opus-5-5' }] }, retained,
    { proxy: 'codex', port: mock.address().port, models: [{ id: 'gpt-6.1-sol' }] }]);
  const inventory = await (await request('models')).json();
  assert.ok(inventory.data.some(m => m.id === 'claude-opus-5-5'), 'real CLI discovery handler retains models during outage');
  const body = { model: 'claude-opus-5-6', max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK.' }],
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } };
  let res = await request('messages', body);
  assert.equal(res.status, 200); assert.equal((await res.json()).model, body.model);
  assert.deepEqual(captures[0].body, body, 'exact model, prompt and context edits preserved');
  assert.equal(captures[0].path, '/v1/messages');
  assert.equal(captures[0].headers['anthropic-beta'], 'tools-test,context-management-2025-06-27');
  assert.equal(captures[0].headers.authorization, 'Bearer bridge-fixture-key');
  res = await request('messages/count_tokens', body);
  assert.equal(res.status, 200); assert.equal((await res.json()).input_tokens, 3);
  assert.equal(captures.at(-1).headers['anthropic-beta'], 'tools-test,context-management-2025-06-27');
  res = await request('messages', { ...body, model: 'claude-opus-5-5', stream: true });
  assert.equal(res.status, 200); assert.match(await res.text(), /event: message_stop/);
  const codexBody = { model: 'gpt-6.1-sol', input: 'Hello', reasoning: { effort: 'xhigh' } };
  res = await request('responses', codexBody); assert.equal(res.status, 200); await res.json();
  assert.deepEqual(captures.at(-1).body, codexBody, 'Codex native payload unchanged');
  assert.equal(captures.at(-1).path, '/v1/responses');
  assert.equal(captures.at(-1).headers['anthropic-beta'], undefined);
  const before = captures.length;
  for (const path of ['messages', 'messages/count_tokens', 'chat/completions', 'responses']) {
    res = await request(path, { ...body, model: 'unknown-route' });
    assert.equal(res.status, 400); assert.equal((await res.json()).error.code, 'unknown_model_route');
  }
  assert.equal(captures.length, before, 'unknown requests rejected before network dispatch');
  assert.equal(agyCalls, 0, 'no implicit AGY requests');
  console.log(JSON.stringify({ handler: '/api/cli-proxy/v1/messages', model: body.model, upstream: 'isolated Claude mock',
    catalogAfter503: 'retained', contextEdits: 'preserved', requiredBeta: 'present', streaming: 'passed through',
    codexPayload: 'unchanged', unknownRoute: '400 before dispatch', agyCalls, liveSessionsTouched: false }));
} finally {
  for (const server of [mock, agy]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  store?.db.close(); await rm(dir, { recursive: true, force: true });
}
process.exit(0);
