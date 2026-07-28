import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const assets = new Map([
  ['/session-viewport.js', ['text/javascript', readFileSync(new URL('../web/session-viewport.js', import.meta.url))]],
  ['/styles.css', ['text/css', readFileSync(new URL('../web/styles.css', import.meta.url))]],
  ['/desktop.css', ['text/css', readFileSync(new URL('../web/desktop.css', import.meta.url))]],
]);
const fixture = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="/desktop.css"><link rel="stylesheet" href="/styles.css">
<body class="session-page">
  <main id="view" class="dk-view">
    <div class="session-shell">
      <main class="session-main">
        <section class="story-panel"></section>
        <div class="message-box footer-composer">
          <textarea id="reply" placeholder="Ask anything..."></textarea>
          <div class="composer-bottom">
            <div class="composer-options"><div class="composer-settings-popover"><div class="settings composer-settings"></div></div></div>
            <div class="composer-actions">
              <button class="btn ghost icon-btn attach-btn attach-mobile">+</button>
              <button class="composer-settings-toggle">full · xhigh · GPT-5.6</button>
              <span class="composer-action-spacer"></span><span class="mic-status"></span>
              <button class="btn mic" id="mic">●</button><button class="btn ghost send-btn" id="send">↑</button>
            </div>
          </div>
        </div>
      </main>
      <nav class="agent-dock-rail"></nav>
    </div>
  </main>
  <script type="module">
    import { installSessionViewportSync } from '/session-viewport.js';
    class FakeViewport extends EventTarget {
      height = 874; offsetTop = 0; offsetLeft = 0;
    }
    const vv = new FakeViewport();
    const controller = new AbortController();
    const shell = document.querySelector('.session-shell');
    const reply = document.querySelector('#reply');
    installSessionViewportSync({
      shell, input: reply, signal: controller.signal, visualViewport: vv, coarse: true,
    });
    window.__viewportTest = {
      open() { reply.focus(); vv.height = 480; vv.offsetTop = 394; vv.dispatchEvent(new Event('resize')); },
      closeWithStaleViewport() { reply.blur(); },
      shell, reply, vv,
    };
  </script>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const asset = assets.get(path);
  if (asset) {
    res.writeHead(200, { 'content-type': asset[0] });
    res.end(asset[1]);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fixture);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => !!window.__viewportTest);

  const closed = await page.evaluate(() => {
    const composer = document.querySelector('.footer-composer').getBoundingClientRect();
    const actions = document.querySelector('.composer-actions');
    const attach = document.querySelector('.attach-mobile').getBoundingClientRect();
    const settings = document.querySelector('.composer-settings-toggle').getBoundingClientRect();
    const mic = document.querySelector('#mic').getBoundingClientRect();
    const send = document.querySelector('#send').getBoundingClientRect();
    return {
      fontSize: getComputedStyle(document.querySelector('#reply')).fontSize,
      actionOverflow: actions.scrollWidth - actions.clientWidth,
      controlsInside: mic.right <= composer.right && send.right <= composer.right,
      oneRow: Math.max(attach.top, settings.top, mic.top, send.top) - Math.min(attach.top, settings.top, mic.top, send.top) <= 3,
      settingsWidth: settings.width,
    };
  });
  assert.equal(closed.fontSize, '16px');
  assert.ok(closed.actionOverflow <= 0, 'the phone action row does not overflow');
  assert.equal(closed.controlsInside, true, 'mic and send remain inside the composer');
  assert.equal(closed.oneRow, true, 'attach, run settings, mic, and send stay on one row');
  assert.ok(closed.settingsWidth > 100, 'the run-settings summary gets the flexible middle track');

  await page.evaluate(() => window.__viewportTest.open());
  await page.waitForTimeout(30);
  const open = await page.evaluate(() => {
    const shell = window.__viewportTest.shell;
    const rect = shell.getBoundingClientRect();
    return {
      classOpen: shell.classList.contains('keyboard-open'),
      inlineHeight: shell.style.height,
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      dockDisplay: getComputedStyle(document.querySelector('.agent-dock-rail')).display,
      composerPaddingBottom: getComputedStyle(document.querySelector('.footer-composer')).paddingBottom,
    };
  });
  assert.deepEqual(open, {
    classOpen: true, inlineHeight: '480px', top: 394, bottom: 874,
    dockDisplay: 'none', composerPaddingBottom: '0px',
  },
    'the keyboard-open shell occupies the panned visual viewport instead of disappearing above it');

  await page.evaluate(() => window.__viewportTest.closeWithStaleViewport());
  await page.waitForTimeout(30);
  const after = await page.evaluate(() => {
    const shell = window.__viewportTest.shell;
    const rect = shell.getBoundingClientRect();
    return {
      classOpen: shell.classList.contains('keyboard-open'),
      inlineHeight: shell.style.height,
      transform: shell.style.transform,
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      dockDisplay: getComputedStyle(document.querySelector('.agent-dock-rail')).display,
    };
  });
  assert.deepEqual(after, {
    classOpen: false, inlineHeight: '', transform: '', top: 0, height: 874, dockDisplay: 'flex',
  }, 'blur clears stale keyboard geometry and restores the full-height page');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('session_viewport_browser.test ok');
