import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const assets = new Map([
  ['/story-view.js', readFileSync(new URL('web/story-view.js', root))],
  ['/common.js', readFileSync(new URL('web/common.js', root))],
  ['/file-reference.js', readFileSync(new URL('web/file-reference.js', root))],
  ['/tts-player.js', readFileSync(new URL('web/tts-player.js', root))],
]);

function silentWav() {
  const samples = 400;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

const wav = silentWav();
let voiceCalls = 0;
let ttsCalls = 0;
let ttsCallsBeforeReady = null;
const voiceBodies = [];
const report = 'This is a detailed final report sentence. '.repeat(45);
const readyParts = [
  'Part one gives the direct answer.',
  'Part two explains the strongest evidence.',
  'Part three names the important risk.',
  'Part four gives the owner the next action.',
];
const fixture = `<!doctype html><meta charset="utf-8"><body><div id="story"></div>
<script type="module">
  const story = await import('/story-view.js');
  story.initStoryView({ sessionId: 's_voice', panel: document.querySelector('#story') });
  window.__storyReady = true;
</script>`;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(assets.get(path));
    return;
  }
  if (path === '/api/session/s_voice/story') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      status: 'waiting',
      events: [
        { kind: 'report', ts: 5, body: 'The previous round is finished.' },
        { kind: 'you', ts: 8, body: 'Refine the current report only.' },
        { kind: 'report', ts: 10, body: report },
      ],
      meta: { source: 'transcript', file: '/rollouts/voice.jsonl' },
    }));
    return;
  }
  if (path === '/api/session/s_voice/voice-report') {
    let body = '';
    for await (const chunk of req) body += chunk;
    voiceBodies.push(JSON.parse(body));
    voiceCalls++;
    res.writeHead(voiceCalls < 3 ? 202 : 200, { 'content-type': 'application/json' });
    if (voiceCalls < 3) {
      res.end(JSON.stringify({ ok: true, status: 'preparing', retryAfterMs: 20 }));
    } else {
      ttsCallsBeforeReady = ttsCalls;
      res.end(JSON.stringify({ ok: true, status: 'ready', mode: 'guided', parts: readyParts }));
    }
    return;
  }
  if (path === '/api/tts') {
    for await (const _chunk of req) { /* drain the POST */ }
    ttsCalls++;
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
    res.end(wav);
    return;
  }
  if (path === '/metrics') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ voiceCalls, ttsCalls, ttsCallsBeforeReady }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fixture);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__storyReady && document.body.textContent.includes('detailed final report'));
  const labels = await page.locator('[data-story-listen]').allInnerTexts();
  assert.deepEqual(labels, ['▶ guided', '▶ quick', '▶ read all'],
    'long reports expose distinct guided, quick, and complete-read choices');

  await page.locator('[data-story-listen][data-level="full"]').click();
  const deadline = Date.now() + 10000;
  while ((voiceCalls < 3 || ttsCalls < 4) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(voiceCalls, 3, 'the client polls while the guided script is tailoring');
  assert.ok(voiceBodies.every((body) => body.focusAfterTs === 5),
    'every preparation poll scopes owner prompts to after the preceding report');
  assert.equal(ttsCallsBeforeReady, 0, 'a 202 never starts a raw fallback read-out');
  assert.equal(ttsCalls, readyParts.length, 'every stable generated part is played exactly once');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('voice_report_playback_browser.test ok');
