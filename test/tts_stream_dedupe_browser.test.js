import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const playerSource = readFileSync(new URL('../web/tts-player.js', import.meta.url));
let streamRequests = 0;
let singleRequests = 0;
const chunks = [
  { index: 0, text: 'First, the problem was identified.' },
  { index: 1, text: 'Second, the cause was corrected.' },
  { index: 0, text: 'First, the problem was identified.' },
  { index: 1, text: 'Second, the cause was corrected.' },
  { index: 2, text: 'Now the user sees the right update.' },
];

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/tts-player.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(playerSource);
    return;
  }
  if (path === '/api/tts/stream') {
    streamRequests++;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const chunk of chunks) res.write(`event: chunk\ndata: ${JSON.stringify({ ...chunk, audio_base64: 'AA==', media_type: 'audio/mpeg' })}\n\n`);
    res.end('event: done\ndata: {}\n\n');
    return;
  }
  if (path === '/api/tts') {
    singleRequests++;
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.from('one-continuous-audio-response'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><script type="module">
    const player = await import('/tts-player.js');
    const segments = [];
    const handle = player.newPlayback();
    const text = 'A sufficiently long report. '.repeat(20);
    await player.speakSmart(text, handle, { onSegment: (item) => segments.push(item) });
    const continuousSegments = [];
    await player.speakSmart(text, player.newPlayback(), { continuous: true, onSegment: (item) => continuousSegments.push(item) });
    window.__result = { segments, continuousSegments, plays: window.__audioPlays };
  </script>`);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__audioPlays = 0;
    Object.defineProperty(window, 'Audio', { configurable: true, value: class {
      play() {
        window.__audioPlays++;
        this.duration = 10;
        queueMicrotask(() => {
          this.onplaying?.();
          this.currentTime = 8;
          this.ontimeupdate?.();
        });
        setTimeout(() => this.onended?.(), 5);
        return Promise.resolve();
      }
      pause() { this.onpause?.(); }
    } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__result);
  const result = await page.evaluate(() => window.__result);
  assert.deepEqual(result.segments.map((item) => item.index), [0, 1, 2],
    'replayed stream chunk identities are spoken only once');
  assert.equal(result.plays, 4, 'stream chunks plus one continuous utterance each play exactly once');
  assert.equal(streamRequests, 1, 'ordinary long report playback retains the low-latency stream');
  assert.equal(singleRequests, 1, 'continuous assistant speech uses one audio response instead of sentence clips');
  assert.deepEqual(result.continuousSegments.map((item) => item.index), [0, 16],
    'one continuous audio response can still advance the visible current-reading marker');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('tts_stream_dedupe_browser.test ok');
