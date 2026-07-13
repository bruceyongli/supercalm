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
  // keyless is ALLOWED since the providers-unification (local/LAN endpoints without auth);
  // the probe reports if the endpoint actually requires a key.
  const keyless = upsertProvider({ name: 'x', kind: 'openai', base_url: 'http://x' });
  assert.equal(keyless.key_set, false, 'keyless provider accepted');
  deleteProvider(keyless.id);
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
  // MIGRATED (operator, 2026-07-13): provider + speech management left the auth page for Settings —
  // auth keeps sign-in/CLI tooling and points at Settings; the forms live in web/views/settings.js.
  const ui = readFileSync(new URL('../web/auth.js', import.meta.url), 'utf8');
  assert.ok(!/apiProviders|speechProvider/.test(ui), 'auth page no longer carries the migrated cards');
  const authHtml = readFileSync(new URL('../web/auth.html', import.meta.url), 'utf8');
  assert.match(authHtml, /settings#st-voice/, 'auth points at Settings for voice config');
  const st = readFileSync(new URL('../web/views/settings.js', import.meta.url), 'utf8');
  assert.match(st, /api\/models\/providers\/builtin/, 'settings carries the providers management');
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

// ---- speech provider: store, probe, and both audio paths against the mock ---------------------------
{
  const { getSpeech, setSpeech, clearSpeech, probeSpeech } = await import('../src/model_providers.js');
  const audioSeen = [];
  const mock3 = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      audioSeen.push({ path: req.url, auth: req.headers.authorization || '', ct: req.headers['content-type'] || '', len: body.length, body: body.toString('latin1').slice(0, 800) });
      if (req.url === '/v1/audio/speech') { res.setHeader('content-type', 'audio/mpeg'); return res.end(Buffer.alloc(300, 7)); }
      if (req.url === '/v1/audio/transcriptions') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ text: 'hello from mock stt' })); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((ok) => mock3.listen(9997, '127.0.0.1', ok));

  // probe synthesizes a clip
  const pr = await probeSpeech({ base_url: 'http://127.0.0.1:9997', api_key: 'sk-sp', tts_model: 'kokoro', tts_voice: 'af_heart' });
  assert.equal(pr.ok, true);
  assert.ok(pr.bytes >= 300);

  // store: redaction + local-server keyless allowed
  setSpeech({ base_url: 'http://127.0.0.1:9997/v1', api_key: 'sk-sp', stt_model: 'whisper-large-v3', tts_model: 'kokoro', tts_voice: 'af_heart' });
  const sp = getSpeech();
  assert.equal(sp.base_url, 'http://127.0.0.1:9997', 'trailing /v1 normalized off');
  assert.equal(sp.api_key, undefined);
  assert.equal(sp.key_set, true);
  setSpeech({ base_url: 'http://127.0.0.1:9997' }); // partial update keeps fields
  assert.equal(getSpeech().stt_model, 'whisper-large-v3');

  // speaking-style instructions: stored, kept on partial update, and threaded into provider TTS
  setSpeech({ base_url: 'http://127.0.0.1:9997', tts_instructions: 'calm colleague giving a status report' });
  assert.equal(getSpeech().tts_instructions, 'calm colleague giving a status report');
  setSpeech({ base_url: 'http://127.0.0.1:9997', tts_voice: 'bf_emma' });
  assert.equal(getSpeech().tts_instructions, 'calm colleague giving a status report', 'instructions survive partial updates');

  // TTS route body shape (via the raw speak path in tts.js would need the server; assert protocol here)
  const r = await fetch('http://127.0.0.1:9997/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-sp' }, body: JSON.stringify({ model: 'kokoro', input: 'x', voice: 'af_heart', response_format: 'mp3' }) });
  assert.equal(r.status, 200);
  const speechCall = audioSeen.find((x) => x.path === '/v1/audio/speech');
  assert.match(speechCall.auth, /Bearer/);

  // STT multipart shape through the real spark.js helper is exercised by the e2e; here lock the seams
  clearSpeech();
  assert.equal(getSpeech(), null);
  const sparkSrc = readFileSync(new URL('../src/spark.js', import.meta.url), 'utf8');
  assert.match(sparkSrc, /transcribeWithProvider/, 'STT provider path exists');
  assert.match(sparkSrc, /no speech-to-text configured/, 'helpful 502 when nothing is configured');
  assert.match(sparkSrc, /import \{ getSpeech \} from '\.\/model_providers\.js'/, 'spark imports the store (a use-without-import once shipped)');
  const ttsSrc = readFileSync(new URL('../src/tts.js', import.meta.url), 'utf8');
  assert.match(ttsSrc, /speakProvider/, 'TTS provider path exists');
  assert.match(ttsSrc, /import \{ getSpeech \} from '\.\/model_providers\.js'/, 'tts imports the store');
  assert.match(ttsSrc, /wantSpark && SPARK\.ip/, 'spark only attempted when configured');
  const mapi = readFileSync(new URL('../src/models_api.js', import.meta.url), 'utf8');
  assert.match(mapi, /api\/models\/speech/, 'speech config routes exist');
  assert.match(mapi, /spark_configured/, 'settings can tell whether a Spark device takes precedence');
  // migration seams: config UIs live in Settings; the router keeps in-page anchors on the page
  assert.match(ttsSrc, /instructions: style/, 'provider TTS threads speaking-style instructions');
  assert.match(sparkSrc, /backend=provider|backend'\) === 'provider'|searchParams\.get\('backend'\)/, 'transcribe supports forcing the provider path');
  const settingsSrc = readFileSync(new URL('../web/views/settings.js', import.meta.url), 'utf8');
  assert.match(settingsSrc, /api\/models\/speech/, 'settings owns the speech form');
  assert.match(settingsSrc, /tts_instructions/, 'settings edits speaking-style instructions');
  // the migrated sections must manage in place (sign-in links to auth elsewhere are legitimate)
  const managed = settingsSrc.slice(settingsSrc.indexOf('async function loadProviders'), settingsSrc.indexOf('async function loadRemote'));
  assert.ok(managed.length > 100 && !/href="auth"/.test(managed), 'providers + voice sections never bounce to the auth page');
  const routerSrc = readFileSync(new URL('../web/router.js', import.meta.url), 'utf8');
  assert.match(routerSrc, /scrollIntoView/, 'hash links scroll in place (base-tag would send them home)');
  await new Promise((ok) => mock3.close(ok));
}

console.log('model_providers.test ok');
