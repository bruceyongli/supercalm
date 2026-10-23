import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url)).replace(/\/$/, '');
const now = Date.now(), old = now - 57 * 86400000;
const blocked = { code: 'capacity', phase: 'blocked' };
const fixture = () => [
  { id: 's_old_blocked', title: '# SemaMorph Long-Run Experiment & Discovery Plan', project: 'SemaMorph', tool: 'codex',
    status: 'waiting', provider_issue: blocked, revision: 1, last_activity: old, unread: 1, category: 'action',
    question: 'Model at capacity. Retry later or choose another model.', last_key: { id: 1, ts: now, text: 'Model at capacity.' } },
  ...Array.from({ length: 14 }, (_, i) => ({ id: `s_wait_${i}`, title: `Waiting task ${i}`, project: 'Other project',
    tool: 'claude', status: 'waiting', revision: 1, last_activity: now, unread: 0 })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `s_work_${i}`, title: `Working task ${i}`, project: 'Other project',
    tool: 'codex', status: 'working', revision: 1, last_activity: now, unread: 0 })),
];
let sessions = fixture();
const streams = new Set(), mutations = [];
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (!['GET', 'HEAD'].includes(req.method)) mutations.push(path);
  if (path === '/aios/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (path === '/aios/api/phone/home') return json(res, { sessions, counts: {} });
  if (path === '/aios/api/version') return json(res, { version: 'test', channel: 'every' });
  if (path === '/aios/api/auth/status') return json(res, { mode: 'cli' });
  if (path === '/aios/api/tools/versions') return json(res, { tools: [{ installed: true }] });
  if (path === '/aios/api/models/providers') return json(res, { providers: [] });
  if (path.startsWith('/aios/api/')) return json(res, {});
  let name = path.replace(/^\/aios\/?/, '') || 'app.html';
  if (!extname(name)) name = 'app.html';
  const file = normalize(join(webRoot, name));
  if (!file.startsWith(webRoot + '/')) { res.writeHead(403); res.end(); return; }
  try { res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/aios/`;
function update(id, patch) {
  const previous = sessions.find(s => s.id === id);
  const row = { ...previous, ...patch, id, revision: (previous?.revision || 0) + 1 };
  sessions = previous ? sessions.map(s => s.id === id ? row : s) : [...sessions, row];
  for (const res of streams) res.write(`event: session-status\ndata: ${JSON.stringify({ ...row, session: id, source: 'poll' })}\n\n`);
}
const evidence = process.env.AIOS_TEST_SCREENSHOTS;
if (evidence) await mkdir(evidence, { recursive: true });
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [1440, 820, 390]) {
        sessions = fixture();
        const page = await browser.newPage({ viewport: { width, height: 950 }, hasTouch: width < 1000 });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
        await page.route('https://fonts.**/*', route => route.abort());
        await page.goto(base + '?desktop=1', { waitUntil: 'domcontentloaded' });
        const blockedLink = page.locator('[data-status-filter="blocked"]');
        await blockedLink.waitFor({ state: 'attached' });
        if (width === 390) await page.locator('#dk-menu-btn').click();
        assert.match(await blockedLink.textContent(), /1 blocked/);
        assert.equal(await page.locator('#dk-live-count').textContent(), '20');
        assert.equal(await page.locator('[data-dk-sess][data-sid="s_old_blocked"]').isVisible(), false, 'old sessions remain collapsed by default');
        const geometry = await page.locator('#dk-counters').evaluate(el => [...el.children].map(link => {
          const r = link.getBoundingClientRect(), text = document.createRange(); text.selectNodeContents(link.querySelector('span'));
          return { y: r.y, right: r.right, parentRight: el.getBoundingClientRect().right, lines: text.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(link).lineHeight) };
        }));
        assert.ok(geometry.every(g => Math.abs(g.y - geometry[0].y) < 1 && g.right <= g.parentRight + 1 && g.lines <= g.lineHeight + 1), 'the exact 1/14/5 counts fit on one line without split labels');
        if (evidence && engine === chromium) await page.locator('#dk-counters').screenshot({ path: join(evidence, `counters-${width}.png`) });
        await page.evaluate(() => { window.statusNavigationSentinel = true; });
        if (width === 1440) { await blockedLink.focus(); await blockedLink.press('Enter'); } else await blockedLink.click();
        await page.locator('#dk-status-results [data-sid="s_old_blocked"]').waitFor();
        assert.equal(new URL(page.url()).searchParams.get('status'), 'blocked');
        assert.equal(await page.evaluate(() => window.statusNavigationSentinel), true, 'count navigation retains the current document');
        assert.equal(await page.locator('[data-status-result]').count(), 1);
        assert.equal(await blockedLink.getAttribute('aria-current'), 'page');
        assert.match(await page.locator('[data-status-result]').textContent(), /SemaMorph.*57d ago[\s\S]*model at capacity/i);
        assert.equal(await page.locator('[data-status-result]').getAttribute('href'), 'session?id=s_old_blocked');
        if (width === 390) {
          assert.equal(await page.locator('body').evaluate(el => el.classList.contains('dk-drawer')), false, 'navigation closes the phone drawer');
          await page.waitForFunction(() => document.querySelector('#dk-side').getBoundingClientRect().right <= 0);
        }
        if (evidence && engine === chromium && width !== 820) await page.screenshot({ path: join(evidence, `blocked-${width}.png`) });
        // All counts are useful navigation, and filtering never edits attention or session state.
        await page.goto(base + '?status=waiting', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelectorAll('[data-status-result]').length === 14);
        assert.equal(await page.locator('[data-status-result][data-sid="s_old_blocked"]').count(), 0);
        await page.goto(base + '?status=working', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelectorAll('[data-status-result]').length === 5);
        await page.goto(base + '?status=blocked', { waitUntil: 'domcontentloaded' });
        await page.locator('[data-status-result]').waitFor();
        await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.includes('/api/phone/home')));
        const deadline = Date.now() + 5000;
        while (!streams.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(streams.size, 'status SSE connected');
        update('s_dismissed', { ...fixture()[0], title: 'Dismissed capacity report', dismissed: true, unread: 0 });
        await page.waitForFunction(() => document.querySelectorAll('[data-status-result]').length === 2);
        assert.equal(await page.locator('#dk-status-count').textContent(), '2');
        assert.match(await page.locator('[data-sid="s_dismissed"][data-status-result]').textContent(), /Report dismissed/);
        await page.evaluate(() => { window.countLink = document.querySelector('[data-status-filter="blocked"]'); });
        update('s_old_blocked', { status: 'working', provider_issue: null });
        update('s_dismissed', { status: 'working', provider_issue: null });
        await page.locator('.dk-status-empty').waitFor();
        assert.equal(await page.locator('#dk-status-count').textContent(), '0');
        assert.equal(await page.evaluate(() => countLink === document.querySelector('[data-status-filter="blocked"]')), true, 'counter keeps keyboard focus/node across updates');
        await page.locator('.dk-status-back').click();
        await page.locator('#dk-inbox').waitFor();
        assert.equal(await page.locator('[data-status-filter="blocked"]').count(), 0);
        assert.equal(await page.locator('#dk-cards [data-sid="s_dismissed"]').count(), 0, 'filtering never restores a dismissed report');
        assert.equal(sessions.find(s => s.id === 's_old_blocked').last_activity, old);
        assert.equal(sessions.find(s => s.id === 's_dismissed').dismissed, true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1, 'in-app count navigation does not reload');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ engine: engine.name(), width, counters: 'single line 1/14/5', blocked: 'old and dismissed discoverable', updates: 'real SSE', mutations: mutations.length }));
        await page.close();
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(mutations, [], 'status navigation is read-only');
} finally {
  for (const res of streams) res.end();
  await new Promise(resolve => server.close(resolve));
}
console.log('session_status_navigation_browser.test ok');
