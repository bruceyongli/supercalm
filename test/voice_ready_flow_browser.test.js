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
const sttTakes = [{ text: '为什么之前中文输入不工作', language: 'auto' }, { text: 'How was it fixed?', language: 'auto' }];
let streamBehavior = null;
const model = httpServer(async (req, res) => {
  const body = await readBody(req);
  if (body.messages[0].content.includes('hands-free project lead')) {
    const userText = body.messages.at(-1).content;
    const sourceResolved = body.messages[0].content.includes('The delay came from generating the briefing after Accept.');
    trace.push({ event: 'conversation', userText, sourceResolved, workload: req.headers['x-spark-workload'],
      bilingualPrompt: body.messages[0].content.includes('switch freely between Chinese and English') });
    res.writeHead(200, { 'content-type': 'application/json', 'x-spark-workload': 'voice', 'x-spark-queue-wait-ms': '1' });
    const say = /\p{Script=Han}/u.test(userText)
      ? '之前浏览器的英文设置被当成了唯一的语音语言。现在中英文都允许自动识别，报告和音频也会在来电前准备好。'
      : 'Both Chinese and English are now allowed automatically. The linked plan also says to prepare the briefing and audio before ringing.';
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ say, action: 'await', message: '' }) } }] }));
    return;
  }
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
  if (req.url === '/v1/audio/transcriptions') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const field = name => body.toString('utf8').match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
    const take = sttTakes.shift();
    trace.push({ event: 'stt', language: field('language'), prompt: field('prompt'),
      wavUploaded: body.includes(Buffer.from('RIFF')), text: take.text, detected: take.language });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...take, raw_text: take.text }));
    return;
  }
  const body = await readBody(req);
  trace.push({ event: 'tts', path: req.url, ttsOnly: body.tts_only, voice: body.voice, text: body.text,
    explicit: req.headers['x-voice-demo'], history: body.history });
  if (streamBehavior) {
    const behavior = streamBehavior;
    res.on('close', () => { behavior.closed = true; behavior.release(); });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = { index: 0, audio: wavFromPcm(Buffer.alloc(48000)).toString('base64'), model: NATIVE_TTS_MODEL,
      precision: 'BF16', engine: 'qwen', backend: 'faster-ggml', streaming: 'native-pcm-frames', voice: 'Ryan',
      phrase_index: 0, frame_index: 0, native_startup_one_frames: 2, text: 'First update uses PIXY. Gimbal, not the laptop camera.' };
    res.write(`event: audio\ndata: ${JSON.stringify(frame)}\n\n`);
    await behavior.gate;
    if (res.destroyed) return;
    if (behavior.fail) res.end('event: error\ndata: {"message":"fixture interrupted generation"}\n\n');
    else res.end(`event: audio\ndata: ${JSON.stringify({ ...frame, index: 1, phrase_index: 1, text: '中文输入也能使用。' })}\n\nevent: done\ndata: ${JSON.stringify({ text: body.text })}\n\n`);
    return;
  }
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
  AIOS_VOICE_CONVERSATION_CHAIN: `${model.address().port}:voice/qwen38-flash-next-nvfp4`,
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
  const { setVoiceConfig } = await import('../src/model_providers.js');
  setVoiceConfig({ stt: { primary: 'spark', fallbacks: [] } });
  const doc = join(scratch, 'voice-plan.md');
  writeFileSync(doc, '# Voice readiness\nThe delay came from generating the briefing after Accept.\nPrepare text and audio before ringing.\n');
  store.createProject({ id: 'p_voice_fixture', name: 'fixture', path: scratch });
  store.createSession({ id: 's_voice_fixture', project_id: 'p_voice_fixture', tool: 'codex', tmux: 'fixture-only', status: 'waiting' });
  store.updateSession('s_voice_fixture', { category: 'review' });
  store.addMessage('s_voice_fixture', 'in', 'task', 'Prepare useful voice updates before interrupting me.');
  const report = store.addMessage('s_voice_fixture', 'out', 'detect', `Voice reports are ready before ringing. [Plan](${doc})`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  const handlers = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.includes('/api/voice/') || path.endsWith('/api/transcribe')) handlers.push({ path, status: response.status() });
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
  const startResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/voice/start'));
  await page.locator('[data-voice-call-accept]').click();
  const startedVoice = await (await startResponse).json();
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

  // The device UI is English. Upload WAV bytes through the real STT handler using the same shared
  // language preference as every mic surface, then feed its accepted Chinese transcript to the real
  // conversation handler. Only the remote speech/model providers are deterministic private fixtures;
  // language pinning, transcript guards, source resolution, dialogue and turn persistence are real.
  const bilingualTrace = await page.evaluate(async ({ voiceId, wav }) => {
    const common = await import('./common.js');
    const { voiceTranscriptDisposition } = await import('./voice-input.js');
    const results = [];
    const OriginalRecognition = window.SpeechRecognition;
    const recognitionLanguages = [];
    window.SpeechRecognition = class {
      start() { recognitionLanguages.push(this.lang); this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    };
    const recognize = () => { const recognizer = common.createLiveSpeechRecognizer(); recognizer.start(); recognizer.stop(); };
    recognize();
    const audio = Uint8Array.from(atob(wav), ch => ch.charCodeAt(0));
    for (let i = 0; i < 2; i++) {
      const langs = common.preferredSttLangs();
      const sttResponse = await fetch(`api/transcribe?language=auto&polish=false&session=s_voice_fixture&langs=${encodeURIComponent(langs)}`,
        { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio });
      const transcript = await sttResponse.json();
      if (!transcript.rejected) common.rememberSpeechLanguage(transcript.language, transcript.text);
      recognize();
      const turnResponse = await fetch('api/voice/turn', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voiceId, userText: transcript.text }) });
      results.push({ langs, sttStatus: sttResponse.status, transcript, accepted: voiceTranscriptDisposition(transcript.text).accepted,
        remembered: localStorage.getItem('aios_stt_last_lang'), turnStatus: turnResponse.status, turn: await turnResponse.json() });
    }
    localStorage.setItem('aios_stt_langs', 'zh');
    const explicit = common.preferredSttLangs();
    localStorage.removeItem('aios_stt_langs');
    localStorage.removeItem('aios_stt_last_lang');
    const languages = Object.getOwnPropertyDescriptor(navigator, 'languages');
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-TW'] });
    recognize();
    if (languages) Object.defineProperty(navigator, 'languages', languages); else delete navigator.languages;
    window.SpeechRecognition = OriginalRecognition;
    return { results, explicit, recognitionLanguages };
  }, { voiceId: startedVoice.voiceId, wav: wavFromPcm(Buffer.alloc(24000 * 2)).toString('base64') });
  assert.equal(bilingualTrace.results[0].langs, 'en,zh', 'an English device must not silently pin speech to English');
  for (const result of bilingualTrace.results) {
    assert.equal(result.sttStatus, 200); assert.equal(result.accepted, true); assert.equal(result.turnStatus, 200);
    assert.equal(result.turn.done, false); assert.equal(result.turn.ignored, undefined, 'Chinese must reach conversation, not the fragment gate');
  }
  assert.equal(bilingualTrace.results[0].remembered, 'zh-CN');
  assert.match(bilingualTrace.results[0].turn.say, /中英文都允许自动识别/);
  assert.equal(bilingualTrace.results[1].remembered, 'en-US');
  assert.match(bilingualTrace.results[1].turn.say, /Chinese and English/);
  assert.equal(bilingualTrace.explicit, 'zh', 'an intentional single-language override is still honored');
  assert.deepEqual(bilingualTrace.recognitionLanguages, ['en-US', 'zh-CN', 'en-US', 'zh-TW'],
    'live recognition follows detected speech, or the actual device locale before any detection');
  assert.equal(trace.filter(item => item.event === 'stt').length, 2);
  for (const item of trace.filter(item => item.event === 'stt')) {
    assert.equal(item.language, 'auto'); assert.equal(item.wavUploaded, true); assert.match(item.prompt, /中文和 English/);
  }
  for (const item of trace.filter(item => item.event === 'conversation')) {
    assert.equal(item.sourceResolved, true); assert.equal(item.bilingualPrompt, true); assert.equal(item.workload, 'voice');
  }
  assert.equal(store.messagesFor('s_voice_fixture').filter(message => message.direction === 'in').length, 1,
    'Chinese and English questions were not delivered as coding-agent instructions');

  // Drive the real native streaming handler and shared browser player. Keep the gateway unfinished
  // until the browser has actually started its first audio phrase, then prove completion waits for
  // the last queued buffer; errors and interruption must not synthesize/replay the opening again.
  const nativePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await nativePage.goto(base + '?view=desktop&noresize');
  const nativeText = 'First update uses PIXY. Gimbal, not the laptop camera. 中文输入也能使用。';
  await nativePage.evaluate(async text => {
    const player = await import('./tts-player.js');
    const button = document.createElement('button'); button.id = 'fixture-native-play'; button.textContent = 'Play native fixture';
    button.style.cssText = 'position:fixed;top:10px;right:10px;z-index:999999';
    button.onclick = () => {
      player.unlockAudio(); window.__nativeSegments = []; window.__nativeDone = false; window.__partial = 0;
      window.__nativeHandle = player.newPlayback();
      window.__nativeRun = player.speakSmart(text, window.__nativeHandle, { continuous: true,
        onSegment: value => window.__nativeSegments.push(value), onPartial: () => window.__partial++ }).then(() => { window.__nativeDone = true; });
    };
    document.body.append(button);
  }, nativeText);
  const streamingTrace = [];
  for (const outcome of ['complete', 'partial', 'stop']) {
    let release;
    streamBehavior = { gate: new Promise(resolve => { release = resolve; }), release: () => release(), fail: outcome === 'partial', closed: false };
    const behavior = streamBehavior;
    const beforeTts = trace.filter(item => item.event === 'tts').length;
    await nativePage.locator('#fixture-native-play').click();
    await nativePage.waitForFunction(() => window.__nativeSegments.length === 1);
    assert.equal(await nativePage.evaluate(() => window.__nativeDone), false, 'the first phrase plays before the unfinished gateway response');
    assert.equal(behavior.closed, false);
    assert.equal(trace.filter(item => item.event === 'tts').at(-1).text, nativeText, 'the complete reply is sent once, not split by AIOS');
    if (outcome === 'stop') await nativePage.evaluate(() => window.__nativeHandle.stop());
    else behavior.release();
    if (outcome === 'complete') {
      await nativePage.waitForFunction(() => window.__nativeSegments.length === 2);
      assert.equal(await nativePage.evaluate(() => window.__nativeDone), false, 'EOF cannot advance the conversation while the last phrase is still playing');
    }
    await nativePage.evaluate(() => window.__nativeRun);
    await until(() => behavior.closed);
    const result = await nativePage.evaluate(() => ({ phrases: window.__nativeSegments.map(value => value.text), partial: window.__partial }));
    assert.equal(trace.filter(item => item.event === 'tts').length - beforeTts, 1, 'partial speech or Stop never falls back and replays the opening');
    assert.equal(result.phrases.length, outcome === 'complete' ? 2 : 1);
    assert.equal(result.partial, outcome === 'partial' ? 1 : 0);
    streamingTrace.push({ outcome, ...result, upstreamClosed: behavior.closed, ttsRequests: 1 });
  }
  streamBehavior = null; await nativePage.close();
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
    acceptAdditionalGenerations: 0, nativeStreaming: streamingTrace, bilingual: bilingualTrace, speechHandlers: trace.filter(item => ['stt', 'conversation'].includes(item.event)),
    staleStart: staleStart.status, staleAudio: staleAudio.status }));
  await page.evaluate(async () => { (await import('./voicemode.js')).stopVoiceMode(); });
  await browser.close(); browser = null;
  console.log('voice_ready_flow_browser.test ok');
} finally {
  await browser?.close(); model.close(); spark.close(); cleanup();
}
process.exit(0);
