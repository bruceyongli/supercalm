import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Exercise the actual SPA's delegated Story handler and xterm link provider,
// not a second implementation of their click logic. All API data is isolated.
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const session = { id: 's_web_links_fixture', tool: 'claude', toolLabel: 'Claude', status: 'waiting',
  title: 'Web links fixture', autonomy: 'full', effort: 'high', model: '', revision: 1,
  project: { name: 'Fixture', path: '/fixture' }, composer_history: [] };
let base, body;
const fileRequests = [], webRequests = [], mutations = [];
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
  if (req.method !== 'GET') mutations.push({ method: req.method, path });
  if (path === '/aios/api/session/s_web_links_fixture') return json(res, session);
  if (path === '/aios/api/session/s_web_links_fixture/story') return json(res,
    { ok: true, events: [{ kind: 'report', ts: 1700000000000, body }], status: 'waiting', meta: {} });
  if (path === '/aios/api/session/s_web_links_fixture/file') {
    fileRequests.push(url.searchParams.get('path'));
    return json(res, { path: 'report.md', contentKind: 'text', viewUrl: '/aios/fixture-source.txt', downloadUrl: '/aios/fixture-source.txt' });
  }
  if (path === '/aios/fixture-source.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Local preview still works.'); }
  if (path === '/aios/api/phone/home') return json(res, { sessions: [], counts: {} });
  if (path === '/aios/api/launch-options') return json(res, { projects: [], tools: [] });
  if (path === '/aios/api/version') return json(res, { version: 'test', channel: 'every' });
  if (path.startsWith('/aios/api/')) return json(res, {});
  if (!path.startsWith('/aios')) {
    webRequests.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><h1>Hosted report opened</h1>');
  }
  let name = path.replace(/^\/aios\/?/, '') || 'app.html';
  if (!extname(name)) name = 'app.html';
  const file = normalize(join(webRoot, name));
  if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
const report = base + '/morph-data/it41/report.html';
body = `## Update

Bare: ${report}

[Markdown report](${report}?view=1#summary)

| Result | Link |
|---|---|
| Hosted | [Table report](${report}) |

> [Quoted report](${report})

- [List report](${base}/other-project/report.html)

[Reference report][report]

[report]: ${report}

<${base}/docs/plan.md>

[Local file](/tmp/report.md)
`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) for (const tool of ['claude', 'codex']) {
    session.tool = tool; session.toolLabel = tool === 'claude' ? 'Claude' : 'Codex';
    fileRequests.length = 0; webRequests.length = 0; mutations.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 1000,
      isMobile: width < 600, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://fonts.**/*', route => route.abort());
    await page.addInitScript(() => {
      window.EventSource = class { addEventListener() {} close() {} };
      window.__nativeMouseUps = 0;
      document.addEventListener('mouseup', () => window.__nativeMouseUps++);
    });
    await page.goto(base + '/aios/session?id=s_web_links_fixture&debugTerminal&noTerminalHistory&noresize&desktop=1');
    await page.locator('.story-body a').first().waitFor();
    const links = page.locator('.story-body a').filter({ hasNotText: 'Local file' });
    assert.equal(await links.count(), 7, 'all Markdown structures expose a hosted link');
    for (let n = 0; n < await links.count(); n++) {
      const link = links.nth(n), expected = await link.getAttribute('href');
      const popupPromise = page.waitForEvent('popup');
      if (width < 1000) await link.tap(); else await link.click();
      const popup = await popupPromise;
      await popup.locator('h1').waitFor();
      assert.equal(popup.url(), expected, 'preserve the hosted URL, including its query/fragment');
      assert.equal(await popup.locator('h1').textContent(), 'Hosted report opened');
      assert.equal(await popup.evaluate(() => window.opener), null, 'new tab has no opener');
      await popup.close();
    }
    assert.deepEqual(fileRequests, [], 'hosted links must never request a disk preview');
    await page.getByRole('link', { name: 'Local file', exact: true }).click();
    await page.locator('[data-file-body]').filter({ hasText: 'Local preview still works.' }).waitFor();
    assert.deepEqual(fileRequests, ['/tmp/report.md'], 'legacy local file preview is unchanged');
    await page.locator('.asset-detail-close').click();

    await page.locator('.workspace-tabs [data-mode="terminal"]').click();
    await page.locator('#term .xterm-screen').waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.__aiosTerminalTestWrite);
    await page.evaluate(url => {
      __aiosTerminalTestWrite('\x1b[2J\x1b[HReport: ' + url + '\r\n');
    }, report);
    await page.waitForFunction(url => document.querySelector('#term .xterm-rows')?.textContent.includes(url), report);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const point = await page.evaluate(() => {
      const rect = document.querySelector('#term .xterm-screen').getBoundingClientRect();
      const { cols, rows } = __aiosTerminalMetrics();
      return { x: rect.left + 12.5 * rect.width / cols, y: rect.top + .5 * rect.height / rows };
    });
    await page.mouse.move(point.x, point.y);
    const mouseUpsBefore = await page.evaluate(() => __nativeMouseUps);
    const reportRequestsBefore = webRequests.filter(path => path === '/morph-data/it41/report.html').length;
    const terminalPopup = page.context().waitForEvent('page', { timeout: 10000 });
    if (width < 1000) await page.touchscreen.tap(point.x, point.y);
    else {
      await page.mouse.down();
      // Deliberately invalidate the native hover-link identity mid-click. A
      // freshly rendered link is not the object cached by xterm on mouse-down.
      await page.evaluate(url => __aiosTerminalTestWrite('\x1b[HReport: ' + url), report);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.mouse.up();
    }
    const popup = await terminalPopup.catch(async error => {
      console.log(JSON.stringify({ terminalPoint: point, metrics: await page.evaluate(() => __aiosTerminalMetrics()),
        hit: await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.outerHTML.slice(0,500), point),
        fileRequests, webRequests, errors }));
      throw error;
    });
    await popup.locator('h1').waitFor();
    assert.equal(popup.url(), report, 'terminal provider opens the whole hosted URL');
    await popup.close();
    assert.equal(webRequests.filter(path => path === '/morph-data/it41/report.html').length,
      reportRequestsBefore + 1, 'fallback plus native provider still opens exactly one tab');
    if (width >= 1000) assert.equal(await page.evaluate(() => __nativeMouseUps), mouseUpsBefore + 1,
      'native mouseup still reaches document-level selection cleanup');
    assert.deepEqual(fileRequests, ['/tmp/report.md'], 'terminal web links do not open the file viewer');
    assert.deepEqual(mutations, [], 'link navigation sends no input or session mutation');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, tool, hostedStoryLinks: 7, hostedTerminalLink: true, fileRequests, webRequests: webRequests.length }));
    await page.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('session_web_links_browser: real Story/terminal click handlers, touch, web routes and local previews passed');
