import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(root, 'web');
const outDir = join(root, 'test-results', 'on-the-go');
mkdirSync(outDir, { recursive: true });
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
    res.end(`<!doctype html><meta charset="utf-8"><base href="/aios/"><link rel="stylesheet" href="styles.css"><script type="module">
      const onTheGo = await import('./on-the-go.js');
      window.__onTheGoCalls = [];
      onTheGo.setOnTheGoVoiceAdapter({
        active: () => false,
        prepare: async ({ requestMic } = {}) => ({ audio: true, mic: requestMic ? true : null }),
        start: async (options) => { window.__onTheGoCalls.push(options); },
        stop: () => {},
      });
      window.__onTheGo = onTheGo;
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
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(body);
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
    window.__onTheGo.setVoiceUpdateStyle('walkie');
    const old = { id: 's_old', project: 'Old project', status: 'waiting', unread: 1, category: 'review', last_key: { id: 10 }, last_activity: 10 };
    window.__onTheGo.observeOnTheGoNeeds([old]); // normal-load baseline: no surprise speech
    await new Promise((resolve) => setTimeout(resolve, 20));
    const baselineCalls = window.__onTheGoCalls.length;

    await window.__onTheGo.toggleOnTheGo(); // explicit enable reads the current queue once
    await new Promise((resolve) => setTimeout(resolve, 30));
    const enabledCalls = [...window.__onTheGoCalls];

    window.__onTheGo.observeOnTheGoNeeds([old]); // same report episode: no repeat
    await new Promise((resolve) => setTimeout(resolve, 30));
    const unchangedCalls = window.__onTheGoCalls.length;

    const updated = { ...old, project: 'Changed project', last_key: { id: 11 }, last_activity: 11 };
    window.__onTheGo.observeOnTheGoNeeds([updated]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const updatedCalls = [...window.__onTheGoCalls];

    await window.__onTheGo.toggleOnTheGo();
    window.__onTheGo.observeOnTheGoNeeds([{ ...updated, last_key: { id: 12 } }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      baselineCalls,
      enabledCalls,
      unchangedCalls,
      updatedCalls,
      afterOffCalls: window.__onTheGoCalls.length,
      state: window.__onTheGo.onTheGoState(),
    };
  });

  assert.equal(result.baselineCalls, 0, 'a normal launch does not read an existing queue');
  assert.deepEqual(result.enabledCalls.map((call) => call.focusSessionId), ['s_old'], 'the enable tap starts one guided pass');
  assert.equal(result.unchangedCalls, 1, 'an unchanged report is never announced twice');
  assert.deepEqual(result.updatedCalls.map((call) => call.focusSessionId), ['s_old', 's_old'],
    'a new report episode for the same project starts a new focused pass');
  assert.equal(result.afterOffCalls, 2, 'turning the on-the-go assistant off stops future foreground announcements');
  assert.equal(result.state.enabled, false);
  assert.equal(subscriptions[0]?.aios?.onTheGo, true, 'this device subscribes with on-the-go delivery enabled');
  assert.equal(subscriptions[0]?.aios?.voiceStyle, 'walkie', 'the push subscription retains the chosen walkie-talkie style');
  assert.equal(subscriptions.at(-1)?.aios?.onTheGo, false, 'turning it off clears only its on-the-go preference');

  // Call style asks before any microphone or report audio begins. Accept starts the same focused
  // assistant; Not now silences that snapshot without removing it from Needs You.
  const callOffer = await page.evaluate(async () => {
    window.__onTheGo.setVoiceUpdateStyle('call');
    await window.__onTheGo.toggleOnTheGo();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { beforeAccept: window.__onTheGoCalls.length, offered: window.__onTheGo.onTheGoState() };
  });
  await page.locator('[data-voice-update-call]').waitFor();
  await page.screenshot({ path: join(outDir, 'incoming-call-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const callBox = await page.locator('.voice-update-call-card').boundingBox();
  assert.ok(callBox && callBox.x >= 0 && callBox.x + callBox.width <= 390 && callBox.y >= 0 && callBox.y + callBox.height <= 844,
    'the incoming call and both choices fit an iPhone PWA viewport');
  await page.screenshot({ path: join(outDir, 'incoming-call-phone.png') });
  await page.locator('[data-voice-call-accept]').click();
  await page.setViewportSize({ width: 1280, height: 720 });
  const callResult = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterAccept = window.__onTheGoCalls.length;
    const latest = { id: 's_old', project: 'Another update', status: 'waiting', unread: 1, category: 'review', last_key: { id: 13 }, last_activity: 13 };
    window.__onTheGo.observeOnTheGoNeeds([latest]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const offeredAgain = window.__onTheGo.onTheGoState();
    document.querySelector('[data-voice-call-decline]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      afterAccept,
      offeredAgain,
      afterDecline: window.__onTheGo.onTheGoState(),
      callsAfterDecline: window.__onTheGoCalls.length,
    };
  });
  assert.equal(callOffer.offered.style, 'call');
  assert.equal(callOffer.offered.incoming.id, 's_old');
  assert.equal(callResult.afterAccept, callOffer.beforeAccept + 1,
    'Accept starts the same focused Voice Assistant only after consent');
  assert.equal(callResult.offeredAgain.incoming.id, 's_old', 'a genuinely new report offers another call');
  assert.equal(callResult.afterDecline.incoming, null, 'Not now closes the incoming call');
  assert.equal(callResult.callsAfterDecline, callResult.afterAccept,
    'Not now never starts speech or sends feedback');
  assert.equal(subscriptions.at(-1)?.aios?.voiceStyle, 'call', 'the device updates push delivery to call style');

  // An enabled PWA can be suspended or relaunched between two reports. Persisted report keys
  // distinguish the old queue from the genuinely new work instead of baselining both on every load.
  await page.evaluate(() => {
    localStorage.setItem('aios.on-the-go.enabled', '1');
    localStorage.setItem('aios.voice-updates.style', 'walkie');
    localStorage.setItem('aios.on-the-go.announced', JSON.stringify(['s_old:11']));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready);
  const relaunchedCalls = await page.evaluate(async () => {
    window.__onTheGo.observeOnTheGoNeeds([{
      id: 's_old',
      project: 'Changed while suspended',
      status: 'waiting',
      unread: 1,
      category: 'review',
      last_key: { id: 12 },
      last_activity: 12,
    }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return window.__onTheGoCalls;
  });
  assert.deepEqual(relaunchedCalls.map((call) => call.focusSessionId), ['s_old'],
    'an enabled PWA announces a report that arrived while the previous page was gone');

  // The automatic assistant is visually a live update briefing, not the manual Voice orb reused
  // under another button. A missing fixture endpoint keeps the overlay in its short error grace
  // window long enough to inspect the actual production DOM.
  await page.evaluate(async () => {
    const voice = await import('./voicemode.js');
    void voice.startVoiceMode({ focusSessionId: 's_old', source: 'on-the-go-update' });
  });
  await page.locator('.vm-ongo .ongo-report').waitFor();
  assert.equal(await page.locator('.vm-ongo .ongo-kicker').textContent(), 'VOICE ASSISTANT');
  assert.equal(await page.locator('.vm-ongo .ongo-label').first().textContent(), 'NOW READING');
  assert.match(await page.locator('.vm-ongo .ongo-context').textContent(), /follow-up|feedback/i,
    'the proactive report invites the same natural conversation as manual Voice');
  assert.equal(await page.locator('.vm-ongo .ongo-segment.current').count(), 1,
    'the exact sentence currently being spoken has a visible marker');
  assert.equal(await page.locator('.vm-ongo .ongo-heard').count(), 1,
    'the operator response region is always present, even before speech is recognized');
  assert.equal(await page.locator('.vm-ongo .vm-interrupt').textContent(), 'Speak now',
    'the live briefing has an explicit touch interruption fallback');
  assert.match(await page.locator('.vm-ongo .vm-heard').textContent(), /words|Listening/i);
  assert.equal(await page.locator('.vm-ongo .ongo-delivery').count(), 1,
    'the briefing includes a dedicated delivery-receipt region');
  assert.equal(await page.locator('.vm-ongo .vm-orb').count(), 0,
    'the on-the-go briefing does not reuse the manual Voice orb presentation');
  await page.evaluate(() => {
    document.querySelector('.vm-ongo').dataset.state = 'speaking';
    document.querySelector('.vm-ongo .vm-interrupt').hidden = false;
    document.querySelector('.vm-state').textContent = 'Speaking…';
    document.querySelector('.ongo-title').textContent = 'aios/supercalm';
    document.querySelector('.ongo-context').textContent = 'Voice Assistant · report quality · Codex';
    document.querySelector('.vm-prog-label').textContent = '2 of 3';
    document.querySelector('.vm-bar > i').style.width = '66%';
    document.querySelector('.vm-said').innerHTML = [
      '<span class="ongo-segment done">You asked: simplify On-the-go and Needs You.</span>',
      '<span class="ongo-segment current">Update: the brief is shorter and the current sentence stays highlighted.</span>',
      '<span class="ongo-segment">I need your input: review the new layout.</span>',
    ].join('');
    document.querySelector('.ongoing-heard-label').textContent = 'YOUR LAST RESPONSE';
    const heard = document.querySelector('.vm-heard');
    heard.classList.remove('empty');
    heard.textContent = '“Keep the report short and make my response easy to find.”';
  });
  const desktopBox = await page.locator('.ongo-shell').boundingBox();
  assert.ok(desktopBox && desktopBox.x >= 0 && desktopBox.x + desktopBox.width <= 1280,
    'the briefing is contained on desktop');
  await page.screenshot({ path: join(outDir, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileFit = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    viewport: innerWidth,
    stop: document.querySelector('.vm-ongo .vm-stop')?.getBoundingClientRect().toJSON(),
    interrupt: document.querySelector('.vm-ongo .vm-interrupt')?.getBoundingClientRect().toJSON(),
    heard: document.querySelector('.vm-ongo .ongo-heard')?.getBoundingClientRect().toJSON(),
  }));
  assert.ok(mobileFit.pageWidth <= mobileFit.viewport, 'the briefing does not overflow an iPhone viewport');
  assert.ok(mobileFit.stop && mobileFit.stop.top >= 0 && mobileFit.stop.bottom <= 844,
    'the end-assistant control remains reachable on iPhone');
  assert.ok(mobileFit.interrupt && mobileFit.interrupt.top >= 0 && mobileFit.interrupt.bottom <= 844,
    'the speak-now interruption control remains reachable on iPhone');
  assert.ok(mobileFit.heard && mobileFit.heard.top >= 0 && mobileFit.heard.bottom <= 844,
    'the operator response remains visible without scrolling on iPhone');
  await page.screenshot({ path: join(outDir, 'phone.png') });
  await page.evaluate(async () => (await import('./voicemode.js')).stopVoiceMode());
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('on_the_go_browser.test ok');
