import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Mount the REAL SPA/session, but deliver all terminal input to an isolated fixture handler.
// Prove the control survives native alternate-buffer repaints and never submits a composer draft.
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const session = { id: 's_latest_fixture', tool: 'codex', toolLabel: 'Codex', status: 'waiting',
  title: 'Latest fixture', autonomy: 'full', effort: 'high', model: 'gpt-6.1-sol', revision: 1,
  project: { name: 'Fixture', path: '/fixture' }, composer_history: [] };
const inputs = [], prompts = [];
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (/^\/aios\/api\/session\/s_latest_fixture\/(type|input)$/.test(path)) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    (path.endsWith('/type') ? inputs : prompts).push(JSON.parse(raw));
    return json(res, { ok: true });
  }
  if (path === '/aios/api/session/s_latest_fixture') return json(res, session);
  if (path === '/aios/api/session/s_latest_fixture/story') return json(res, { events: [], meta: {} });
  if (path === '/aios/api/phone/home') return json(res, { sessions: [], counts: {} });
  if (path === '/aios/api/launch-options') return json(res, { projects: [], tools: [] });
  if (path === '/aios/api/version') return json(res, { version: 'test', channel: 'every' });
  if (path.startsWith('/aios/api/')) return json(res, {});
  let name = path.replace(/^\/aios\/?/, '') || 'app.html';
  if (!extname(name)) name = 'app.html';
  const file = normalize(join(webRoot, name));
  if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) {
    for (const tool of ['codex', 'claude']) {
      session.tool = tool; session.toolLabel = tool === 'codex' ? 'Codex' : 'Claude';
      inputs.length = 0; prompts.length = 0;
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 1000,
        isMobile: width < 600, serviceWorkers: 'block' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('https://fonts.**/*', route => route.abort());
      await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
      await page.goto(base + '/aios/session?id=s_latest_fixture&debugTerminal&noTerminalHistory&noresize&desktop=1');
      await page.waitForFunction(() => window.__aiosTerminalTestWrite && document.querySelector('#s-title').textContent.includes('Latest fixture'));
      await page.locator('.workspace-tabs [data-mode="terminal"]').click();
      await page.locator('#reply').fill('Keep this unsent draft.');
      await page.evaluate(() => {
        document.activeElement.blur();
        __aiosTerminalTestWrite('\x1b[?1049h\x1b[?1000h\x1b[?1006hOlder native history');
      });
      const latest = page.locator('#term .jump-latest');
      await latest.waitFor({ state: 'visible' });
      const native = await page.evaluate(() => __aiosTerminalMetrics());
      assert.equal(native.bufferType, 'alternate');
      assert.equal(native.bottomDistance, 0, 'native history cannot be detected from browser coordinates');
      const rect = await latest.boundingBox();
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= 900, 'Latest is onscreen at every viewport');
      if (width < 1000) assert.ok(rect.height >= 44, 'touch control has a usable hit target');
      await page.locator('#term .xterm-screen').hover();
      const wheelAccepted = page.waitForResponse(res => res.url().endsWith('/s_latest_fixture/type'));
      await page.mouse.wheel(0, -80);
      await wheelAccepted;
      await page.waitForFunction(() => __aiosTerminalMetrics().userPausedTail);
      assert.match(inputs.map(i => i.data).join(''), /^\x1b\[<64;\d+;\d+M$/, 'native wheel reaches the isolated raw terminal handler');
      await page.evaluate(() => __aiosTerminalTestWrite('\x1b[HNative history repaint'));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => __aiosTerminalMetrics().userPausedTail), true, 'native repaint cannot reset a paused reader');
      inputs.length = 0;
      const jumpAccepted = page.waitForResponse(res => res.url().endsWith('/s_latest_fixture/type'));
      if (width < 1000) await latest.tap(); else await latest.click();
      await jumpAccepted;
      await page.waitForFunction(() => __aiosTerminalMetrics().followTail && !__aiosTerminalMetrics().userPausedTail);
      assert.deepEqual(inputs, [{ data: '\x1b[1;5F' }], 'one explicit Latest reaches /type as Ctrl+End exactly once');
      assert.equal(await page.locator('#reply').inputValue(), 'Keep this unsent draft.');
      assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'reply', 'Latest must not summon the phone keyboard');
      await page.evaluate(() => __aiosTerminalTestWrite('\x1b[HNewest native output'));
      await page.waitForTimeout(100);
      assert.equal(inputs.length, 1, 'automatic output must never send more native navigation keys');
      assert.equal(await latest.isVisible(), true, 'native Latest remains available when other devices scroll');
      await page.evaluate(() => {
        __aiosTerminalTestWrite('\x1b[HA queued repaint');
        __aiosScrollTop(); // pause before the asynchronous xterm write callback completes
      });
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => __aiosTerminalMetrics().userPausedTail), true, 'queued output cannot undo a later user scroll');
      const resumeAccepted = page.waitForResponse(res => res.url().endsWith('/s_latest_fixture/type'));
      if (width < 1000) await latest.tap(); else await latest.click();
      await resumeAccepted;

      // The same live view switches back to normal xterm history: no remote navigation is needed.
      inputs.length = 0;
      await page.evaluate(() => __aiosTerminalTestWrite('\x1b[?1049l\x1b[?1000l\x1b[?1006l' + Array.from({length: 200}, (_, i) => 'History line ' + i + '\r\n').join('')));
      await page.waitForFunction(() => __aiosTerminalMetrics().bufferType === 'normal');
      await latest.waitFor({ state: 'hidden' });
      await page.locator('#term .xterm-screen').hover();
      await page.mouse.wheel(0, -200);
      await latest.waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => __aiosTerminalMetrics().userPausedTail), true, 'real local viewport scrolling pauses follow and reveals Latest');
      if (width < 1000) await latest.tap(); else await latest.click();
      await latest.waitFor({ state: 'hidden' });
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => __aiosTerminalMetrics().bottomDistance), 0);
      assert.deepEqual(inputs, [], 'local Latest stays entirely browser-side');
      assert.deepEqual(prompts, [], 'terminal navigation cannot submit a coding prompt');
      assert.deepEqual(errors, [], 'actual session mount has no uncaught errors');
      console.log(JSON.stringify({ width, tool, nativeLatest: 'Ctrl+End', localLatest: 'scrollToBottom', draftPreserved: true }));
      await page.close();
    }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('terminal_latest_browser: real SPA native/local Latest, paused follow, touch and draft preservation passed');
