import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { readStoryPage, readStoryImage } from '../src/story_reader.js';

const root = await mkdtemp(join(tmpdir(), 'aios-story-images-browser-'));
const file = join(root, 'native.jsonl');
const assets = new Map(['story-view.js', 'story-request.js', 'common.js', 'session-indicator.js', 'provider-issue.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
// A valid raster with padding models native screenshots without a generated/binary fixture in git.
const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(400000)]);
const rows = [];
const add = (type, content, reason) => rows.push({ type, timestamp: new Date(1700000000000 + rows.length * 1000).toISOString(),
  message: { id: `msg-${rows.length}`, content, stop_reason: reason } });
add('user', 'Show the complete result.');
for (let i = 0; i < 4; i++) {
  add('assistant', [{ type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command: 'inspect', description: 'Inspect screenshot ' + i } }], 'tool_use');
  add('user', [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
  ] }]);
  add('assistant', [{ type: 'text', text: 'Screenshot checked ' + i }], 'tool_use');
}
const report = '## Complete result\n\n完整报告，保留每一段。\n\n| Check | Result |\n|---|---|\n| Native image | Retained |\n\nThe final paragraph remains visible.';
add('assistant', [{ type: 'text', text: report }], 'end_turn');
await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const heldImages = new Set();
let storyUnavailable = false, releaseImages = false, imageRequests = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(assets.get(url.pathname)); }
  if (url.pathname.endsWith('/story/image')) {
    imageRequests++;
    if (releaseImages) {
      const image = await readStoryImage({ file, ref: url.searchParams.get('ref') });
      res.writeHead(200, { 'content-type': image.mime }); return res.end(Buffer.from(image.data));
    }
    heldImages.add(res); res.on('close', () => heldImages.delete(res)); return;
  }
  if (url.pathname.endsWith('/story')) {
    if (storyUnavailable) { res.writeHead(503); return res.end('{}'); }
    const result = await readStoryPage({ file });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...result, sessionId: 's_image', status: 'waiting', meta: { ...result.meta, source: 'transcript', file } }));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta charset="utf-8"><style>.story-feed{height:360px;overflow:auto;overflow-anchor:none}.story-ev{margin:20px}.story-shot{max-width:100%}</style>
    <div id="story"></div><script type="module">import * as story from '/story-view.js'; window.story=story;
    await story.initStoryView({sessionId:'s_image',panel:document.querySelector('#story')}); window.ready=true;</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      storyUnavailable = false; releaseImages = false; imageRequests = 0;
      const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.ready && document.querySelector('[data-kind="report"]'));
      const rendered = await page.locator('[data-kind="report"]').innerText();
      assert.match(rendered, /完整报告，保留每一段/);
      assert.match(rendered, /The final paragraph remains visible/);
      assert.equal(await page.locator('[data-kind="report"] table').count(), 1);
      assert.equal(await page.locator('img[data-story-shot]').count(), 4);
      const cached = await page.evaluate(() => JSON.parse(sessionStorage.getItem('aios_story12_s_image')));
      assert.equal(cached.events.find(e => e.kind === 'report').body, report, 'fresh complete report fits the bounded mobile cache');
      assert.ok(JSON.stringify(cached).length < 220000);
      assert.ok(imageRequests > 0, 'image download is independent and still pending');
      // A reopen with the server unavailable renders the whole report from cache, not an older report.
      storyUnavailable = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.ready);
      assert.equal(await page.locator('[data-kind="report"]').innerText(), rendered);
      assert.equal(await page.locator('[data-kind="report"]').count(), 1);
      const image = await readStoryImage({ file, ref: cached.events.find(e => e.shotRef).shotRef });
      releaseImages = true;
      for (const res of heldImages) { res.writeHead(200, { 'content-type': image.mime }); res.end(Buffer.from(image.data)); }
      for (const image of await page.locator('img[data-story-shot]').all()) await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.querySelectorAll('img[data-story-shot]')].every(i => i.complete && i.naturalWidth === 1));
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine: engine.name(), reportsBeforeImages: true, cachedReopenDuringOutage: true, imageBytesPreserved: true }));
    } finally { await browser.close(); }
  }
} finally {
  for (const res of heldImages) res.destroy();
  server.closeAllConnections(); await new Promise(r => server.close(r));
  await rm(root, { recursive: true, force: true });
}
