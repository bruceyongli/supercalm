import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const assets = new Map([
  ['/views/records.js', readFileSync(new URL('web/views/records.js', root))],
  ['/common.js', readFileSync(new URL('web/common.js', root))],
]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = `<!doctype html><meta charset="utf-8"><body><main id="view"></main>
<script type="module">
  window.rejections = [];
  addEventListener('unhandledrejection', (event) => window.rejections.push(String(event.reason?.stack || event.reason)));
  window.recordsView = await import('/views/records.js');
  window.recordsReady = true;
</script>`;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(assets.get(path));
    return;
  }
  if (path === '/api/state') {
    await delay(120);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      projects: [{ id: 'p1', name: 'Project one' }],
      sessions: [{ id: 's1', tool: 'codex', model: 'gpt-test', project: { name: 'Project one' } }],
    }));
    return;
  }
  if (path === '/api/records') {
    await delay(120);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ records: [] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fixture);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.recordsReady);

  await page.evaluate(() => {
    const host = document.querySelector('#view');
    window.recordsView.init(host);
    window.recordsView.teardown();
    host.innerHTML = '<section id="next-view">Usage view survived</section>';
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#next-view').innerText(), 'Usage view survived',
    'a late Records continuation never mutates the next route');
  assert.deepEqual(await page.evaluate(() => window.rejections), [],
    'tearing down Records with state and record requests in flight raises no unhandled rejection');

  await page.evaluate(() => window.recordsView.init(document.querySelector('#view')));
  await page.waitForFunction(() => document.querySelector('#rc-list')?.textContent.includes('No records match.'));
  assert.equal(await page.locator('#rc-project option').count(), 2,
    'a later Records remount receives exactly one generation of project options');
  assert.deepEqual(await page.evaluate(() => window.rejections), []);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('records_teardown_browser.test ok');
