import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const styles = readFileSync(new URL('../web/styles.css', import.meta.url));
const skin = readFileSync(new URL('../web/redesign-skin.css', import.meta.url));
const fixture = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/redesign-skin.css">
<body class="session-page">
  <div class="session-shell dock-open" id="session-shell">
    <header></header>
    <main class="session-main"></main>
    <aside class="session-usage-panel" id="session-usage-panel">
      <button class="dock-drawer-x" id="dock-drawer-x" type="button">✕</button>
      <div id="side-panels">
        <section class="side-tab-panel map-panel-host" id="s-map">
          <section class="map-card map-space">
            <div class="map-graph map-graph-timeline"><div class="tl-scroll"><div class="tl-rows"><div class="tl-row">Graph row</div></div></div></div>
            <div class="map-top">
              <div class="map-controls"><label>View<select><option>Timeline</option></select></label><button>⋮</button></div>
              <div class="map-info">Selected session</div>
            </div>
          </section>
        </section>
      </div>
    </aside>
  </div>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/styles.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(styles); return; }
  if (path === '/redesign-skin.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(skin); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fixture);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });

async function measure(name, viewport, mobile = false) {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const value = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const panel = document.querySelector('.session-usage-panel');
    const card = document.querySelector('.map-card.map-space');
    const close = document.querySelector('.dock-drawer-x');
    return {
      panel: rect('.session-usage-panel'),
      sidePanels: rect('#side-panels'),
      card: rect('.map-card.map-space'),
      controls: rect('.map-controls'),
      close: rect('.dock-drawer-x'),
      panelBorder: getComputedStyle(panel).borderTopWidth,
      cardBorder: getComputedStyle(card).borderTopWidth,
      cardRadius: getComputedStyle(card).borderTopLeftRadius,
      closeDisplay: getComputedStyle(close).display,
      closePosition: getComputedStyle(close).position,
    };
  });
  if (process.env.AIOS_UI_CAPTURE_DIR) {
    mkdirSync(process.env.AIOS_UI_CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.AIOS_UI_CAPTURE_DIR, `agent-panel-${name}.png`) });
  }
  await page.close();
  return value;
}

try {
  for (const [name, viewport, mobile] of [
    ['phone', { width: 390, height: 844 }, true],
    ['iPad', { width: 820, height: 1180 }, true],
  ]) {
    const m = await measure(name, viewport, mobile);
    assert.equal(m.panelBorder, '1px', `${name}: the compact sheet supplies the one outside boundary`);
    assert.equal(m.cardBorder, '0px', `${name}: Graph does not draw a second full-size frame`);
    assert.equal(m.cardRadius, '0px', `${name}: Graph does not look like a nested folder`);
    assert.equal(m.closePosition, 'absolute', `${name}: close overlays instead of floating a dead column`);
    assert.ok(m.close.width <= 34 && m.close.height <= 34, `${name}: close stays compact`);
    assert.ok(m.sidePanels.width >= m.panel.width - 28,
      `${name}: close does not narrow the active panel (${m.sidePanels.width}/${m.panel.width})`);
    assert.ok(m.card.width >= m.panel.width - 28,
      `${name}: graph uses the sheet width (${m.card.width}/${m.panel.width})`);
    assert.ok(m.close.left >= m.controls.left && m.close.right <= m.controls.right + 5,
      `${name}: close sits in the existing controls surface instead of its own strip`);
  }

  const desktop = await measure('desktop', { width: 1440, height: 900 });
  assert.equal(desktop.closeDisplay, 'none', 'desktop uses the active header tab/Escape and does not waste space on close chrome');
  assert.equal(desktop.panelBorder, '0px', 'desktop panel shares the resizer edge without an outer card frame');
  assert.equal(desktop.cardBorder, '0px', 'desktop Graph remains full-bleed rather than nested in another card');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('agent_panel_frame_browser.test ok');
