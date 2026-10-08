import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { createOmniInput } from '../src/omni_input.js';

// Real browser mic/AudioWorklet, shared SDK, real application adapter and HTTP
// handlers. Only Omni inference is a deterministic CPU fixture, never production.
const upstream = new Map(), trace = [], answers = [], owners = [], pending = new Set();
let transcript = 'How was the voice input fixed?', busy = false, dropCreate = true, dropAudio = true,
  dropCommit = true, dropEvents = true, rejectCommit = false, answerDelay = 0;
const result = data => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) });
const emit = (session, name, data) => {
  const id = session.events.length + 1;
  const wire = `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  session.events.push(wire);
  for (const reader of session.readers) reader.send(wire);
  if (['done', 'error', 'retry'].includes(name)) { session.complete = true; for (const reader of [...session.readers]) reader.end(); }
};
const bridge = createOmniInput({
  prepare: async voiceId => {
    assert.equal(busy, false, 'previous microphone owner must release'); busy = true;
    const owner = { voiceId, alive: () => true };
    owners.push(owner); return owner;
  },
  released: () => { busy = false; },
  request: async (method, path, options = {}) => {
    trace.push({ method, path, sequence: options.body?.sequence });
    if (path === '/voice/sessions') {
      const body = options.body;
      assert.equal(body.model, 'omni-voice'); assert.equal(body.asr_only, true); assert.equal(body.continuous, false);
      assert.equal(body.app_id, 'supercalm'); assert.equal(body.system, undefined);
      assert.equal(body.history, undefined); assert.equal(body.voice, undefined);
      const id = randomBytes(16).toString('hex');
      const session = { id, events: [], readers: new Set(), chunks: new Map(), transcript, next: 0 };
      upstream.set(id, session); emit(session, 'session_ready', { protocol: 'omni-voice-stream-v1', asr_only: true });
      return result({ session_id: id, protocol: 'omni-voice-stream-v1', asr_only: true,
        continuous: false, input_mode: 'asr-only', max_audio_seconds: 30, reconnect: { event_ids: true,
        idempotent_audio: true, idempotent_commit: true, max_ms: 45000 } });
    }
    const id = path.split('/')[3], session = upstream.get(id); assert.ok(session);
    if (method === 'DELETE') {
      session.stopped = true;
      for (const reader of [...session.readers]) reader.end(); return result({ stopped: true });
    }
    if (path.endsWith('/audio')) {
      const { sequence, audio } = options.body;
      const pcm = Buffer.from(audio, 'base64');
      assert.ok(pcm.length > 0 && pcm.length <= 32000 && pcm.length % 2 === 0);
      assert.notEqual(pcm.toString('ascii', 0, 4), 'RIFF', 'uploads contain raw PCM, not WAV headers');
      if (sequence < session.next) assert.equal(session.chunks.get(sequence), audio, 'retry preserves the exact sequence and bytes');
      else { assert.equal(sequence, session.next++); session.chunks.set(sequence, audio);
        if (sequence < 2) emit(session, 'transcript_partial', { text: sequence ? session.transcript : 'Temporary words',
          segment_id: 0, asr_only: true, revision: sequence + 1 }); }
      return result({ next_sequence: sequence + 1 });
    }
    if (path.endsWith('/commit')) {
      if (!session.committed) {
        session.committed = true;
        emit(session, 'transcript_final', { text: session.transcript, segment_id: 0, asr_only: true });
        // Recognition completion cannot run an LLM, play speech or decide to
        // send an instruction. Typed and spoken replies share the next handler.
        const answer = () => { if (!session.stopped) {
          emit(session, 'done', { text: session.transcript, asr_only: true, llm_calls: 0, tts_calls: 0, audio_frames: 0 });
        } };
        if (answerDelay) session.answerTimer = setTimeout(answer, answerDelay);
        else answer();
      }
      return result({ committed: true });
    }
    assert.match(path, /\/events\?after=\d+$/);
    const cursor = Number(path.split('after=')[1]);
    return new Promise((resolve, reject) => {
      const upstreamResponse = { headers: { 'content-type': 'text/event-stream' }, isPaused: () => false, pause() {}, resume() {} };
      let closed = false;
      const reader = { send(wire) {
        if (closed) return;
        const bytes = Buffer.from(wire);
        // Deliberately split SSE and multi-byte Mandarin in the relay.
        for (let at = 0; at < bytes.length; at += 137) options.onChunk(bytes.subarray(at, at + 137), upstreamResponse);
      }, end() { if (closed) return; closed = true; session.readers.delete(reader); pending.delete(reader); resolve(result({})); } };
      session.readers.add(reader); pending.add(reader);
      options.signal?.addEventListener('abort', () => { reader.end(); reject(new Error('reader detached')); }, { once: true });
      for (const wire of session.events.slice(cursor)) reader.send(wire);
      if (session.complete || session.stopped) reader.end();
    });
  },
});
const web = new URL('../web/', import.meta.url);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/aios/harness') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<base href="/aios/"><button id="listen">Listen</button><p id="heard"></p><p id="answer"></p>
      <script type="module">
      const {listenOmni}=await import('./omni-input.js');const p=await import('./tts-player.js');
      window.__ready=true;document.querySelector('#listen').onclick=()=>{p.unlockAudio();const context=p.voiceAudioContext();
      window.__partials=[];window.__finals=[];window.__text='';window.__connections=[];
      window.__controller=new AbortController();window.__result=null;window.__error=null;window.__failure=null;
      window.__run=listenOmni({context,voiceId:'v_fixture',voice:'Serena',signal:window.__controller.signal,
      onPartial:t=>{window.__partials.push(t);document.querySelector('#heard').textContent=t;},
      onFinal:t=>window.__finals.push(t),onText:t=>{window.__text+=t;document.querySelector('#answer').textContent=window.__text;},
      onConnection:s=>window.__connections.push(s.state)}).then(r=>window.__result=r,e=>{
      window.__failure={finalText:e.finalText,partial:e.partial,recording:!!e.recording};window.__error=e.message;});};
      </script>`); return;
  }
  if (url.pathname.startsWith('/aios/api/voice/input/sessions')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const parts = url.pathname.split('/'), id = parts[6], action = parts[7];
    try {
      if (req.method === 'GET') {
        if (dropEvents) { dropEvents = false; setTimeout(() => res.destroy(), 300); }
        await bridge.events(id, url.searchParams.get('after') || '0', res); return;
      }
      const data = id ? await bridge.control(id, req.method, action || '', body) : await bridge.start(body);
      if (!id && dropCreate) { dropCreate = false; res.destroy(); return; }
      if (action === 'audio' && dropAudio) { dropAudio = false; res.destroy(); return; }
      if (action === 'commit' && dropCommit) { dropCommit = false; res.destroy(); return; }
      if (action === 'commit' && rejectCommit) {
        rejectCommit = false;
        // Final SSE and done arrived, but the commit HTTP control fails.
        // The application must not lose the final words or redo ASR on retry.
        await new Promise(resolve => setTimeout(resolve, 100));
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"Commit control failed"}'); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
    } catch (error) { if (!res.headersSent) { res.writeHead(error.status || 503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); } else res.destroy(); }
    return;
  }
  if (!url.pathname.startsWith('/aios/') || url.pathname.includes('..')) { res.writeHead(404); res.end(); return; }
  try {
    const path = new URL(url.pathname.slice('/aios/'.length), web);
    const data = readFileSync(path);
    res.writeHead(200, { 'content-type': ['.js', '.mjs'].includes(extname(path.pathname)) ? 'text/javascript' : 'text/plain' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('aios_tts_rate', '1.75');
    // Synthetic media stream, real worklet/VAD/resampling/upload and playback.
    const hardware = new AudioContext();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => { await hardware.resume();
        const oscillator = hardware.createOscillator(), gain = hardware.createGain(), destination = hardware.createMediaStreamDestination();
        oscillator.connect(gain); gain.connect(destination); gain.gain.setValueAtTime(.2, hardware.currentTime);
        gain.gain.setValueAtTime(0, hardware.currentTime + .75); oscillator.start();
        destination.stream.getTracks()[0].addEventListener('ended', () => oscillator.stop(), { once: true });
        return destination.stream;
      },
    } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/aios/harness`); await page.waitForFunction(() => window.__ready);
  await page.locator('#listen').click();
  await page.waitForFunction(() => window.__result || window.__error, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__error), null);
  let out = await page.evaluate(() => ({ result: window.__result, partials: window.__partials, text: window.__text, reconnects: window.__connections }));
  assert.equal(out.result.answered, false); assert.equal(out.result.text, transcript);
  assert.ok(out.reconnects.includes('reconnecting'));
  assert.equal(upstream.size, 1, 'lost creation/audio/commit ACKs reuse exactly one upstream voice session');
  assert.equal(answers.length, 0, 'recognition never starts an answer or executes a delivery');
  assert.ok(trace.some(row => /events\?after=[1-9]/.test(row.path)), 'the actual handler receives the last SSE cursor');
  assert.ok(out.partials.every(text => text === 'Temporary words' || text === transcript), 'provisional transcripts replace, never concatenate');
  transcript = '中文语音输入是怎么修好的？';
  await page.locator('#listen').click(); await page.waitForFunction(() => window.__result || window.__error);
  assert.equal(await page.evaluate(() => window.__error), null);
  assert.equal(await page.locator('#answer').textContent(), '');
  assert.equal(await page.evaluate(() => window.__result.text), transcript);
  assert.equal(answers.length, 0);
  transcript = 'Please fix the mobile microphone.';
  await page.locator('#listen').click(); await page.waitForFunction(() => window.__result || window.__error);
  out = await page.evaluate(() => ({ result: window.__result, text: window.__text, error: window.__error }));
  assert.equal(out.error, null); assert.equal(out.result.answered, false); assert.equal(out.result.text, transcript);
  assert.equal(out.text, '', 'an instruction never hears an unconfirmed Omni action claim');
  assert.equal(answers.length, 0, 'instructions are handed to the existing action harness, not recorded as questions');
  assert.equal(busy, false, 'handoff releases voice capacity before confirmation processing');
  transcript = 'What else changed?'; rejectCommit = true;
  await page.locator('#listen').click(); await page.waitForFunction(() => window.__result || window.__error);
  const failedCommit = await page.evaluate(() => ({ failure: window.__failure, finals: window.__finals, result: window.__result }));
  assert.deepEqual(failedCommit.finals, [transcript], 'a final transcript is visible once, even before the commit ACK');
  assert.equal(failedCommit.failure, null, 'native done proves success despite a missing HTTP commit ACK');
  assert.equal(failedCommit.result.text, transcript);
  transcript = 'Can you explain the latest update?'; answerDelay = 6900;
  await page.locator('#listen').click(); await page.waitForFunction(() => window.__result || window.__error, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__error), null);
  const waiting = [...upstream.values()].at(-1);
  assert.equal(trace.filter(row => row.method === 'GET' && row.path.includes(waiting.id)).length, 1,
    'quiet inference keepalives prevent unnecessary shared-SDK reconnections');
  answerDelay = 0;
  transcript = 'This recording is interrupted before commitment';
  await page.locator('#listen').click(); await page.waitForFunction(() => window.__partials.length > 0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__error);
  await new Promise(resolve => setTimeout(resolve, 100));
  const hidden = [...upstream.values()].at(-1);
  assert.equal(hidden.stopped, true, 'hidden page actively cancels its microphone session');
  assert.equal(hidden.committed, undefined, 'hidden recording never starts an answer');
  assert.equal(busy, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, protocol: 'omni-voice-stream-v1', upstreamSessions: upstream.size,
    answers, handlerInvocations: trace, instructionHandoff: out.result, failedCommit,
    quietInference: { sameReader: true, waitMs: 6900 },
    hiddenPage: { stopped: hidden.stopped, committed: !!hidden.committed } }, null, 2));
} finally {
  for (const session of upstream.values()) clearTimeout(session.answerTimer);
  await browser.close(); for (const reader of pending) reader.end(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
