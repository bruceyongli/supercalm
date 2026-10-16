import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const sessions = [
  { id: 's_one', title: 'SC improvements', project: 'aios', tool: 'codex', status: 'working', summary: 'Repeated grey brief should disappear', last_activity: Date.now() },
  { id: 's_two', title: 'Agentic tutoring', project: 'elevate', tool: 'codex', status: 'working', last_activity: Date.now() },
  { id: 's_three', title: 'Companion video testing', project: 'friends', tool: 'claude', status: 'working', last_activity: Date.now() },
  { id: 's_old', title: 'Older report', project: 'A very long project name', tool: 'claude', status: 'waiting', last_activity: Date.now() - 3 * 86_400_000 },
];
let requests = [], sample = 1, failed = false;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
  if (path === '/aios/api/phone/home') return json(res, { sessions, counts: { working: 3, waiting: 1, live: 4 } });
  if (path === '/aios/api/version') return json(res, { version: 'test', channel: 'every' });
  if (path === '/aios/api/auth/status') return json(res, { mode: 'cli' });
  if (path === '/aios/api/product/resources/sessions') {
    const ids = url.searchParams.get('ids').split(','); requests.push(ids);
    if (failed) { res.writeHead(503); return res.end('unavailable'); }
    return json(res, { checked_at: Date.now(), state: 'ready', sessions: ids.map((id, i) => ({ id,
      cpu_percent: sample === 1 ? [4.7, 2.3, 143.4, 0][i] : 62, memory_bytes: [310e6, 1.2e9, 3.4e9, 150e6][i],
      memory_kind: 'footprint', checked_at: Date.now(), disk_bytes: [18e8, 7e8, 32e9, 0][i], disk_checked_at: Date.now(), disk_pending: false })) });
  }
  if (path.startsWith('/aios/api/')) return json(res, {});
  let name = path.replace(/^\/aios\/?/, '') || 'app.html';
  if (!extname(name)) name = 'app.html';
  const file = normalize(join(webRoot, name));
  if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
  for (const width of [1440, 820, 390]) {
    requests = []; sample = 1; failed = false;
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.**/*', route => route.abort());
    await page.addInitScript(() => {
      window.EventSource = class { addEventListener() {} close() {} };
      window.realNow = Date.now.bind(Date); window.offset = 0; Date.now = () => window.realNow() + window.offset;
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/aios/?desktop=1`);
    await page.locator('[data-dk-sess][data-sid="s_one"]').waitFor({ state: 'attached' });
    if (width === 390) {
      await page.waitForTimeout(350);
      assert.equal(requests.length, 0, 'closed mobile drawer makes no resource requests');
      await page.locator('#dk-menu-btn').click();
    }
    const line = page.locator('[data-dk-sess][data-sid="s_one"] .dk-sess-l2');
    await page.waitForFunction(() => document.querySelector('[data-sid="s_one"] [data-resource="cpu"] .dk-res-value')?.textContent === '4.7%');
    assert.doesNotMatch(await line.innerText(), /Repeated grey/);
    assert.match(await line.innerText(), /aios[\s\S]*CPU[\s\S]*4\.7%[\s\S]*RAM[\s\S]*Disk/);
    assert.ok(requests[0].length >= 3, 'one request batches the visible sessions');
    assert.equal(requests.flat().includes('s_old'), false, 'closed older group is not measured');
    await page.evaluate(() => {
      window.beforeRow = document.querySelector('[data-dk-sess][data-sid="s_one"]');
      window.beforeDot = beforeRow.querySelector('.dk-dot'); window.beforeValue = beforeRow.querySelector('[data-resource="cpu"] .dk-res-value');
      window.order = [...document.querySelectorAll('[data-dk-sess]')].map(el => el.dataset.sid).join(',');
    });
    if (width === 1440 && process.env.AIOS_RESOURCE_SCREENSHOT) await page.locator('.dk-side').screenshot({ path: process.env.AIOS_RESOURCE_SCREENSHOT });
    sample = 2;
    await page.evaluate(() => { offset += 16_000; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => beforeValue.textContent === '62%');
    await page.evaluate(async () => {
      const { upsertSession } = await import('/aios/shell.js');
      upsertSession({ id: 's_one', summary: 'An unrelated status patch', last_activity: Date.now() });
    });
    assert.equal(await page.evaluate(() => beforeRow === document.querySelector('[data-dk-sess][data-sid="s_one"]')
      && beforeDot === beforeRow.querySelector('.dk-dot') && beforeValue === beforeRow.querySelector('[data-resource="cpu"] .dk-res-value')
      && beforeValue.textContent === '62%' && order === [...document.querySelectorAll('[data-dk-sess]')].map(el => el.dataset.sid).join(',')), true,
    'resource ticks and session SSE preserve row, pulse, value nodes and list order');
    await page.locator('#dk-older-side > summary').click();
    await page.waitForFunction(() => document.querySelector('[data-sid="s_old"] [data-resource="cpu"] .dk-res-value')?.textContent !== '—');
    assert.equal(requests.flat().includes('s_old'), true);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.dk-sess-l2')].every(el => el.scrollWidth <= el.clientWidth + 1)), true, 'metrics fit the narrow rail without clipping');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    failed = true;
    await page.evaluate(() => { offset += 16_000; window.dispatchEvent(new Event('focus')); });
    await page.waitForSelector('[data-sid="s_one"] .dk-res-metric.is-stale');
    assert.equal(await page.locator('[data-sid="s_one"] [data-resource="cpu"] .dk-res-value').first().innerText(), '62%', 'network failure retains last value and marks stale');
    const beforeHide = requests.length;
    await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); offset += 16_000; window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(400);
    assert.equal(requests.length, beforeHide, 'background page stays suspended until pageshow');
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForRequest(req => req.url().includes('/resources/sessions'));
    await page.waitForTimeout(100);
    const before = requests.length;
    if (width === 390) await page.locator('#dk-menu-btn').click();
    else await page.evaluate(() => document.body.classList.add('dk-collapsed'));
    await page.evaluate(() => { offset += 16_000; window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(400);
    assert.equal(requests.length, before, 'hidden sidebar does not poll');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine: engine.name(), width, batch: true, updates: 'in-place', hidden: 'no requests', unknown: 'dash', failure: 'stale retained' }));
    await page.close();
  }
  } finally { await browser.close(); }
}
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('session_resources_browser passed');
