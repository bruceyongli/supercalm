import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const assets = new Map(['story-view.js', 'story-request.js', 'story-live.js', 'common.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
const states = new Map();
const payload = (sid, revision, padding = '') => JSON.stringify({ ok: true, status: 'waiting', events: [
  { kind: 'you', ts: 1, body: `Request for ${sid}` },
  { kind: 'report', ts: 2, messageId: `${sid}-report`, body: `Grounded report for ${sid}, revision ${revision}.\n\n项目更新：修复已完成。` },
], meta: { source: 'transcript', file: `${sid}.jsonl`, padding } });
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(assets.get(url.pathname)); }
  const match = url.pathname.match(/^\/api\/session\/([^/]+)\/story(\/updates)?$/);
  if (match) {
    const sid = match[1], s = states.get(sid);
    if (!s) { res.writeHead(404); return res.end(); }
    if (match[2]) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      s.streams.add(res); res.on('close', () => s.streams.delete(res)); return;
    }
    s.requests++;
    if (s.hold) { s.held = res; s.hold = false; return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders();
    if (s.drop > 0) { s.drop--; res.write('{"events":['); setTimeout(() => res.destroy(), 50); return; }
    if (s.slow && s.requests === 1) {
      const body = Buffer.from(payload(sid, s.revision, 'x'.repeat(1_650_000))); let offset = 0;
      const timer = setInterval(() => {
        res.write(body.subarray(offset, offset + 32768)); offset += 32768;
        if (offset >= body.length) { s.completedSlow = true; clearInterval(timer); res.end(); }
      }, 450); // ~23s: real browser transport must survive the former total 20s deadline
      res.on('close', () => { clearInterval(timer); if (!s.completedSlow) s.cancelledSlow = true; }); return;
    }
    return res.end(payload(sid, s.revision));
  }
  const sid = url.searchParams.get('sid');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>.story-feed{height:380px;overflow:auto}</style><div id="story"></div>
    <script type="module">import * as story from '/story-view.js'; window.story=story;
    window.fixtureHidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>fixtureHidden});
    window.observedText=[];new MutationObserver(()=>observedText.push(document.querySelector('#story').textContent)).observe(document.querySelector('#story'),{childList:true,subtree:true,characterData:true});
    await story.initStoryView({sessionId:${JSON.stringify(sid)},panel:document.querySelector('#story'),live:true});window.ready=true;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const state = opts => ({ requests: 0, revision: 1, streams: new Set(), ...opts });
const notify = (sid, s) => { for (const res of s.streams) res.write(`event: update\ndata: ${JSON.stringify({ session: sid })}\n\n`); };
const wait = async check => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('fixture did not settle'); await new Promise(r => setTimeout(r, 10)); } };
try {
  for (const [engine, type, width] of [['chromium', chromium, 390], ['webkit', webkit, 820]]) {
    const browser = await type.launch({ headless: true });
    try {
      const sid = `s_network_${engine}`, s = state({ drop: 1 }); states.set(sid, s);
      const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: true, isMobile: true });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        const original = window.fetch; let first = true;
        window.fetch = (...args) => {
          if (String(args[0]).endsWith('/story') && first) { first = false; return Promise.reject(new DOMException('Fetch is aborted.', 'AbortError')); }
          return original(...args);
        };
      });
      await page.goto(base + '?sid=' + sid);
      await page.waitForFunction(() => document.querySelector('[data-kind="report"]'), null, { timeout: 15000 });
      assert.ok(s.requests >= 2, 'initial WebKit AbortError and partial body both recover without refresh');
      assert.doesNotMatch((await page.evaluate(() => observedText)).join('\n'), /story unavailable|Fetch is aborted/i);
      // A later failed refresh must preserve the existing report DOM and cross-navigation cache.
      await page.evaluate(() => { window.savedReport=document.querySelector('[data-kind="report"]'); });
      const cached = await page.evaluate(sid => sessionStorage.getItem('aios_story11_' + sid), sid);
      s.drop = 1;
      assert.equal(await page.evaluate(() => story.refreshStory({ quiet: false })), false);
      assert.equal(await page.evaluate(() => savedReport === document.querySelector('[data-kind="report"]')), true);
      assert.equal(await page.evaluate(sid => sessionStorage.getItem('aios_story11_' + sid), sid), cached);
      s.revision = 2; notify(sid, s);
      await page.waitForFunction(() => document.querySelector('[data-kind="report"]').textContent.includes('revision 2'), null, { timeout: 10000 }).catch(async error => {
        console.error(JSON.stringify({ engine, requests: s.requests, revision: s.revision, streams: s.streams.size, errors, body: await page.locator('#story').innerText() })); throw error;
      });
      // iPad suspension cancels the old request and resumes from the current session, without a raw error.
      s.hold = true;
      await page.evaluate(() => { void story.refreshStory(); }); await wait(() => s.held);
      await page.evaluate(() => { fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange')); });
      await wait(() => s.streams.size === 0);
      s.revision = 3;
      await page.evaluate(() => { fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => document.querySelector('[data-kind="report"]').textContent.includes('revision 3'));
      // A late old response cannot replace the resumed report.
      s.held.end(payload(sid, 2));
      await page.waitForTimeout(100);
      assert.match(await page.locator('[data-kind="report"]').innerText(), /revision 3/);
      assert.doesNotMatch((await page.evaluate(() => observedText)).join('\n'), /story unavailable|Fetch is aborted/i);
      assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine, width, initialAbortRecovered: true, partialBodyRetried: true, cachedReportPreserved: true, suspensionRecovered: true, reloads: 0 }));
      await page.close();
      if (engine === 'webkit') {
        const slowId = 's_slow_ipad', slow = state({ slow: true }); states.set(slowId, slow);
        const ipad = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: true, hasTouch: true });
        const start = Date.now();
        await ipad.goto(base + '?sid=' + slowId);
        await ipad.waitForFunction(() => window.ready && document.querySelector('[data-kind="report"]'), null, { timeout: 45000 });
        assert.equal(slow.completedSlow, true);
        assert.notEqual(slow.cancelledSlow, true, 'a >20s progressing response is never aborted');
        assert.match(await ipad.locator('[data-kind="report"]').innerText(), /项目更新：修复已完成/);
        console.log(JSON.stringify({ engine, width, slowDownloadMs: Date.now() - start, jsonBytes: 1_650_000, completedWithoutAbort: true }));
        await ipad.close();
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log('story_network_browser: Safari/iPad and phone cancellation, partial-download recovery and progressive loading passed');
