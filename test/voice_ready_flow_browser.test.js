import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { NATIVE_TTS_MODEL, wavFromPcm } from '../src/tts_native.js';

const scratch = mkdtempSync(join(tmpdir(), 'aios-ready-voice-'));
const socket = `aios-ready-voice-${process.pid}`;
const realTmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim();
const wrapper = join(scratch, 'tmux.sh');
writeFileSync(wrapper, `#!/bin/sh\nexec '${realTmux}' -L '${socket}' "$@"\n`, { mode: 0o700 });
const cert = join(scratch, 'cert.pem'), key = join(scratch, 'key.pem');
assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' }).status, 0);
const originalCA = getCACertificates('default');
setDefaultCACertificates([...originalCA, readFileSync(cert, 'utf8')]);
const trace = [];
let releaseModel, releaseAudio;
const modelGate = new Promise(resolve => { releaseModel = resolve; });
const audioGate = new Promise(resolve => { releaseAudio = resolve; });
const readBody = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); };
const model = httpServer(async (req, res) => {
  const body = await readBody(req);
  trace.push({ event: 'model', workload: req.headers['x-spark-workload'], model: body.model, style: body.spark_response_style,
    sourceResolved: body.messages.at(-1).content.includes('The delay came from generating the briefing after Accept.') });
  await modelGate;
  res.writeHead(200, { 'content-type': 'application/json', 'x-spark-workload': 'voice', 'x-spark-queue-wait-ms': '1' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topic: 'Ready voice updates', kind: 'review',
    identity: 'fixture', module: 'Voice Assistant', workstream: 'Ready before ringing', request: 'Prepare useful reports before interrupting the owner.',
    updates: [{ requested: 'No waiting after Accept', latest: 'The briefing and audio are ready before the call appears.' }],
    quick: 'No wait after answering.', standard: 'The delay came from generating the briefing after Accept. It is prepared before ringing now.',
    spoken: 'The briefing and audio are prepared before the call appears, so answering no longer leaves you waiting.', needs: '', options: [] }) } }] }));
});
const spark = httpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
  const body = await readBody(req);
  trace.push({ event: 'tts', path: req.url, ttsOnly: body.tts_only, voice: body.voice, text: body.text,
    explicit: req.headers['x-voice-demo'], history: body.history });
  await audioGate;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const pcm = Buffer.alloc(24000 * 2);
  const frame = { index: 0, audio: wavFromPcm(pcm).toString('base64'), model: NATIVE_TTS_MODEL, precision: 'BF16',
    engine: 'qwen', backend: 'faster-ggml', streaming: 'native-pcm-frames', voice: 'Ryan' };
  res.end(`event: audio\ndata: ${JSON.stringify(frame)}\n\nevent: done\ndata: ${JSON.stringify({ text: body.text })}\n\n`);
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => spark.listen(0, '127.0.0.1', resolve));
const probe = httpServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
Object.assign(process.env, { AIOS_DATA: join(scratch, 'data'), AIOS_ENV_FILE: join(scratch, 'missing.env'), AIOS_TMUX: wrapper,
  AIOS_PROXY_KEY: 'private-fixture', AIOS_PORT: String(port), AIOS_HOST: '127.0.0.1',
  AIOS_VOICE_BRIEF_CHAIN: `${model.address().port}:voice/qwen38-flash-next-nvfp4`,
  AIOS_CODEX_SESSIONS_DIR: join(scratch, 'codex'), SPARK_IP: '127.0.0.1', SPARK_HOST: 'localhost', SPARK_PORT: String(spark.address().port) });
mkdirSync(process.env.AIOS_CODEX_SESSIONS_DIR);
delete process.env.AIOS_NO_LISTEN;
const base = `http://127.0.0.1:${port}/aios/`;
let browser, store;
let cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  spawnSync(realTmux, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 3000 });
  setDefaultCACertificates(originalCA);
  try { store?.db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', cleanup);
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
try {
  const { featureReady } = await import('../src/server.js');
  await featureReady;
  store = await import('../src/store.js');
  const doc = join(scratch, 'voice-plan.md');
  writeFileSync(doc, '# Voice readiness\nThe delay came from generating the briefing after Accept.\nPrepare text and audio before ringing.\n');
  store.createProject({ id: 'p_voice_fixture', name: 'fixture', path: scratch });
  store.createSession({ id: 's_voice_fixture', project_id: 'p_voice_fixture', tool: 'codex', tmux: 'fixture-only', status: 'waiting' });
  store.updateSession('s_voice_fixture', { category: 'review' });
  store.addMessage('s_voice_fixture', 'in', 'task', 'Prepare useful voice updates before interrupting me.');
  const report = store.addMessage('s_voice_fixture', 'out', 'detect', `Voice reports are ready before ringing. [Plan](${doc})`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const handlers = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.includes('/api/voice/')) handlers.push({ path, status: response.status() });
  });
  await page.addInitScript(() => {
    localStorage.setItem('aios.on-the-go.enabled', '1');
    localStorage.setItem('aios.voice-updates.style', 'call');
    // No microphones open and no audio plays until Accept. Deterministic device clock only; the
    // actual AIOS handlers, TLS speech transport, source resolver and byte download run unchanged.
    window.__plays = 0;
    Object.defineProperty(window, 'Audio', { configurable: true, value: class {
      play() { window.__plays++; this.duration = 10; queueMicrotask(() => this.onplaying?.()); return Promise.resolve(); }
      pause() { this.onpause?.(); }
    } });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
  });
  await page.goto(base + '?view=desktop&noresize');
  await page.waitForFunction(() => document.querySelector('.app') || document.querySelector('#app'));
  await page.evaluate(async reportId => {
    const mode = await import('./on-the-go.js');
    window.__mode = mode;
    mode.observeOnTheGoNeeds([{ id: 's_voice_fixture', project: 'fixture', status: 'waiting', category: 'review', unread: 1, last_key: { id: reportId } }]);
  }, report.id);
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('fixture did not settle'); };
  await until(() => trace.some(item => item.event === 'model'));
  assert.equal(await page.locator('[data-voice-update-call], .vm-ongo').count(), 0, 'model generation cannot display an incoming call');
  releaseModel();
  await until(() => trace.some(item => item.event === 'tts'));
  assert.equal(await page.locator('[data-voice-update-call], .vm-ongo').count(), 0, 'text readiness alone cannot display a call before its audio is ready');
  releaseAudio();
  await page.locator('[data-voice-call-accept]').waitFor();
  assert.equal(await page.evaluate(() => window.__plays), 0, 'prewarming never starts report playback');
  const before = trace.length;
  await page.locator('[data-voice-call-accept]').click();
  await page.locator('.vm-ongo .ongo-report').waitFor();
  await page.waitForFunction(() => window.__plays > 1);
  assert.match(await page.locator('.vm-ongo .vm-said').textContent(), /prepared before the call appears/);
  assert.equal(trace.length, before, 'Accept invokes /voice/start but no second LLM or TTS generation');
  assert.ok(handlers.some(item => item.path.endsWith('/voice/prepare') && item.status === 200));
  assert.ok(handlers.some(item => item.path.endsWith('/voice/start') && item.status === 200));
  assert.ok(handlers.some(item => item.path.endsWith('/audio') && item.status === 200));
  assert.equal(trace.find(item => item.event === 'model').sourceResolved, true, 'the real source resolver supplied the linked document to the briefing model');
  assert.equal(trace[0].workload, 'voice');
  assert.equal(trace[0].style, 'original');
  const speech = trace.find(item => item.event === 'tts');
  assert.equal(speech.path, '/voice/api/turn'); assert.equal(speech.ttsOnly, true); assert.equal(speech.explicit, '1');
  assert.deepEqual(speech.history, [], 'the demo cannot regenerate or reinterpret the grounded AIOS answer');
  const { prepareVoiceUpdate } = await import('../src/voice.js');
  const ready = await prepareVoiceUpdate('s_voice_fixture', report.id);
  const { dismissAttention } = await import('../src/attention_store.js');
  dismissAttention('s_voice_fixture', report.id);
  const staleStart = await fetch(base + 'api/voice/start', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'on-the-go-update', focusSessionId: 's_voice_fixture', preparationId: ready.id }) });
  assert.equal(staleStart.status, 409, 'a cross-device dismissal rejects a prepared call instead of speaking stale content');
  const staleAudio = await fetch(base + `api/voice/prepared/${ready.id}/audio`);
  assert.equal(staleAudio.status, 409, 'dismissed audio cannot be replayed from its URL');
  console.log('voice_ready_flow trace', JSON.stringify({ pass: true, handlers, model: trace[0], tts: speech,
    acceptAdditionalGenerations: trace.length - before, staleStart: staleStart.status, staleAudio: staleAudio.status }));
  await page.evaluate(async () => { (await import('./voicemode.js')).stopVoiceMode(); });
  await browser.close(); browser = null;
  console.log('voice_ready_flow_browser.test ok');
} finally {
  await browser?.close(); model.close(); spark.close(); cleanup();
}
process.exit(0);
