import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createVoiceControlReplay } from '../src/voice_control_replay.js';
import { wavFromPcm, NATIVE_TTS_MODEL } from '../src/tts_native.js';

// Real browser voice loop, PCM player, UI and acknowledgement ledger; only hardware and endpoints
// are private fixtures. No live sessions, agent messages, Spark GPU work or screenshots.
const web = fileURLToPath(new URL('../web/', import.meta.url));
const ledger = createVoiceControlReplay(), turns = [];
let handled = 0, stops = 0, starts = 0;
let dismissalCount = 0, heldTurn = false, cancelledTurn = false, staleClicks = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/aios/harness') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<base href="/aios/"><link rel="stylesheet" href="styles.css"><script type="module">
      window.__voice = await import('./voicemode.js'); window.__ready = true;
    </script>`); return;
  }
  if (url.pathname.startsWith('/aios/api/voice/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (url.pathname.endsWith('/start')) {
      if (++starts === 2) return reply(503, { error: 'fixture startup unavailable' });
      if (starts > 2) return reply(200, { voiceId: 'dismiss-flow', say: 'First dismissal report is ready.', listen: true,
        current: { sessionId: 's_first', reportId: 100, project: 'First project', n: 1, total: 2 } });
      return reply(200, { voiceId: 'recovery', say: 'The microphone update is ready for review.', listen: true,
        current: { sessionId: 's_private', project: 'AIOS', n: 1, total: 1 } });
    }
    if (url.pathname.endsWith('/turn')) {
      if (body.voiceId === 'dismiss-flow') {
        heldTurn = true; res.on('close', () => { cancelledTurn = true; }); return;
      }
      turns.push(body);
      if (turns.length === 1) return reply(409, { error: 'turn already in flight' });
      const cached = ledger.get('turn', body);
      if (cached) return reply(200, cached);
      handled++;
      const answer = { say: 'Your question was understood.', listen: true, acceptedText: body.userText,
        current: { sessionId: 's_private', project: 'AIOS', n: 1, total: 1 } };
      ledger.record('turn', body, 200, answer);
      return reply(500, { error: 'fixture acknowledgement lost after processing' });
    }
    if (url.pathname.endsWith('/dismiss')) {
      const cached = ledger.get('dismiss', body); if (cached) return reply(200, cached);
      if (!staleClicks++) return reply(409, { code: 'voice_report_changed', error: 'The displayed report changed. Nothing else was dismissed.' });
      assert.equal(body.sessionId, dismissalCount ? 's_second' : 's_first');
      assert.equal(body.reportId, dismissalCount ? 101 : 100);
      dismissalCount++;
      const result = { say: '', done: false, listen: false, current: null };
      ledger.record('dismiss', body, 200, result); return reply(200, result);
    }
    if (url.pathname.endsWith('/continue') && body.voiceId === 'dismiss-flow') return reply(200, dismissalCount === 0
      ? { say: 'The current report is ready.', listen: true, current: { sessionId: 's_first', reportId: 100, project: 'First project', n: 1, total: 2 } }
      : dismissalCount === 1
      ? { say: 'Next report, second project.', listen: true, current: { sessionId: 's_second', reportId: 101, project: 'Second project', n: 2, total: 2 } }
      : { say: '', done: true, listen: false, current: null });
    if (url.pathname.endsWith('/stop')) stops++;
    return reply(200, { ok: true });
  }
  const path = resolve(join(web, url.pathname.replace(/^\/aios\//, '')));
  if (!path.startsWith(web)) { res.writeHead(403); res.end(); return; }
  try { res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/plain' }); res.end(readFileSync(path)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('aios_tts', 'browser');
    localStorage.setItem('aios_tts_rate', '1.75');
    window.__ended = []; window.__spoken = [];
    window.addEventListener('aios:voice-mode-end', event => window.__ended.push(event.detail.reason));
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(text) { this.text = text; } } });
    const synth = { speaking: false, pending: false, getVoices: () => [],
      cancel() { this.speaking = false; },
      speak(utterance) {
        if (!utterance.text) return;
        window.__spoken.push(utterance.text); this.speaking = true;
        utterance.onstart?.();
        if (window.__spoken.length > 1 && !utterance.text.startsWith('First dismissal report')) setTimeout(() => { this.speaking = false; utterance.onend?.(); }, 30);
      } };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    let recognized = false;
    window.SpeechRecognition = class {
      start() {
        this.onstart?.();
        if (!recognized) {
          recognized = true;
          setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: 'Wait, how was the microphone fixed?' }], { isFinal: true })] }), 150);
        }
      }
      abort() { this.onend?.(); } stop() { this.onend?.(); }
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => { throw new DOMException('fixture permission denied', 'NotAllowedError'); },
    } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/aios/harness`);
  await page.waitForFunction(() => window.__ready);
  const tone = Buffer.alloc(24000); // 0.5 seconds at 440Hz, long enough to measure the played signal
  for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * 16000), i * 2);
  const pitch = await page.evaluate(async frame => {
    const { createPcmQueue } = await import('./voice-stream.js');
    const context = new OfflineAudioContext(1, 24000 * 2, 24000);
    const queue = createPcmQueue(context, { rate: 1.75 });
    queue.push(frame); queue.setRate(1.75); queue.seal();
    const rendered = await context.startRendering(); queue.stop();
    const samples = rendered.getChannelData(0);
    let crossings = 0;
    for (let i = 24000 * .62; i < 24000 * .8; i++) if (samples[i] <= 0 && samples[i + 1] > 0) crossings++;
    return crossings / .18;
  }, { index: 0, audio: wavFromPcm(tone).toString('base64'), model: NATIVE_TTS_MODEL, engine: 'qwen', backend: 'faster-ggml',
    precision: 'BF16', streaming: 'native-pcm-frames', voice: 'Ryan', prosody_profile: 'steady-v3' });
  assert.ok(Math.abs(pitch - 440) < 10, `real WebAudio must retain 440Hz, not the sped-up 770Hz voice (${pitch})`);
  await page.evaluate(() => { window.__running = window.__voice.startVoiceMode(); });
  await page.waitForFunction(() => document.querySelector('.vm-state')?.textContent === 'Connection paused');
  assert.equal(handled, 1);
  assert.equal(turns.length, 2, 'only the unprocessed busy control is automatically retried');
  assert.match(await page.locator('.vm-heard').textContent(), /how was the microphone fixed/);
  assert.match(await page.locator('.vm-said').textContent(), /microphone update/);
  assert.equal(await page.evaluate(() => window.__voice.isVoiceModeActive()), true);
  assert.deepEqual(await page.evaluate(() => window.__ended), [], 'a lost acknowledgement must not close the conversation');
  await page.locator('.vm-interrupt').click();
  await page.waitForFunction(() => document.querySelector('.vm-tts-notice')?.textContent.includes('Microphone unavailable'));
  assert.equal(turns.length, 3);
  assert.equal(handled, 1, 'manual retry reuses the acknowledgement, not the instruction');
  assert.equal(new Set(turns.map(turn => turn.requestId)).size, 1, 'one logical turn retains one request id through both retries');
  assert.match(await page.locator('.vm-heard').textContent(), /how was the microphone fixed/);
  assert.equal(await page.evaluate(() => window.__voice.isVoiceModeActive()), true);
  assert.deepEqual(await page.evaluate(() => window.__ended), [], 'mic permission failure remains paused, not hung up');
  assert.deepEqual(await page.evaluate(() => window.__spoken), ['The microphone update is ready for review.', 'Your question was understood.'],
    'recovery does not repeat the opening or the acknowledged answer');
  const stopped = page.waitForResponse(response => response.url().endsWith('/api/voice/stop'));
  await page.locator('.vm-stop').click(); await stopped;
  await page.evaluate(() => window.__running);
  await page.waitForFunction(() => !window.__voice.isVoiceModeActive());
  assert.deepEqual(await page.evaluate(() => window.__ended), ['user']);
  assert.equal(stops, 1);
  await page.evaluate(() => { window.__running = window.__voice.startVoiceMode(); });
  await page.waitForFunction(() => document.querySelector('.vm-tts-notice')?.textContent.includes('fixture startup unavailable'));
  await page.waitForTimeout(2000); // the old outer catch automatically closed the UI after 1800ms
  assert.equal(await page.evaluate(() => window.__voice.isVoiceModeActive()), true, 'startup failure also stays visible until deliberately ended');
  await page.locator('.vm-stop').click(); await page.evaluate(() => window.__running);
  assert.deepEqual(await page.evaluate(() => window.__ended), ['user', 'user']);
  await page.evaluate(() => {
    let once = false;
    window.SpeechRecognition = class {
      start() {
        this.onstart?.();
        if (!once) { once = true; setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: 'Please fix the report UI.' }], { isFinal: true })] }), 150); }
      }
      abort() { this.onend?.(); } stop() { this.onend?.(); }
    };
    window.__running = window.__voice.startVoiceMode();
  });
  for (let i = 0; !heldTurn && i < 100; i++) await page.waitForTimeout(30);
  assert.equal(heldTurn, true);
  await page.locator('.vm-dismiss').click();
  await page.waitForFunction(() => document.querySelector('.vm-tts-notice')?.textContent.includes('Microphone unavailable'));
  assert.equal(dismissalCount, 0, 'a stale click reconciles the current report without dismissing another one or looping retries');
  assert.equal(staleClicks, 1); assert.equal(await page.evaluate(() => window.__voice.isVoiceModeActive()), true);
  await page.locator('.vm-dismiss').click();
  await page.waitForFunction(() => document.querySelector('.ongo-title')?.textContent === 'Second project');
  assert.equal(dismissalCount, 1, 'Dismiss interrupts an in-flight turn and advances exactly once');
  assert.equal(cancelledTurn, true, 'the stale browser request is cancelled');
  await page.waitForFunction(() => document.querySelector('.vm-tts-notice')?.textContent.includes('Microphone unavailable'));
  assert.doesNotMatch(await page.locator('.vm-heard').textContent(), /fix the report UI/, 'the first project reply never leaks to the next report');
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => ({ button: document.querySelector('.vm-dismiss').getBoundingClientRect().toJSON(),
      warning: document.querySelector('.vm-tts-notice').getBoundingClientRect().toJSON() }));
    assert.ok(layout.button.x >= 0 && layout.button.right <= viewport.width && layout.button.bottom <= viewport.height,
      'Dismiss stays reachable on phone/iPad/desktop');
    assert.ok(layout.warning.height <= 100, 'a visible warning never expands into the main transcript area');
  }
  await page.locator('.vm-dismiss').click(); await page.evaluate(() => window.__running);
  assert.equal(dismissalCount, 2, 'Dismiss is also usable while microphone recovery is paused');
  assert.equal(await page.evaluate(() => window.__voice.isVoiceModeActive()), false);
  console.log('voice_recovery_browser.test ok', JSON.stringify({ busyControls: 1, logicalTurns: handled, httpAttempts: turns.length, preservedReply: true, micPaused: true, endReason: 'user' }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
