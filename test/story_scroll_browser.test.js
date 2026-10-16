import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const assets = new Map(['story-view.js', 'story-request.js', 'common.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
let revision = 1;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(assets.get(url.pathname)); return; }
  if (url.pathname.startsWith('/api/session/')) {
    const id = url.pathname.split('/')[3];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'waiting', events: [
      { kind: 'you', ts: 1, body: `Request for ${id}` },
      ...Array.from({ length: revision }, (_, i) => ({ kind: 'report', ts: i + 2,
        body: Array.from({ length: 16 }, (_, j) => `Report ${i}, paragraph ${j} for ${id}.`).join('\n\n') })),
    ], meta: { source: 'transcript', file: `${id}.jsonl`, trimmed: false } })); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><style>.story-feed{height:300px;overflow:auto;overflow-anchor:none}.story-ev{margin:20px}.story-body p{min-height:30px}</style>
    <button id="hide">Terminal</button><button id="show">Story</button><div id="story"></div>
    <script type="module">import * as story from '/story-view.js'; window.story=story;
    window.openSession=async(id)=>{story.destroyStoryView(); await story.initStoryView({sessionId:id,panel:document.querySelector('#story')});};
    hide.onclick=()=>{document.querySelector('#story').hidden=true;story.setStoryActive(false);};
    show.onclick=()=>{document.querySelector('#story').hidden=false;story.setStoryActive(true);};
    await openSession('s_a');window.ready=true;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const bottom = page => page.waitForFunction(() => {
  const f = document.querySelector('.story-feed');
  return f.clientHeight > 0 && f.scrollHeight - f.clientHeight - f.scrollTop < 2;
});
const scroll = async (page, top) => {
  await page.evaluate(top => { document.querySelector('.story-feed').scrollTop = top; }, top);
  await page.waitForFunction(top => JSON.parse(sessionStorage.getItem('aios_story_scroll_s_a'))?.top === top, top);
};
try {
  for (const width of [1440, 820, 390]) {
    revision = 1;
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    await bottom(page);
    await scroll(page, 180);
    await page.locator('[data-story-latest]').click();
    await bottom(page);
    // Updating a hidden Story must not save its zero height or lose the Latest intent.
    await page.locator('#hide').click();
    revision++;
    await page.evaluate(() => story.refreshStory());
    await page.locator('#show').click();
    await bottom(page);
    revision++;
    await page.evaluate(() => story.refreshStory());
    await bottom(page);
    // Session navigation remounts from a recent-only cache, then fetches new server content.
    await page.evaluate(() => openSession('s_b'));
    await page.evaluate(() => openSession('s_a'));
    await bottom(page);
    await page.reload(); await page.waitForFunction(() => window.ready); await bottom(page);
    // Delayed image/video layout and device rotation keep followers at the new bottom.
    await page.evaluate(() => { document.querySelector('.story-body').style.paddingBottom = '260px'; });
    await bottom(page);
    await page.setViewportSize({ width, height: 700 });
    await page.evaluate(() => { document.querySelector('.story-feed').style.height = '220px'; });
    await bottom(page);
    // Scrolling up is a durable opt-out: do not yank readers to the tail on updates or tab switches.
    await scroll(page, 180);
    revision++;
    await page.evaluate(() => story.refreshStory());
    assert.equal(await page.locator('.story-feed').evaluate(f => f.scrollTop), 180);
    await page.locator('#hide').click();
    revision++;
    await page.evaluate(() => story.refreshStory());
    await page.locator('#show').click();
    assert.equal(await page.locator('.story-feed').evaluate(f => f.scrollTop), 180);
    await page.evaluate(() => openSession('s_b'));
    await page.evaluate(() => openSession('s_a'));
    assert.equal(await page.locator('.story-feed').evaluate(f => f.scrollTop), 180);
    // Manually scrolling to the bottom is equivalent to Latest (without waiting for the save timer).
    await page.evaluate(async () => {
      const feed = document.querySelector('.story-feed'); feed.scrollTop = feed.scrollHeight;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await openSession('s_b'); await openSession('s_a');
    });
    await bottom(page);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, latestAcrossTabsAndSessions: true, hiddenUpdate: true,
      manualBottom: true, readingPositionPreserved: true, delayedLayout: true, reload: true }));
    await page.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('story_scroll_browser: following Latest and reading history survive navigation on desktop/tablet/phone');
