import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import http from 'node:http';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-prov-'));

const { listProviders, upsertProvider, deleteProvider, normalizeBase, providerRoutes, probeProvider } = await import('../src/model_providers.js');
const { routeForModel, listProxyModels, userRoutes } = await import('../src/model_catalog.js');
const { callProxyModel, isVisionRoute } = await import('../src/agents/model.js');

// ---- normalize + CRUD + redaction ------------------------------------------------------------------
{
  assert.equal(normalizeBase('', 'anthropic'), 'https://api.anthropic.com');
  assert.equal(normalizeBase('api.openai.com/v1/', 'openai'), 'https://api.openai.com');
  assert.equal(normalizeBase('http://127.0.0.1:9999/v1', 'openai'), 'http://127.0.0.1:9999');

  const p = upsertProvider({ name: 'TestProv', kind: 'openai', base_url: 'http://127.0.0.1:9999', api_key: 'sk-secret-123', models: ['m-one', 'm-two'] });
  assert.equal(p.key_set, true);
  assert.equal(p.api_key, undefined, 'list output NEVER carries the key');
  const file = join(process.env.AIOS_DATA, 'model_providers.json');
  assert.match(await readFile(file, 'utf8'), /sk-secret-123/, 'key persists on disk');
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, 'provider file is chmod 600');
  assert.throws(() => upsertProvider({ name: 'x', kind: 'bogus', base_url: 'http://x', api_key: 'k' }), /kind/);
  assert.throws(() => upsertProvider({ name: 'x', kind: 'openai', base_url: 'http://x' }), /api_key/);
}

// ---- catalog integration: routeForModel + listings -------------------------------------------------
{
  const r = routeForModel('m-one');
  assert.equal(r.proxy, 'api');
  assert.equal(r.base, 'http://127.0.0.1:9999');
  assert.equal(r.key, 'sk-secret-123');
  assert.equal(r.kind, 'openai');
  const pref = routeForModel('testprov/m-two');
  assert.equal(pref?.model, 'm-two', 'provider-prefixed id resolves');
  assert.ok(listProxyModels().some((m) => m.id === 'm-one' && m.provider === 'api'), 'user models ride the listings');
  assert.equal(isVisionRoute(r), false, 'api routes are text-only in v1');
  assert.equal(userRoutes().length, 2);
}

// ---- transport: openai-compatible + anthropic-native against a local mock --------------------------
{
  const seen = [];
  const mock = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization || '', xkey: req.headers['x-api-key'] || '', body: JSON.parse(b || '{}') });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/chat/completions') {
        res.end(JSON.stringify({ model: 'm-one', choices: [{ message: { role: 'assistant', content: 'openai-style reply' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
      } else if (req.url === '/v1/messages') {
        res.end(JSON.stringify({ model: 'claude-x', content: [{ type: 'text', text: 'anthropic-style reply' }], usage: { input_tokens: 7, output_tokens: 2 } }));
      } else if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((ok) => mock.listen(9999, '127.0.0.1', ok));

  const out = await callProxyModel(routeForModel('m-one'), [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(out.content, 'openai-style reply');
  assert.equal(seen[0].auth, 'Bearer sk-secret-123', 'openai kind sends the provider key as bearer');

  upsertProvider({ name: 'AnthTest', kind: 'anthropic', base_url: 'http://127.0.0.1:9999', api_key: 'sk-ant-9', models: ['claude-x'] });
  const r2 = routeForModel('claude-x');
  assert.equal(r2.kind, 'anthropic');
  const out2 = await callProxyModel(r2, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: [{ type: 'text', text: 'multimodal' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
  ]);
  assert.equal(out2.content, 'anthropic-style reply');
  const call = seen.find((x) => x.path === '/v1/messages');
  assert.equal(call.xkey, 'sk-ant-9', 'anthropic kind uses x-api-key');
  assert.equal(call.body.system, 'be terse', 'system split out natively');
  assert.equal(call.body.messages[0].content, 'multimodal', 'multimodal flattened to text (v1 transport)');
  assert.equal(out2.usage.prompt_tokens, 7, 'anthropic usage translated');

  // probe uses the provider's own protocol
  const probe = await probeProvider({ kind: 'openai', base_url: 'http://127.0.0.1:9999', api_key: 'k' });
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.models, ['m-one', 'm-two']);
  await new Promise((ok) => mock.close(ok));
}

// ---- deletion unregisters routes --------------------------------------------------------------------
{
  const anth = listProviders().find((p) => p.name === 'AnthTest');
  deleteProvider(anth.id);
  assert.equal(routeForModel('claude-x').proxy !== 'api' || routeForModel('claude-x').base === undefined, true, 'deleted provider no longer routes');
  assert.ok(!listProviders().some((p) => p.id === anth.id));
}

// ---- seam locks -------------------------------------------------------------------------------------
{
  const am = readFileSync(new URL('../src/authmode.js', import.meta.url), 'utf8');
  assert.match(am, /mode: 'api'/, 'claude sessions can ride an anthropic-kind provider');
  assert.match(am, /ANTHROPIC_API_KEY: prov\.api_key/, 'provider key reaches the claude env');
  const mj = readFileSync(new URL('../src/agents/model.js', import.meta.url), 'utf8');
  assert.match(mj, /if \(route\?\.base\) return callApiProvider/, 'base-URL routes bypass the fleet transport');
  const api = readFileSync(new URL('../src/models_api.js', import.meta.url), 'utf8');
  assert.match(api, /api\/models\/providers/, 'provider routes exist');
  assert.ok(api.indexOf("'/api/models/providers'") < api.indexOf('/api/models/providers/:id'), 'specific before :id (registration order)');
  const ui = readFileSync(new URL('../web/auth.js', import.meta.url), 'utf8');
  assert.match(ui, /apiProviders/, 'auth page carries the providers card');
}

// ---- fleet-less brains: voice chain api entries + summarize fallback + supervisor chain tail --------
{
  const { chat } = await import('../src/llm.js');
  const mock2 = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: 'brain-ok' } }] }));
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'brain-model' }] }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((ok) => mock2.listen(9998, '127.0.0.1', ok));
  upsertProvider({ name: 'BrainProv', kind: 'openai', base_url: 'http://127.0.0.1:9998', api_key: 'sk-b', models: ['brain-model'] });

  // explicit api entry in a chain
  const r1 = await chat([{ role: 'user', content: 'x' }], {}, [{ api: true, model: 'brain-model' }]);
  assert.equal(r1.content, 'brain-ok');
  // a dead fleet port falls through to the api entry (deterministic — the dev box may run a live fleet,
  // so the DEFAULT chain's behavior is covered by the withUserTail source-lock below instead)
  const r2 = await chat([{ role: 'user', content: 'x' }], {}, [{ port: 1, model: 'dead-model' }, { api: true, model: 'brain-model' }]);
  assert.equal(r2.content, 'brain-ok', 'dead fleet entry falls through to the user provider');

  const llmSrc = readFileSync(new URL('../src/llm.js', import.meta.url), 'utf8');
  assert.match(llmSrc, /withUserTail/, 'voice chain gains the user tail');
  const sumSrc = readFileSync(new URL('../src/summarize.js', import.meta.url), 'utf8');
  assert.match(sumSrc, /userRoutes\(\)\[0\]/, 'summaries fall back to a user provider');
  const supSrc = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(supSrc, /userRoutes\(\)\.slice\(0, 2\)\.map\(\(r\) => r\.id\)/, 'supervisor default chain tails into user providers');
  const rel = readFileSync(new URL('../bin/release', import.meta.url), 'utf8');
  assert.match(rel, /RELEASE_SKIP_TESTS/, 'releases are test-gated');
  assert.match(rel, /GITHUB_PAT_AIOS/, 'release auto-loads the GitHub token');
  await new Promise((ok) => mock2.close(ok));
}

console.log('model_providers.test ok');
