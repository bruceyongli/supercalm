import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(root, 'web');
const subscriptions = [];
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const readBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/aios/harness') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><base href="/aios/"><script type="module">
      const ride = await import('./ride-mode.js');
      window.__rideCalls = [];
      ride.setRideVoiceAdapter({
        active: () => false,
        prepare: async ({ requestMic } = {}) => ({ audio: true, mic: requestMic ? true : null }),
        start: async (options) => { window.__rideCalls.push(options); },
        stop: () => {},
      });
      window.__ride = ride;
      window.__ready = true;
    </script>`);
    return;
  }
  if (url.pathname === '/aios/api/vapidPublicKey') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'AA' }));
    return;
  }
  if (url.pathname === '/aios/api/subscribe' && req.method === 'POST') {
    subscriptions.push(JSON.parse(await readBody(req)));
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  let relative = url.pathname.replace(/^\/aios\/?/, '');
  const file = normalize(join(webRoot, relative));
  if (!file.startsWith(webRoot)) { res.writeHead(403); res.end(); return; }
  try {
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/aios/`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const subscription = {
      endpoint: 'https://push.example/sub',
      expirationTime: null,
      toJSON: () => ({ endpoint: 'https://push.example/sub', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    };
    const registration = {
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => subscription,
      },
    };
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'granted', requestPermission: async () => 'granted' },
    });
    // Keep the orchestration test independent of Chromium's user-activation rules for Web Audio;
    // the production enable tap primes audio synchronously, while this fixture observes call routing.
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
        register: async () => registration,
      },
    });
  });
  await page.goto(base + 'harness', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready);

  const result = await page.evaluate(async () => {
    const old = { id: 's_old', project: 'Old project', status: 'waiting', unread: 1, category: 'review', last_key: { id: 10 }, last_activity: 10 };
    window.__ride.observeRideNeeds([old]); // normal-load baseline: no surprise speech
    await new Promise((resolve) => setTimeout(resolve, 20));
    const baselineCalls = window.__rideCalls.length;

    await window.__ride.toggleRideMode(); // explicit enable reads the current queue once
    await new Promise((resolve) => setTimeout(resolve, 30));
    const enabledCalls = [...window.__rideCalls];

    window.__ride.observeRideNeeds([old]); // same report episode: no repeat
    await new Promise((resolve) => setTimeout(resolve, 30));
    const unchangedCalls = window.__rideCalls.length;

    const updated = { ...old, project: 'Changed project', last_key: { id: 11 }, last_activity: 11 };
    window.__ride.observeRideNeeds([updated]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const updatedCalls = [...window.__rideCalls];

    await window.__ride.toggleRideMode();
    window.__ride.observeRideNeeds([{ ...updated, last_key: { id: 12 } }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      baselineCalls,
      enabledCalls,
      unchangedCalls,
      updatedCalls,
      afterOffCalls: window.__rideCalls.length,
      state: window.__ride.rideModeState(),
    };
  });

  assert.equal(result.baselineCalls, 0, 'a normal launch does not read an existing queue');
  assert.deepEqual(result.enabledCalls.map((call) => call.focusSessionId), ['s_old'], 'the enable tap starts one guided pass');
  assert.equal(result.unchangedCalls, 1, 'an unchanged report is never announced twice');
  assert.deepEqual(result.updatedCalls.map((call) => call.focusSessionId), ['s_old', 's_old'],
    'a new report episode for the same project starts a new focused pass');
  assert.equal(result.afterOffCalls, 2, 'turning Ride mode off stops future foreground announcements');
  assert.equal(result.state.enabled, false);
  assert.equal(subscriptions[0]?.aios?.ride, true, 'this device subscribes with Ride delivery enabled');
  assert.equal(subscriptions.at(-1)?.aios?.ride, false, 'turning Ride mode off clears only its Ride preference');

  // A Ride-enabled PWA can be suspended or relaunched between two reports. Persisted report keys
  // distinguish the old queue from the genuinely new work instead of baselining both on every load.
  await page.evaluate(() => {
    localStorage.setItem('aios.ride.enabled', '1');
    localStorage.setItem('aios.ride.announced', JSON.stringify(['s_old:11']));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready);
  const relaunchedCalls = await page.evaluate(async () => {
    window.__ride.observeRideNeeds([{
      id: 's_old',
      project: 'Changed while suspended',
      status: 'waiting',
      unread: 1,
      category: 'review',
      last_key: { id: 12 },
      last_activity: 12,
    }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return window.__rideCalls;
  });
  assert.deepEqual(relaunchedCalls.map((call) => call.focusSessionId), ['s_old'],
    'an enabled PWA announces a report that arrived while the previous page was gone');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('ride_mode_browser.test ok');
