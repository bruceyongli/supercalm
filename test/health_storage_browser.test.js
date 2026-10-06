import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const assets = new Map(['views/health.js', 'health-storage.js', 'common.js', 'markdown-inline.js', 'file-reference.js']
  .map(name => [`/${name}`, readFileSync(new URL(`../web/${name}`, import.meta.url))]));
const component = { label: 'Terminal log', path: '/private/fixture/logs/s_killed.log', exclusive_bytes: 4096, bytes: 4096 };
const rows = [
  { id: 's_killed', title: 'Old killed project', project_id: 'p1', project: 'Fixture', cleanable: true, deletable: true, reason: 'Killed by operator', bytes: 14 * 1024 ** 3, disposable_bytes: 4096, output_bytes: 14 * 1024 ** 3 - 4096, components: [component] },
  { id: 's_stopped', title: 'Resumable stopped project', project_id: 'p1', project: 'Fixture', cleanable: true, deletable: false, reason: 'Stopped; history is resumable', bytes: 4096, disposable_bytes: 4096, components: [component] },
  { id: 's_running', title: 'Live session cannot be deleted', project_id: 'p1', project: 'Fixture', cleanable: false, deletable: false, status: 'working', bytes: 100 * 1024 ** 3, disposable_bytes: 0, components: [] },
];
let scan = 1, scanning = false, storageCalls = 0, capacityCalls = 0, cleanupCalls = [], planCalls = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(assets.get(path)); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const json = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (path === '/api/product/health') return json({ version: 'fixture', auth: { mode: 'cli', providers: [] }, sessions: {},
    graphs: [{ name: 'Supervisor Data Factory', path: '/private/fixture/a-very-long-project-folder-name/another-long-directory-name/project', status: 'indexed', counts: { symbols: 12893, files: 3003, relations: 37685 } }], issues: [] });
  if (path === '/api/product/storage/capacity') { capacityCalls++; return json({
    capacity: { available_bytes: 19 * 1024 ** 3, total_bytes: 500 * 1024 ** 3, level: 'warning', checked_at: Date.now() },
    database: { file_bytes: 13 * 1024 ** 3, reusable_bytes: 11 * 1024 ** 3 } }); }
  if (path === '/api/product/storage') { storageCalls++; return json({ state: scanning ? 'scanning' : 'ready', scanned_at: scanning ? undefined : scan,
    capacity: { available_bytes: 20 * 1024 ** 3, total_bytes: 500 * 1024 ** 3, level: 'warning' },
    database: { file_bytes: 13 * 1024 ** 3, reusable_bytes: 11 * 1024 ** 3 }, disposable_bytes: scanning ? undefined : 8192,
    projects: scanning ? [] : [{ id: 'p1', name: 'Fixture', path: '/private/fixture', source_bytes: 1024, session_bytes: 2048 }], sessions: scanning ? [] : rows, shared: [] }); }
  if (path === '/api/product/storage/plan') {
    const parsed = JSON.parse(body); planCalls.push(parsed);
    return json({ id: `plan-${planCalls.length}`, mode: parsed.mode, estimated_bytes: 4096, preserved: ['Project source folders', 'Native CLI history'],
      sessions: parsed.sessions.map(id => ({ id, title: id, project: 'Fixture', targets: [component], retained: [] })) });
  }
  if (path === '/api/product/storage/cleanup') {
    cleanupCalls.push(JSON.parse(body));
    return json({ results: [{ id: 's_killed', ok: true }], estimated_bytes: 4096, net_available_change_bytes: -2 * 1024 ** 3,
      capacity_after: { available_bytes: 18 * 1024 ** 3 }, note: 'Confirmed cleanup receipt.' });
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0}.shell{display:flex}aside{width:280px;flex-shrink:0}#view{flex:1;min-width:0}main{margin:0 auto}@media(max-width:800px){aside{display:none}}</style><div class="shell"><aside></aside><main id="view"></main></div><script type="module">window.errors=[];addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));window.health=await import('/views/health.js');window.health.init(document.querySelector('#view'));</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    scanning = true;
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('[data-storage-overview]')?.textContent.includes('stopped-session temp/logs measuring'));
    assert.doesNotMatch(await page.locator('[data-storage-overview]').innerText(), /temp\/logs 0 B/,
      'an unfinished scan never claims zero cleanup bytes');
    scanning = false; await page.locator('[data-storage-refresh]').click();
    await page.waitForSelector('[data-storage-session="s_killed"]');
    assert.match(await page.locator('[data-storage-overview]').innerText(), /11\.0 GiB reusable inside the database, not free disk space/);
    assert.equal(await page.locator('[data-storage-session="s_running"]').count(), 0);
    await page.locator('[data-storage-session="s_killed"]').check();
    assert.match(await page.locator('[data-storage-selection]').innerText(), /temp\/logs only: approximately 4\.0 KiB/);
    assert.doesNotMatch(await page.locator('[data-storage-selection]').innerText(), /14\.0 GiB/,
      'session total is never represented as selected temp/log cleanup amount');
    await page.locator('[data-storage-list] details summary').first().click();
    const reads = storageCalls, capacityReads = capacityCalls;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('[data-storage-overview]').textContent.includes('19.0 GiB available'));
    assert.equal(storageCalls, reads, 'fresh capacity does not rescan or download the complete inventory');
    assert.ok(capacityCalls > capacityReads);
    await page.locator('[data-storage-refresh]').click();
    await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-storage-session="s_killed"]').isChecked(), true);
    assert.equal(await page.locator('[data-storage-list] details').first().getAttribute('open'), '');
    await page.locator('[data-storage-mode]').selectOption('delete');
    assert.equal(await page.locator('[data-storage-session="s_stopped"]').isDisabled(), true);
    await page.locator('[data-storage-clean]').click();
    await page.waitForSelector('.storage-confirm[open]');
    assert.equal(await page.locator('[data-confirm]').isDisabled(), true);
    const before = cleanupCalls.length;
    await page.locator('[data-cancel]').click();
    assert.equal(cleanupCalls.length, before, 'cancel never invokes cleanup');
    await page.locator('[data-storage-clean]').click();
    await page.locator('[data-confirm-irreversible]').check();
    await page.locator('[data-confirm]').click();
    await page.waitForFunction(() => document.querySelector('[data-storage-result]').textContent.includes('Confirmed cleanup receipt'));
    assert.match(await page.locator('[data-storage-result]').innerText(), /removed file blocks 4\.0 KiB/);
    assert.match(await page.locator('[data-storage-result]').innerText(), /Disk net change during cleanup: −2\.0 GiB; 18\.0 GiB available afterward/,
      'concurrent writes can reduce free space despite successful deletion');
    assert.equal(cleanupCalls.length, before + 1);
    assert.equal(cleanupCalls.at(-1).confirm, true);
    assert.deepEqual(planCalls.at(-1), { sessions: ['s_killed'], mode: 'delete' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no whole-page horizontal overflow');
    await page.evaluate(() => { window.health.teardown(); document.querySelector('#view').innerHTML = '<div id="next">Next view</div>'; window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#next').innerText(), 'Next view'); assert.deepEqual(await page.evaluate(() => window.errors), []);
    console.log(JSON.stringify({ viewport, selected: 'retained', running: 'not selectable', stopped: 'not deletable', confirm: 'explicit', cleanupRequests: 1, teardown: 'safe' }));
    await page.close(); scan++;
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('health_storage_browser.test passed');
