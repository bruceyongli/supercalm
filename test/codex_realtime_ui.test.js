import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const assets = new Map([
  ['/aios/codex-realtime.html', ['text/html', readFileSync(new URL('web/codex-realtime.html', root))]],
  ['/aios/codex-realtime.css', ['text/css', readFileSync(new URL('web/codex-realtime.css', root))]],
  ['/aios/codex-realtime.js', ['text/javascript', readFileSync(new URL('web/codex-realtime.js', root))]],
  ['/aios/tts-player.js', ['text/javascript', readFileSync(new URL('web/tts-player.js', root))]],
]);
const outDir = new URL('test-results/codex-realtime-poc/', root);
mkdirSync(outDir, { recursive: true });
let authType = 'none';
const requests = [];

const voices = {
  v1: ['cove'],
  v2: ['alloy', 'marin', 'cedar'],
  defaultV1: 'cove',
  defaultV2: 'marin',
};

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) {
    const [type, content] = assets.get(path);
    res.writeHead(200, { 'content-type': type });
    res.end(content);
    return;
  }
  if (path === '/aios/api/codex-realtime/status') {
    const nativeReady = authType === 'apiKey';
    const bridgeReady = authType === 'chatgpt' || nativeReady;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      experimental: true,
      ready: nativeReady || bridgeReady,
      nativeReady,
      bridgeReady,
      mode: nativeReady ? 'native' : bridgeReady ? 'bridge' : null,
      authType,
      voices,
      bridgeModel: 'gpt-5.3-codex-spark',
      setup: bridgeReady ? null : 'Codex is not authenticated.',
    }));
    return;
  }
  if (path === '/aios/api/transcribe') {
    await body(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'Can you hear the bridge?' }));
    return;
  }
  const raw = await body(req);
  requests.push({ method: req.method, path, body: raw ? JSON.parse(raw) : {} });
  if (path.endsWith('/bridge/start')) {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      id: 'bridge-session',
      threadId: 'bridge-thread',
      mode: 'bridge',
      model: 'gpt-5.3-codex-spark',
      startupMs: 42,
    }));
    return;
  }
  if (path.endsWith('/bridge/turn')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      text: 'The Codex bridge can hear you.',
      model: 'gpt-5.3-codex-spark',
      firstTokenMs: 70,
      latencyMs: 90,
    }));
    return;
  }
  res.writeHead(path.endsWith('/start') ? 201 : 200, { 'content-type': 'application/json' });
  if (path.endsWith('/start')) {
    res.end(JSON.stringify({
      ok: true,
      id: 'poc-session',
      threadId: 'thread-1',
      sdp: 'v=0\r\nmock-answer',
      voice: 'marin',
      version: 'v2',
    }));
  } else {
    res.end(JSON.stringify({ ok: true }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/aios/codex-realtime.html`;
const browser = await chromium.launch({ headless: true });

const installWebRtcMock = async (context) => {
  await context.addInitScript(() => {
    const track = { stop() { window.__trackStopped = true; } };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        async getUserMedia() {
          return {
            getAudioTracks: () => [track],
            getTracks: () => [track],
          };
        },
      },
    });
    class MockPeerConnection extends EventTarget {
      constructor() {
        super();
        this.iceGatheringState = 'complete';
        this.connectionState = 'new';
      }
      addTrack() {}
      createDataChannel(label) {
        const channel = {
          label,
          close() {},
          onopen: null,
          onmessage: null,
          onerror: null,
        };
        window.__realtimeChannel = channel;
        return channel;
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nmock-offer' }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription(answer) {
        this.remoteDescription = answer;
        window.__remoteSdp = answer.sdp;
      }
      close() { this.connectionState = 'closed'; }
    }
    window.RTCPeerConnection = MockPeerConnection;
  });
};

const installBridgeMock = async (context) => {
  await context.addInitScript(() => {
    localStorage.setItem('aios_tts', 'browser');
    const track = { stop() { window.__trackStopped = true; } };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        async getUserMedia() {
          return {
            getAudioTracks: () => [track],
            getTracks: () => [track],
          };
        },
      },
    });
    class MockMediaRecorder {
      static isTypeSupported() { return true; }
      constructor(stream, options = {}) {
        this.stream = stream;
        this.mimeType = options.mimeType || 'audio/webm';
        this.state = 'inactive';
      }
      start() {
        this.state = 'recording';
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(['a'.repeat(1400)], { type: this.mimeType }) });
        }, 5);
      }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => this.onstop?.());
      }
    }
    let audioSamples = 0;
    class MockAudioContext {
      async resume() {}
      createAnalyser() {
        return {
          fftSize: 1024,
          getByteTimeDomainData(values) {
            audioSamples++;
            values.fill(128);
            if (audioSamples < 4) {
              for (let index = 0; index < values.length; index += 2) values[index] = 154;
            }
          },
        };
      }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async close() {}
    }
    window.MediaRecorder = MockMediaRecorder;
    window.AudioContext = MockAudioContext;
    window.speechSynthesis = {
      speaking: false,
      pending: false,
      getVoices: () => [],
      cancel() {},
      speak(utterance) {
        this.speaking = true;
        setTimeout(() => {
          this.speaking = false;
          utterance.onend?.();
        }, 5);
      },
    };
  });
};

try {
  const blockedContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const blockedPage = await blockedContext.newPage();
  await blockedPage.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await blockedPage.locator('#status-pill b').innerText(), 'Setup needed');
  assert.equal(await blockedPage.locator('#start').isDisabled(), true, 'signed-out Codex cannot start a voice session');
  await blockedPage.screenshot({ path: new URL('credential-gate.png', outDir).pathname, fullPage: true });
  await blockedContext.close();

  authType = 'chatgpt';
  const bridgeContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await installBridgeMock(bridgeContext);
  const bridgePage = await bridgeContext.newPage();
  await bridgePage.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await bridgePage.locator('#status-pill b').innerText(), 'Ready');
  assert.equal(await bridgePage.locator('#voice').inputValue(), 'bridge');
  assert.match(await bridgePage.locator('#voice option').innerText(), /Kokoro.*gpt-5\.3-codex-spark/);
  await bridgePage.locator('#start').click();
  await bridgePage.waitForFunction(() => document.querySelector('#transcript')?.textContent?.includes('The Codex bridge can hear you.'), null, { timeout: 5000 });
  assert.match(await bridgePage.locator('#transcript').innerText(), /Can you hear the bridge\?/);
  assert.match(await bridgePage.locator('#transcript').innerText(), /The Codex bridge can hear you\./);
  assert.ok(requests.some((request) => request.path.endsWith('/bridge/start')));
  assert.ok(requests.some((request) => request.path.endsWith('/bridge/turn') && request.body.text === 'Can you hear the bridge?'));
  await bridgePage.screenshot({ path: new URL('bridge-live.png', outDir).pathname, fullPage: true });
  await bridgeContext.close();

  authType = 'apiKey';
  const readyContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await installWebRtcMock(readyContext);
  const page = await readyContext.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#status-pill b').innerText(), 'Ready');
  assert.equal(await page.locator('#voice option').allTextContents().then((v) => v.join(',')), 'Alloy,Marin,Cedar');
  await page.screenshot({ path: new URL('ready.png', outDir).pathname, fullPage: true });

  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#status-pill b')?.textContent === 'Live');
  assert.equal(await page.evaluate(() => window.__remoteSdp), 'v=0\r\nmock-answer');
  const nativeStart = requests.find((request) => request.path === '/aios/api/codex-realtime/start');
  assert.equal(nativeStart?.body.sdp, 'v=0\r\nmock-offer');
  assert.equal(nativeStart?.body.voice, 'marin');

  await page.evaluate(() => {
    window.__realtimeChannel.onmessage({
      data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Can you hear me?' }),
    });
    window.__realtimeChannel.onmessage({
      data: JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Loud and ' }),
    });
    window.__realtimeChannel.onmessage({
      data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Loud and clear.' }),
    });
  });
  assert.match(await page.locator('#transcript').innerText(), /Can you hear me\?/);
  assert.match(await page.locator('#transcript').innerText(), /Loud and clear\./);
  await page.screenshot({ path: new URL('live-session.png', outDir).pathname, fullPage: true });

  await page.locator('#text-input').fill('Text fallback');
  await page.locator('#text-form button').click();
  await page.waitForFunction(() => document.querySelector('#text-input')?.value === '');
  assert.ok(requests.some((r) => r.path.endsWith('/text') && r.body.text === 'Text fallback'));
  await page.locator('#stop').click();
  await page.waitForFunction(() => document.querySelector('#status-pill b')?.textContent === 'Ready');
  assert.equal(await page.evaluate(() => window.__trackStopped), true, 'stop releases the microphone');
  await readyContext.close();

  console.log('codex_realtime_ui.test ok: bridge voice turn, native WebRTC SDP, transcript and mic cleanup verified');
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
