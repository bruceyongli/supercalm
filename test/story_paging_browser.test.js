import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const assets = new Map(['story-view.js', 'common.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
const requests = [];
let tick = 0;
const events = n => [{ kind: 'you', ts: n * 100, body: `Request ${n}` },
  { kind: 'report', ts: n * 100 + 1, body: Array.from({ length: 15 }, (_, i) => `Paragraph ${i}: Report ${n}.`).join('\n\n') }];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(assets.get(url.pathname)); return; }
  if (url.pathname.startsWith('/api/session/')) {
    requests.push(url.search);
    const n = Number(url.searchParams.get('cursor') || 3);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events: events(n), status: 'working', liveStatus: { verb: 'Working…', detail: `${++tick}s` },
      meta: { source: 'transcript', file: '/own.jsonl', trimmed: n > 1, cursor: n > 1 ? String(n - 1) : null } })); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><style>.story-feed{height:300px;overflow:auto;overflow-anchor:none}.story-ev{margin:20px}.story-body p{height:30px}</style><div id="story"></div>
    <script type="module">import * as story from '/story-view.js'; window.story=story;
    await story.initStoryView({sessionId:'s_paged',panel:document.querySelector('#story')}); window.ready=true;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    requests.length = 0;
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    assert.deepEqual(requests, [''], 'initial paint never recursively downloads history');
    await page.evaluate(() => { window.originalFeed = document.querySelector('.story-feed'); window.originalReport = document.querySelector('[data-kind="report"]'); });
    await page.evaluate(async () => { await Promise.all([story.refreshStory(), story.refreshStory(), story.refreshStory()]); });
    assert.equal(requests.length, 2, 'concurrent refreshes share one request');
    assert.equal(await page.evaluate(() => document.querySelector('[data-kind="report"]') === originalReport), true, 'timer updates preserve report DOM identity');
    const before = await page.evaluate(async () => {
      const feed = document.querySelector('.story-feed'); feed.scrollTop = 180;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const row = document.querySelector('[data-kind="report"]');
      return row.getBoundingClientRect().top;
    });
    await page.evaluate(() => story.loadEarlierStory());
    assert.equal(await page.evaluate(() => document.querySelector('.story-feed') === originalFeed), true);
    const after = await page.evaluate(() => originalReport.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) <= 2, `prepend preserves reading position (${before} -> ${after})`);
    assert.equal(await page.locator('[data-kind="report"]').count(), 2);
    await page.evaluate(() => story.refreshStory());
    assert.equal(requests.at(-1), '', 'live refresh stays recent-only after loading older history');
    const historyBefore = requests.length;
    await page.evaluate(() => { document.querySelector('.story-feed').scrollTop = 50; });
    await page.waitForFunction(() => document.querySelectorAll('[data-kind="report"]').length === 3);
    assert.equal(requests.length, historyBefore + 1, 'one upward scroll loads one page');
    assert.equal(await page.locator('[data-story-prev]').isVisible(), false, 'end of history stops paging');
    await page.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('story_paging_browser: desktop/tablet/phone paging, scroll anchor, stable rows and refresh coalescing passed');
