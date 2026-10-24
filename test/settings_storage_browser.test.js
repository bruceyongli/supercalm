import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { chromium, webkit } from 'playwright';

const names = ['views/settings.js', 'settings-storage.js', 'common.js', 'session-indicator.js', 'provider-issue.js',
  'markdown-inline.js', 'file-reference.js', 'onboarding.css', 'desktop.css', 'styles.css', 'redesign-skin.css'];
const assets = new Map(names.map(name => [`/aios/${name}`, readFileSync(new URL(`../web/${name}`, import.meta.url))]));
const local = { available_bytes: 138 * 1024 ** 3, total_bytes: 460 * 1024 ** 3 };
const base = () => ({ defaultDevice: 'local', localIsFactoryDefault: true, devices: [], migration: null, local, setupSupported: true });
const remote = (id = 'spark') => ({ id, label: 'Spark <script>safe</script>', url: 'smb://192.168.31.73/a-very-long-share-name-for-a-storage-device',
  account: 'spark', credentials: 'macOS Keychain', mount: '/Users/operator/.local/share/aios/mounts/storage-device-volume',
  image: '/Users/operator/.local/share/aios/mounts/storage-share/aios-storage-fixture.sparsebundle', sizeGiB: 1536,
  current: true, available: true, status: { volume: { available_bytes: 1.2 * 1024 ** 4, total_bytes: 1.5 * 1024 ** 4 }, backing: { available_bytes: 2.5 * 1024 ** 4 } } });
let state = base(), reads = 0, posts = [], getDelay = 0, connectDelay = 0, failReads = false, failConnect = false, failSelect = false;
let writesInFlight = 0, maxWrites = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': extname(path) === '.css' ? 'text/css' : 'text/javascript' }); res.end(assets.get(path)); return; }
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (path === '/aios/api/settings/storage' && req.method === 'GET') {
    reads++; const captured = structuredClone(state); await delay(getDelay);
    return failReads ? json({ error: 'Device is temporarily unavailable.' }, 503) : json(captured);
  }
  if (path.startsWith('/aios/api/settings/storage/') && req.method === 'POST') {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {}; posts.push({ path, body });
    writesInFlight++; maxWrites = Math.max(maxWrites, writesInFlight);
    try {
      if (path.endsWith('/devices')) {
        const device = { ...remote('new-device'), label: body.label, url: body.url, account: body.account,
          sizeGiB: body.sizeGiB, available: false, status: null, current: false };
        state.devices.push(device); return json({ ...state, id: device.id });
      }
      if (path.endsWith('/connect')) {
        await delay(connectDelay);
        if (failConnect) return json({ error: 'Check the device and credentials.' }, 502);
        const id = path.split('/').at(-2), device = state.devices.find(d => d.id === id);
        device.available = true; device.status = remote().status; return json(state);
      }
      if (path.endsWith('/credentials')) return json(state);
      if (path.endsWith('/default')) {
        if (failSelect) return json({ error: 'A storage migration started. Retry after it finishes.' }, 409);
        state.defaultDevice = body.device; return json(state);
      }
    } finally { writesInFlight--; }
  }
  if (path === '/aios/api/voice/state') return json({ providers: [], config: { tts: { primary: 'spark', fallbacks: [] }, stt: { primary: 'spark', fallbacks: [] } }, resolved: { tts: [], stt: [] } });
  if (path.startsWith('/aios/api/')) return json({});
  if (path !== '/aios/') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><base href="/aios/">
    <link rel="stylesheet" href="desktop.css"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="redesign-skin.css">
    <style>body{overflow:auto;display:block}main#view{position:static;display:block;overflow:visible;width:100%}</style><main id="view"></main>
    <script type="module">window.errors=[];addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));window.settings=await import('./views/settings.js');window.settings.init(document.querySelector('#view'));</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.AIOS_STORAGE_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) {
    state = base(); failReads = false; failConnect = false; failSelect = false; getDelay = 0; connectDelay = 0; posts = [];
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/aios/`);
    await page.waitForSelector('[data-storage-device="local"]');
    assert.equal(await page.locator('[data-st-nav] a[href="#st-storage"]').count(), 1, 'Storage is a real Settings section');
    assert.match(await page.locator('[data-storage-device="local"]').innerText(), /Default for new files[\s\S]*Factory default[\s\S]*138\.0 GiB available/);
    assert.equal(await page.locator('[data-action="select"][data-device="local"]').isDisabled(), true);
    const refresh = async () => {
      const before = reads; await page.locator('[data-storage-refresh]').click();
      await page.waitForFunction(() => !document.querySelector('[data-storage-refresh]').disabled);
      assert.ok(reads > before);
    };
    state = { ...state, defaultDevice: 'spark', devices: [remote()], migration: { running: true, completed: 31, total: 43, roots: [
      { source: '/Users/operator/aios/data/session-storage/very-long-session-name/to/check/wrapping', state: 'copying', active: false },
      { source: '/Users/operator/omni', state: 'complete', active: true },
      { source: '/Users/operator/morph', state: 'interrupted', active: false, error: 'A read-only process has this folder open.' },
    ] } };
    await refresh();
    assert.match(await page.locator('[data-storage-device="spark"]').innerText(), /Default for new files[\s\S]*Connected[\s\S]*1\.2 TiB available[\s\S]*2\.5 TiB/);
    assert.equal(await page.locator('[data-storage-devices] script').count(), 0, 'device names remain inert text');
    assert.match(await page.locator('[data-storage-migration]').innerText(), /31 \/ 43 roots ready/);
    assert.equal(await page.locator('[data-action="select"][data-device="local"]').isDisabled(), true, 'active migration locks destination changes');
    await page.locator('[data-detail="migration-roots"] summary').click();
    assert.match(await page.locator('[data-storage-migration]').innerText(), /Copying[\s\S]*On remote storage[\s\S]*Interrupted[\s\S]*read-only process/);
    await page.locator('[data-detail="spark"] summary').click();
    await page.locator('[data-storage-add] > summary').click();
    await page.locator('[data-storage-form] [name="label"]').fill('Studio NAS');
    await page.locator('[data-storage-form] [name="url"]').fill('smb://192.168.1.20/storage');
    await page.locator('[data-storage-form] [name="account"]').fill('operator');
    const secret = 'fixture-private-value'; // secret-scan: allow -- synthetic browser redaction fixture, not a credential
    await page.locator('[data-storage-form] [name="password"]').fill(secret);
    await page.locator('[data-storage-form] [name="sizeGiB"]').fill('2048');
    state.migration.completed = 32;
    await refresh();
    assert.equal(await page.locator('[data-storage-form] [name="label"]').inputValue(), 'Studio NAS');
    assert.equal(await page.locator('[data-storage-form] [name="password"]').inputValue(), secret, 'status polling preserves an unsubmitted draft');
    assert.equal(await page.locator('[data-detail="migration-roots"]').getAttribute('open'), '');
    assert.equal(await page.locator('[data-detail="spark"]').getAttribute('open'), '');
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('*')].map(n => ({ tag: n.tagName, id: n.id, cls: n.className, right: n.getBoundingClientRect().right, width: n.getBoundingClientRect().width }))
        .filter(n => n.right > innerWidth + 1 && n.width > 0).slice(0, 10),
      inner: [...document.querySelectorAll('*')].filter(n => n.clientWidth && n.scrollWidth > n.clientWidth + 1)
        .map(n => ({ tag: n.tagName, id: n.id, cls: n.className, client: n.clientWidth, scroll: n.scrollWidth })).slice(0, 20) }));
    assert.ok(overflow.scroll <= overflow.viewport + 1, `no horizontal overflow at ${width}px, including expanded paths/form: ${JSON.stringify(overflow)}`);
    assert.equal(await page.evaluate(s => JSON.stringify(localStorage).includes(s) || JSON.stringify(sessionStorage).includes(s), secret), false);

    state.migration = null; await refresh();
    assert.equal(await page.locator('[data-action="select"][data-device="local"]').isDisabled(), false);
    await page.locator('[data-action="select"][data-device="local"]').click();
    await page.waitForFunction(() => document.querySelector('[data-storage-message]').textContent.includes('Default saved'));
    assert.equal(posts.at(-1).body.device, 'local');
    assert.match(await page.locator('[data-storage-device="spark"]').innerText(), /Existing file location/);
    assert.equal(await page.locator('[data-storage-form] [name="label"]').inputValue(), 'Studio NAS');

    connectDelay = 200;
    await page.locator('[data-storage-save]').click();
    assert.equal(await page.locator('[data-storage-form] [name="password"]').inputValue(), '', 'password clears before slow connect completes');
    await page.waitForFunction(() => document.querySelector('[data-storage-message]').textContent.includes('Connecting…'));
    const readsBeforeConnect = reads;
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
    assert.equal(reads, readsBeforeConnect, 'refresh cannot race a mutating operation');
    await page.waitForFunction(() => document.querySelector('[data-storage-message]').textContent.includes('Device connected.'));
    assert.deepEqual(posts.slice(-2).map(p => p.path), ['/aios/api/settings/storage/devices', '/aios/api/settings/storage/devices/new-device/connect']);
    assert.deepEqual(posts.at(-2).body, { label: 'Studio NAS', url: 'smb://192.168.1.20/storage', account: 'operator', password: secret, sizeGiB: 2048 });
    assert.equal(state.defaultDevice, 'local', 'saving and connecting never silently selects a device');
    assert.equal(await page.locator('[data-storage-add]').getAttribute('open'), null);
    assert.equal(await page.evaluate(s => document.body.innerHTML.includes(s) || JSON.stringify(localStorage).includes(s) || JSON.stringify(sessionStorage).includes(s), secret), false);

    await page.locator('[data-detail="new-device"] summary').click();
    await page.locator('[data-action="credentials"][data-device="new-device"]').click();
    const newSecret = 'replacement-fixture-private-value';
    await page.locator('[data-storage-credential] [name="password"]').fill(newSecret);
    state.local = { ...local, available_bytes: 137 * 1024 ** 3 }; await refresh();
    assert.equal(await page.locator('[data-storage-credential] [name="password"]').inputValue(), newSecret, 'polling preserves a password-update draft, too');
    await page.locator('[data-storage-credential-save]').click();
    assert.equal(await page.locator('[data-storage-credential] [name="password"]').inputValue(), '');
    await page.waitForFunction(() => document.querySelector('[data-storage-message]').textContent.includes('Password updated'));
    assert.deepEqual(posts.slice(-2).map(p => p.path), ['/aios/api/settings/storage/devices/new-device/credentials', '/aios/api/settings/storage/devices/new-device/connect']);
    assert.deepEqual(posts.at(-2).body, { password: newSecret });
    assert.equal(state.defaultDevice, 'local');
    assert.equal(await page.locator('[data-storage-credential]').isVisible(), false);
    assert.equal(await page.evaluate(s => document.body.innerHTML.includes(s) || JSON.stringify(localStorage).includes(s) || JSON.stringify(sessionStorage).includes(s), newSecret), false);
    await page.locator('[data-action="credentials"][data-device="new-device"]').click();
    await page.locator('[data-storage-credential] [name="password"]').fill(newSecret);
    const beforeCancel = posts.length; await page.locator('[data-storage-credential-cancel]').click();
    assert.equal(posts.length, beforeCancel); assert.equal(await page.locator('[data-storage-credential] [name="password"]').inputValue(), '');

    await page.locator('[data-action="select"][data-device="new-device"]').click();
    await page.waitForFunction(() => document.querySelector('[data-storage-device="new-device"]').classList.contains('is-default'));
    assert.equal(state.defaultDevice, 'new-device');
    failSelect = true;
    await page.locator('[data-action="select"][data-device="local"]').click();
    await page.waitForFunction(() => document.querySelector('[data-storage-error]').textContent.includes('migration started'));
    assert.equal(state.defaultDevice, 'new-device', 'server-side migration races cannot change selection');
    failSelect = false; failConnect = true;
    await page.locator('[data-action="connect"][data-device="new-device"]').click();
    await page.waitForFunction(() => document.querySelector('[data-storage-error]').textContent.includes('Check the device and credentials.'));
    assert.equal(await page.locator('[data-action="connect"][data-device="new-device"]').isDisabled(), false, 'a failed connection remains retryable');
    failConnect = false; failReads = true; await refresh();
    assert.match(await page.locator('[data-storage-error]').innerText(), /Showing the last known status/);
    assert.equal(await page.locator('[data-storage-device="new-device"]').count(), 1);
    failReads = false;

    // An older in-flight GET is aborted/fenced when a write starts, so it cannot restore an old default.
    getDelay = 220;
    await page.locator('[data-storage-refresh]').click();
    await page.locator('[data-action="select"][data-device="local"]').click();
    await page.waitForFunction(() => document.querySelector('[data-storage-device="local"]').classList.contains('is-default'));
    await page.waitForTimeout(240);
    assert.equal(await page.locator('[data-storage-device="local"]').evaluate(node => node.classList.contains('is-default')), true);
    getDelay = 0;
    await page.locator('[data-st-search]').fill('storage');
    assert.equal(await page.locator('#st-storage').isVisible(), true);
    await page.locator('[data-st-search]').fill('');

    // Leaving Settings aborts pending reads and detaches callbacks; it cannot rewrite the next view.
    getDelay = 150;
    await page.locator('[data-storage-refresh]').click();
    await page.evaluate(() => { window.settings.teardown(); document.querySelector('#view').innerHTML = '<div id="next">Next view</div>'; window.dispatchEvent(new Event('focus')); });
    const afterTeardown = reads;
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#next').innerText(), 'Next view');
    assert.equal(reads, afterTeardown);
    assert.deepEqual(await page.evaluate(() => window.errors), []);
    assert.equal(maxWrites, 1, 'configuration writes are serialized');
    console.log(JSON.stringify({ width, localDefault: 'pass', importedRemote: 'pass', draftAndSecret: 'pass', migrationLock: 'pass', connectionAndSelection: 'pass', teardown: 'pass' }));
    await page.close();
  }

  // A short-interval component fixture proves timers stop in background and resume without overlap.
  state = base(); getDelay = 0; failReads = true;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/aios/`);
  await page.waitForFunction(() => document.querySelector('[data-storage-error]')?.textContent.includes('Try Refresh'));
  assert.equal(await page.locator('[data-storage-devices]').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('[data-storage-save]').isDisabled(), true);
  failReads = false; await page.locator('[data-storage-refresh]').click();
  await page.waitForSelector('[data-storage-device="local"]');
  await page.evaluate(async () => {
    window.settings.teardown();
    const { mountStorageSettings } = await import('./settings-storage.js');
    window.stopStorage = mountStorageSettings(document.querySelector('#st-storagecard'), { pollMs: 60 });
  });
  assert.equal(await page.evaluate(() => document.hidden), false);
  const beforePoll = reads;
  for (let i = 0; i < 20 && reads <= beforePoll; i++) await page.waitForTimeout(50);
  assert.ok(reads > beforePoll, JSON.stringify(await page.evaluate(() => ({ errors: window.errors,
    status: document.querySelector('[data-storage-error]')?.textContent, buttonDisabled: document.querySelector('[data-storage-refresh]')?.disabled }))));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const beforeHidden = reads; await page.waitForTimeout(160); assert.equal(reads, beforeHidden);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  for (let i = 0; i < 20 && reads <= beforeHidden; i++) await page.waitForTimeout(50);
  assert.ok(reads > beforeHidden);
  state.setupSupported = false;
  await page.waitForFunction(() => document.querySelector('[data-storage-add]').hidden);
  assert.equal(await page.locator('[data-storage-add]').isVisible(), false);
  assert.match(await page.locator('[data-storage-unsupported]').innerText(), /requires a macOS host/);
  await page.evaluate(() => window.stopStorage()); const afterStop = reads;
  await page.waitForTimeout(160); assert.equal(reads, afterStop);
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  await page.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('settings_storage_browser.test passed');
