import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const assets = new Map(['voicemode.js', 'common.js', 'tts-player.js', 'voice-interruption.js']
  .map((name) => [`/${name}`, readFileSync(new URL(`web/${name}`, root))]));
const turns = [];
const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(assets.get(path));
    return;
  }
  if (path === '/api/voice/start') {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      voiceId: 'v_interrupt',
      say: 'AIOS Supercalm. Voice Assistant. Report quality. The update now leads with the issue and explains the actual repair in plain language.',
      done: false,
      listen: true,
      current: { sessionId: 's_one', projectIdentity: 'AIOS Supercalm', module: 'Voice Assistant', workstream: 'Report quality', tool: 'codex', n: 1, total: 1 },
    }));
    return;
  }
  if (path === '/api/voice/turn') {
    turns.push(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ voiceId: 'v_interrupt', say: 'I stopped and heard your question.', done: true, listen: false }));
    return;
  }
  if (path === '/api/voice/stop') {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (path === '/turns') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(turns));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><meta charset="utf-8"><body><script type="module">localStorage.setItem("aios_tts","browser"); window.__voice = await import("/voicemode.js"); window.__run = window.__voice.startVoiceMode({focusSessionId:"s_one",source:"on-the-go-update"});</script>');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    let utterance = 0;
    class FakeUtterance {
      constructor(text) { this.text = text; }
    }
    const synthesis = {
      speaking: false,
      pending: false,
      getVoices: () => [],
      cancel() { this.speaking = false; this.pending = false; },
      speak(item) {
        if (!item.text) { queueMicrotask(() => item.onend?.()); return; }
        utterance++;
        this.speaking = true;
        this.pending = true;
        queueMicrotask(() => item.onstart?.());
        // The first report intentionally keeps talking until interruption. The acknowledgement ends.
        if (utterance > 1) setTimeout(() => { this.speaking = false; this.pending = false; item.onend?.(); }, 20);
      },
    };
    class FakeRecognition {
      start() {
        this.onstart?.();
        setTimeout(() => {
          const result = [{ transcript: 'Wait' }];
          result.isFinal = false;
          this.onresult?.({ results: [result] });
        }, 250);
        setTimeout(() => {
          const result = [{ transcript: 'Voice Assistant report quality. Wait, what actually caused the problem?' }];
          result.isFinal = true;
          this.onresult?.({ results: [result] });
        }, 400);
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
    Object.defineProperty(window, 'Audio', { configurable: true, value: class { play() { return Promise.resolve(); } pause() {} } });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base + '/');
  await page.locator('.vm-interrupt:not([hidden])').waitFor();
  assert.equal(await page.locator('.vm-interrupt').textContent(), 'Speak now', 'touch has an explicit interruption fallback while speech is playing');
  const deadline = Date.now() + 5000;
  while (!turns.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(turns[0]?.userText, 'Wait, what actually caused the problem?',
    'a clear spoken question stops playback and enters the normal contextual turn route');
  await page.evaluate(() => window.__run);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('voice_interruption_browser.test ok');
