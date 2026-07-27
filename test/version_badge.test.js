import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const badge = readFileSync(new URL('web/version-badge.js', root));
const styles = readFileSync(new URL('web/styles.css', root));
const outDir = new URL('test-results/version-toast/', root);
mkdirSync(outDir, { recursive: true });
let releaseChannel = 'stable';
let changesDelayMs = 0;

const fixture = `<!doctype html>
<html><head><base href="/"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/styles.css">
<style>
  body { min-height: 100vh; margin: 0; background: #0b0f16; color: #e6edf3; }
  .fixture-stream { padding: 48px; color: #8b949e; }
  .footer-composer { position: fixed; left: 230px; right: 28px; bottom: 18px; padding: 14px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; }
  .composer-bottom { display: flex; justify-content: flex-end; gap: 8px; }
  .fixture-btn { width: 44px; height: 40px; border-radius: 999px; border: 1px solid #3fb950; background: #183d25; color: white; }
</style></head>
<body class="session-page"><div class="fixture-stream">Rendered session composer fixture
  <button id="version-trigger" type="button" data-aios-update data-aios-version>Version</button>
</div>
<div class="message-box footer-composer" aria-label="Message composer">
  <textarea rows="2" style="width:100%" placeholder="Ask anything…"></textarea>
  <div class="composer-bottom"><button id="mic" class="fixture-btn" aria-label="Dictate">●</button><button class="fixture-btn" aria-label="Send">↑</button></div>
</div>
<script>
  localStorage.setItem('version_fixture_loads', String(Number(localStorage.getItem('version_fixture_loads') || 0) + 1));
  document.querySelector('#mic').addEventListener('click', e => e.currentTarget.dataset.clicks = String(Number(e.currentTarget.dataset.clicks || 0) + 1));
</script>
<script type="module" src="/version-badge.js"></script></body></html>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/version-badge.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(badge); return; }
  if (path === '/styles.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(styles); return; }
  if (path === '/api/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '0.3.172', channel: releaseChannel })); return; }
  if (path === '/api/update') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  if (path === '/api/changes') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ changes: ['Faster release comments'], url: 'https://example.test/compare' }));
    }, changesDelayMs);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    if (localStorage.getItem('version_toast_fixture_seeded')) return;
    localStorage.setItem('version_toast_fixture_seeded', '1');
    localStorage.setItem('aios_seen_version', '0.3.171');
    localStorage.removeItem('aios_upgrade_notified_version');
  });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  const toast = page.locator('#aios-version-toast.in');
  await toast.waitFor();
  assert.equal((await toast.locator('.vt-line').innerText()).trim(), 'Updated v0.3.171 → v0.3.172',
    'upgrade copy is only the old-to-new version transition');
  assert.doesNotMatch(await toast.innerText(), /while you/i);
  await page.waitForFunction(() => document.querySelector('[data-changes]')?.textContent?.includes('Faster release comments'));

  const [toastBox, composerBox] = await Promise.all([
    toast.boundingBox(),
    page.locator('.footer-composer').boundingBox(),
  ]);
  assert.ok(toastBox && composerBox, 'toast and composer are rendered');
  assert.ok(toastBox.y + toastBox.height < composerBox.y, 'visible toast sits above and does not overlap the composer');
  await page.screenshot({ path: new URL('composer-toast-visible.png', outDir).pathname, fullPage: true });

  await toast.locator('[data-dismiss]').click();
  await page.locator('#aios-version-toast').waitFor({ state: 'detached' });
  const mic = page.locator('#mic');
  const micBox = await mic.boundingBox();
  assert.ok(micBox, 'mic button is rendered');
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
    x: micBox.x + micBox.width / 2,
    y: micBox.y + micBox.height / 2,
  });
  assert.equal(hit, 'mic', 'dismissed toast leaves no invisible hit target over the mic');
  await mic.click();
  assert.equal(await mic.getAttribute('data-clicks'), '1', 'mic click reaches the composer after dismissal');
  assert.equal(new URL(page.url()).pathname, '/', 'mic click does not redirect to Settings');
  await page.screenshot({ path: new URL('composer-toast-dismissed.png', outDir).pathname, fullPage: true });

  await page.locator('#version-trigger').click();
  const updater = page.locator('#aios-update-control');
  await updater.waitFor();
  assert.equal(await page.locator('#version-trigger').innerText(), 'v0.3.172', 'the tappable version reflects the live server build');
  assert.equal(await updater.locator('[data-update-current]').innerText(), 'v0.3.172', 'the update sheet names the opened build');
  await page.waitForFunction(() => document.querySelector('[data-update-latest]')?.textContent === 'v0.3.172');
  assert.equal(await updater.locator('[data-update-latest]').innerText(), 'v0.3.172', 'the manual no-store check names the latest server build');
  await page.screenshot({ path: new URL('pwa-update-sheet.png', outDir).pathname, fullPage: true });
  await updater.locator('[data-update-close]').last().click();
  await updater.waitFor({ state: 'hidden' });

  const loadsBefore = await page.evaluate(() => Number(localStorage.getItem('version_fixture_loads')));
  await page.locator('#version-trigger').click();
  await updater.locator('[data-update-reload]').click();
  await page.waitForFunction((before) => Number(localStorage.getItem('version_fixture_loads')) > before, loadsBefore);
  assert.equal(new URL(page.url()).searchParams.has('_aios_reload'), false, 'the hard-refresh cache buster is removed from the fresh visible URL');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#aios-version-toast').count(), 0, 'post-upgrade toast is shown only once per version');
  await context.close();

  releaseChannel = 'every';
  const routineContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await routineContext.addInitScript(() => {
    localStorage.setItem('aios_seen_version', '0.3.171');
    localStorage.removeItem('aios_upgrade_notified_version');
  });
  const routinePage = await routineContext.newPage();
  await routinePage.goto(base, { waitUntil: 'networkidle' });
  await routinePage.waitForTimeout(400);
  assert.equal(await routinePage.locator('#aios-version-toast').count(), 0, 'default stable-only preference suppresses routine deploy orientation');
  await routineContext.close();

  releaseChannel = 'stable';
  changesDelayMs = 400;
  const autoContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await autoContext.addInitScript(() => {
    localStorage.setItem('aios_seen_version', '0.3.171');
    localStorage.removeItem('aios_upgrade_notified_version');
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => realSetTimeout(fn, delay === 8000 ? 600 : delay, ...args);
  });
  const autoPage = await autoContext.newPage();
  await autoPage.goto(base, { waitUntil: 'domcontentloaded' });
  await autoPage.locator('#aios-version-toast.in').waitFor();
  await autoPage.waitForTimeout(750);
  assert.equal(await autoPage.locator('#aios-version-toast.in').count(), 1,
    'dismissal interval starts after delayed release comments arrive, not when the toast first mounts');
  assert.match(await autoPage.locator('[data-changes]').innerText(), /Faster release comments/);
  await autoPage.locator('#aios-version-toast').waitFor({ state: 'detached', timeout: 1500 });
  await autoContext.close();

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phoneContext.addInitScript(() => {
    localStorage.setItem('aios_seen_version', '0.3.172');
    localStorage.setItem('aios_upgrade_notified_version', '0.3.172');
  });
  const phonePage = await phoneContext.newPage();
  await phonePage.goto(base, { waitUntil: 'networkidle' });
  await phonePage.locator('#version-trigger').click();
  const phoneSheet = phonePage.locator('#aios-update-control .auc-sheet');
  await phoneSheet.waitFor();
  const phoneBox = await phoneSheet.boundingBox();
  assert.ok(phoneBox && Math.abs(phoneBox.y + phoneBox.height - 844) < 2, 'the iPhone update control is a bottom sheet');
  assert.ok(phoneBox.x >= 0 && phoneBox.x + phoneBox.width <= 390, 'the iPhone update sheet stays inside the viewport');
  await phonePage.screenshot({ path: new URL('pwa-update-sheet-iphone.png', outDir).pathname, fullPage: true });
  await phoneContext.close();

  console.log('version_badge: toast safety + once/version + manual PWA update sheet ok');
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
