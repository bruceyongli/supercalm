import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url)).replace(/\/$/, '');
const now = Date.now();
const initial = { id: 's_capacity', title: 'SemaMorph implementation', project: 'SemaMorph', tool: 'codex',
  status: 'waiting', provider_issue: null, revision: 1, last_activity: now, unread: 0 };
let session = { ...initial };
const streams = new Set(), mutations = [];
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (req.method === 'POST') mutations.push(path);
  if (path === '/aios/api/events' || path.endsWith('/story/updates')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (path === '/aios/api/phone/home') return json(res, { sessions: [session], counts: { waiting: 1, live: 1 } });
  if (path === '/aios/api/version') return json(res, { version: 'test', channel: 'every' });
  if (path === '/aios/api/auth/status') return json(res, { mode: 'cli' });
  if (path === '/aios/api/tools/versions') return json(res, { tools: [{ installed: true }] });
  if (path === '/aios/api/models/providers') return json(res, { providers: [] });
  if (path === '/aios/api/session/s_capacity') return json(res, { ...session,
    project: { id: 'p_fixture', name: 'SemaMorph' }, messages: [], events: [], composer_history: [] });
  if (path === '/aios/api/session/s_capacity/story') return json(res, { events: [], status: session.status });
  if (path.startsWith('/aios/api/')) return json(res, {});
  let name = path.replace(/^\/aios\/?/, '') || 'app.html';
  if (name === 'phone') name = 'phone.html';
  if (!extname(name)) name = 'app.html';
  const file = normalize(join(webRoot, name));
  if (!file.startsWith(webRoot + '/')) { res.writeHead(403); res.end(); return; }
  try { res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/aios/`;
function update(patch) {
  session = { ...session, ...patch, revision: session.revision + 1 };
  for (const res of streams) res.write(`event: session-status\ndata: ${JSON.stringify({ ...session, session: session.id, source: 'poll' })}\n\n`);
}
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [1440, 820, 390]) {
        session = { ...initial };
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        // Exercise the interactive connection path; the app otherwise defers SSE 20s for headless
        // network-idle audits. This test deliberately requires a continuously open real stream.
        await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
        await page.route('https://fonts.**/*', route => route.abort());
        await page.goto(base + '?desktop=1', { waitUntil: 'domcontentloaded' });
        const rail = '[data-dk-sess][data-sid="s_capacity"] .dk-dot';
        await page.locator(rail).waitFor({ state: 'attached' });
        const streamDeadline = Date.now() + 5000;
        while (!streams.size && Date.now() < streamDeadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(streams.size, 'the real status event stream is connected');
        if (width === 390) await page.locator('#dk-menu-btn').click();
        await page.evaluate(selector => { window.originalDot = document.querySelector(selector); }, rail);
        update({ provider_issue: { code: 'capacity', phase: 'blocked' }, category: 'action', stage: 'blocked',
          question: 'Model at capacity. Retry later or choose another model.', summary: 'Model at capacity.', unread: 1,
          last_key: { id: 1, text: 'Model at capacity.', ts: now } });
        await page.waitForFunction(selector => document.querySelector(selector)?.classList.contains('error'), rail);
        assert.equal(await page.locator(rail).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(248, 81, 73)');
        assert.match(await page.locator(rail).getAttribute('aria-label'), /Blocked: model at capacity/);
        assert.equal(await page.locator('[data-dk-row][data-sid="s_capacity"] .dk-status').textContent(), 'Model at capacity');
        assert.equal(await page.locator('[data-dk-card][data-sid="s_capacity"] .dk-card-kind').textContent(), 'BLOCKED');
        assert.equal(await page.evaluate(selector => originalDot === document.querySelector(selector), rail), true, 'live patches retain the status node');
        update({ provider_issue: { code: 'billing', phase: 'blocked' } });
        await page.waitForFunction(() => document.querySelector('[data-dk-row][data-sid="s_capacity"] .dk-status')?.textContent === 'Provider credits required');
        assert.match(await page.locator('[data-dk-card][data-sid="s_capacity"]').innerText(), /credits or billing/);
        assert.doesNotMatch(await page.locator('[data-dk-card][data-sid="s_capacity"]').innerText(), /capacity/i, 'other provider failures do not inherit capacity-only copy');
        update({ status: 'working', provider_issue: { code: 'capacity', phase: 'retrying' }, category: null, stage: 'executing' });
        await page.waitForFunction(() => document.querySelector('[data-dk-row][data-sid="s_capacity"] .dk-status')?.textContent === 'Retrying');
        assert.equal(await page.locator('[data-dk-card][data-sid="s_capacity"]').count(), 0, 'automatic retry removes the attention card');
        update({ status: 'working', provider_issue: null, question: null, summary: null });
        await page.waitForFunction(selector => document.querySelector(selector)?.classList.contains('ok'), rail);
        assert.equal(await page.evaluate(selector => originalDot === document.querySelector(selector), rail), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (width === 1440) {
          update({ status: 'waiting', provider_issue: { code: 'capacity', phase: 'blocked' } });
          await page.locator('[data-dk-sess][data-sid="s_capacity"]').click();
          await page.waitForFunction(() => document.querySelector('#s-status')?.textContent === 'Model at capacity');
          assert.equal(await page.locator('#s-status').evaluate(el => getComputedStyle(el).color), 'rgb(242, 85, 77)');
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ engine: engine.name(), width, transport: 'real SSE', transition: 'yellow -> red blocked -> retrying -> green', stableDot: true }));
        await page.close();
      }
      // The standalone phone/PWA surface consumes the same server field, not a separate heuristic.
      session = { ...initial, provider_issue: { code: 'capacity', phase: 'blocked' } };
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await phone.goto(base + 'phone', { waitUntil: 'domcontentloaded' });
      await phone.waitForFunction(() => [...document.querySelectorAll('.sessstatus')].some(el => el.textContent === 'Model at capacity'));
      assert.equal(await phone.locator('.sessrow .dot').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(248, 81, 73)');
      await phone.close();
    } finally { await browser.close(); }
  }
  assert.equal(mutations.some(path => /\/(?:input|resume|stop|kill|settings)$/.test(path)), false, 'status presentation never drives an agent');
} finally {
  for (const res of streams) res.end();
  await new Promise(resolve => server.close(resolve));
}
console.log('provider_status_browser.test ok');
