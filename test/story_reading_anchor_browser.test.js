import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const names = ['story-view.js', 'story-request.js', 'story-live.js', 'common.js', 'session-indicator.js',
  'provider-issue.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js'];
const assets = new Map(names.map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
let revision = 0, older = false, tail = false, gap = false, historyRequests = 0;
const streams = new Set();
const report = { kind: 'report', messageId: 'report', ts: 100,
  body: Array.from({ length: 18 }, (_, i) => `Reading paragraph ${i}: the actual outcome and remaining decision. ${'Keep this report readable. '.repeat(4)}`).join('\n\n') };
const originalBody = report.body;
const payload = cursor => gap && !cursor ? { sessionId: 's_reading', status: 'working', events: [
  { kind: 'you', messageId: 'new-request', ts: 300, body: 'A new instruction after reconnect.' },
  { kind: 'report', messageId: 'new-report', ts: 301, body: 'The new result stays below the report being read.' },
], meta: { source: 'transcript', file: '/reading.jsonl', cursor: 'gap', trimmed: true } } : ({ sessionId: 's_reading', status: 'working', events: [
  ...(older || cursor ? [{ kind: 'report', messageId: 'older', ts: 1, body: 'Earlier report. '.repeat(50) }] : []),
  { kind: 'you', messageId: 'request', ts: 10, body: 'Give me the release assessment.' },
  ...(cursor === 'gap' ? [{ kind: 'note', messageId: 'reconnect', ts: 15, body: 'Progress recovered during reconnect. '.repeat(30) }] : []),
  ...(revision ? [{ kind: 'note', messageId: 'late-progress', ts: 20,
    body: `Late progress ${revision}. ` + 'Previously missing progress. '.repeat(revision * 12) }] : []),
  report,
  ...(tail ? [{ kind: 'note', messageId: 'tail', ts: 200, body: 'New work below the report. '.repeat(40) }] : []),
], meta: { source: 'transcript', file: '/reading.jsonl', cursor: older || cursor ? null : 'older', trimmed: !older && !cursor } });
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(assets.get(url.pathname)); }
  if (url.pathname.endsWith('/story/updates')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); streams.add(res);
    req.on('close', () => streams.delete(res)); res.on('error', () => streams.delete(res)); return;
  }
  if (url.pathname.endsWith('/story')) {
    const cursor = url.searchParams.get('cursor');
    if (cursor) { historyRequests++; older = true; }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(payload(cursor)));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>.story-feed{height:420px;overflow:auto;overflow-anchor:none}.story-ev{margin:20px}
    .story-body p{line-height:24px;margin:16px 0}</style>
    <button id="hide">Terminal</button><button id="show">Story</button><div id="story"></div>
    <script type="module">import * as story from '/story-view.js'; window.story=story;
    hide.onclick=()=>{document.querySelector('#story').hidden=true;story.setStoryActive(false);};
    show.onclick=()=>{document.querySelector('#story').hidden=false;story.setStoryActive(true);};
    await story.initStoryView({sessionId:'s_reading',panel:document.querySelector('#story'),live:true});window.ready=true;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const update = () => { for (const stream of streams) stream.write('event: update\ndata: {"session":"s_reading"}\n\n'); };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const position = page => page.locator('[data-story-key="claude|report"] .story-body p').filter({ hasText: /^Reading paragraph 6:/ }).evaluate(el =>
  el.getBoundingClientRect().top - document.querySelector('.story-feed').getBoundingClientRect().top);
const bottom = page => page.waitForFunction(() => { const f = document.querySelector('.story-feed'); return f.scrollHeight - f.clientHeight - f.scrollTop < 2; });

try {
  for (const [engine, width] of [[chromium, 1440], [webkit, 820], [webkit, 390]]) {
    revision = 0; older = false; tail = false; gap = false; historyRequests = 0; report.body = originalBody;
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 1000 });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
      await bottom(page);
      await page.evaluate(() => {
        const f = document.querySelector('.story-feed'), p = document.querySelectorAll('[data-story-key="claude|report"] .story-body p')[6];
        f.scrollTop += p.getBoundingClientRect().top - f.getBoundingClientRect().top - 12;
      });
      await settle(page);
      const before = await position(page);
      // The same live SSE updates that repair missed reports must not replace what the reader sees
      // with earlier commentary. Pixel scrollTop equality is NOT a reading-position assertion.
      for (revision = 1; revision <= 3; revision++) {
        update();
        await page.waitForFunction(n => document.querySelector('[data-story-key="claude|late-progress"]')?.textContent.includes(`Late progress ${n}.`), revision);
        await settle(page);
        const after = await position(page);
        assert.ok(Math.abs(after - before) <= 2, `${engine.name()} ${width}: live update ${revision} moved reading paragraph ${before} -> ${after}`);
      }
      assert.equal(historyRequests, 0, 'automatic layout changes never request older pages');
      // Late media above the reader changes geometry without an API response or render().
      await page.locator('[data-story-key="claude|late-progress"]').evaluate(row => { row.style.paddingBottom = '270px'; });
      await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'late layout above report preserves its visible paragraph');
      // Changes inside a long report also need a paragraph anchor, not just its outer row.
      await page.locator('[data-story-key="claude|report"] .story-body p').first().evaluate(p => { p.style.minHeight = '330px'; });
      await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'late layout inside report preserves reading position');
      await page.evaluate(() => story.loadEarlierStory()); await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'manual prepend uses the same content anchor');
      await page.locator('#hide').click();
      revision++; await page.evaluate(() => story.refreshStory());
      await page.locator('#show').click(); await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'hidden refresh restores the report, not an old pixel offset');
      // Collapsing content can clamp a reading position to the bottom. That layout scroll is NOT an
      // instruction to follow new messages. When space returns, restore the same paragraph.
      await page.locator('[data-story-key="claude|report"] .story-body p').evaluateAll(paragraphs => {
        paragraphs.slice(7).forEach(p => { p.hidden = true; });
      });
      await settle(page);
      await page.locator('[data-story-key="claude|report"] .story-body p').evaluateAll(paragraphs => {
        paragraphs.forEach(p => { p.hidden = false; });
      });
      await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'layout clamping never opts a reader into following');
      tail = true; update(); await page.waitForFunction(() => document.querySelector('[data-story-key="claude|tail"]'));
      await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'appending does not interrupt reading');
      gap = true; revision++; const requestsBeforeGap = historyRequests;
      update(); await page.waitForFunction(() => document.querySelector('[data-story-key="claude|reconnect"]'));
      await settle(page);
      assert.equal(historyRequests, requestsBeforeGap + 1, 'reconnect fills one bounded gap page');
      assert.ok(Math.abs(await position(page) - before) <= 2, 'background gap catch-up preserves the paragraph as well');
      gap = false;
      report.body = 'A new annotation above the existing report.\n\n' + originalBody;
      update(); await page.waitForFunction(() => document.querySelector('[data-story-key="claude|report"]')?.textContent.includes('A new annotation'));
      await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'replaced report DOM finds the same paragraph after inserted text');
      await page.setViewportSize({ width: width - 80, height: 760 }); await settle(page);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'viewport reflow preserves the visible paragraph');
      await page.locator('[data-story-latest]').click(); await bottom(page);
      revision++; update(); await page.waitForFunction(n => document.querySelector('[data-story-key="claude|late-progress"]')?.textContent.includes(`Late progress ${n}.`), revision);
      await bottom(page);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine: engine.name(), width, readingAnchor: true, liveUpdates: true,
        delayedLayout: true, prepend: true, hiddenRefresh: true, layoutClamping: true, gapCatchup: true,
        reportReplacement: true, viewportReflow: true, latest: true }));
      await page.evaluate(() => story.destroyStoryView());
    } finally { await browser.close(); }
  }
} finally { for (const stream of streams) stream.end(); await new Promise(resolve => server.close(resolve)); }
