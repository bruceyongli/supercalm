import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Mount the actual SPA + session composer. Hold delivery open while keyboard, input, viewport and
// repeated tap events fire; this exercises the original iPad race without touching any live agent.
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const session = { id: 's_send_fixture', tool: 'codex', toolLabel: 'Codex', status: 'waiting', title: 'Composer fixture',
  autonomy: 'full', effort: 'high', model: 'gpt-6.1-sol', revision: 1, project: { name: 'Fixture', path: '/fixture' }, composer_history: [] };
let pending = [], deliveries = [], events = [], blocked = false, replaceDraft = false, loseResponse = false;
const accepted = new Map();
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/aios/api/session/s_send_fixture/input') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); deliveries.push(body);
    if (accepted.has(body.client_message_id)) return json(res, { ok: true, message: accepted.get(body.client_message_id), duplicate: true });
    if (replaceDraft && !body.replace_pending) return json(res, { reason: 'pending-draft', pendingDraft: 'Native draft', inputBlocked: true }, 409);
    pending.push(() => {
      if (blocked) return json(res, { inputBlocked: true, reason: 'submit-unconfirmed', error: 'Fixture could not confirm delivery.' }, 409);
      events.push({ kind: 'you', ts: Date.now(), body: body.text });
      const message = { id: events.length, ts: events.at(-1).ts };
      accepted.set(body.client_message_id, message);
      json(res, { ok: true, message });
    }); return;
  }
  if (path === '/release') { const queued = pending; pending = []; queued.forEach(release => release()); return json(res, { ok: true }); }
  if (path === '/aios/api/session/s_send_fixture/story') return json(res, { ok: true, events, status: 'working', meta: { source: 'transcript', file: '/fixture.jsonl' } });
  if (path === '/aios/api/session/s_send_fixture') return json(res, session);
  if (path === '/aios/api/phone/home') return json(res, { sessions: [], counts: {} });
  if (path === '/aios/api/launch-options') return json(res, { projects: [], tools: [{ id: 'codex', models: [], efforts: ['high'], autonomies: ['full'] }] });
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
async function releasePending(page) {
  const deadline = Date.now() + 10000;
  while (!pending.length) {
    if (Date.now() > deadline) throw new Error('composer request never reached the held delivery handler');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await page.evaluate(async () => { await fetch('/release'); });
}
try {
  for (const width of [1440, 820, 390]) {
    deliveries = []; events = []; blocked = false; replaceDraft = false; accepted.clear();
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 1000, isMobile: width < 600, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.route('**/api/session/s_send_fixture/input', async route => {
      if (!loseResponse) return route.continue();
      loseResponse = false;
      await route.fetch(); // handler accepts + persists, but the browser never gets the response
      await route.abort('failed');
    });
    await page.route('https://fonts.**/*', route => route.abort());
    await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
    await page.goto(base + '/aios/session?id=s_send_fixture&noresize&desktop=1');
    await page.locator('.story-feed').waitFor();
    await page.locator('#reply').fill('One explicit operator send.');
    await page.evaluate(() => {
      const send = document.querySelector('#send'), reply = document.querySelector('#reply');
      send.click();
      reply.dispatchEvent(new Event('input', { bubbles: true })); // previously re-enabled Send
      window.dispatchEvent(new Event('resize'));
      send.click();
      send.onclick(); // keyboard/palette path ignores button disabled
      reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('[data-story-sendstate="pending"]'));
    assert.equal(await page.locator('#send').isDisabled(), true, 'input/layout updates cannot unlock a pending send');
    assert.equal(deliveries.length, 1, 'tap and keyboard re-entry produce exactly one HTTP request');
    assert.match(deliveries[0].client_message_id, /^[A-Za-z0-9_-]{8,128}$/);
    await page.locator('#reply').fill('Keep my next draft while delivery completes.');
    await releasePending(page);
    await page.waitForFunction(() => !document.querySelector('#send').disabled);
    assert.equal(await page.locator('#reply').inputValue(), 'Keep my next draft while delivery completes.');
    assert.equal(await page.evaluate(() => localStorage.getItem('aios_draft_s_send_fixture')), 'Keep my next draft while delivery completes.');
    await page.evaluate(async () => { const story = await import('/aios/story-view.js'); await story.refreshStory(); });
    assert.equal(await page.locator('[data-kind="you"]').count(), 1, 'native read receipt replaces the optimistic bubble');
    assert.equal(await page.locator('[data-story-sendstate="read"]').count(), 1);
    assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 0);
    blocked = true;
    await page.locator('#reply').fill('Keep a failed send recoverable.');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('[data-story-sendstate="pending"]'));
    await releasePending(page);
    await page.waitForFunction(() => !document.querySelector('#send').disabled);
    assert.equal(await page.locator('#reply').inputValue(), 'Keep a failed send recoverable.');
    assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 0, 'a failed send removes its ghost');
    blocked = false; replaceDraft = true;
    const beforeRetry = deliveries.length;
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#send').disabled);
    // The legacy pending-draft handshake must reuse this send's identity, not create another send.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => deliveries.length >= beforeRetry + 2 ? resolve()
        : Date.now() > deadline ? reject(new Error('pending-draft retry did not reach the handler')) : setTimeout(check, 10); check();
    });
    assert.equal(deliveries.at(-2).client_message_id, deliveries.at(-1).client_message_id);
    assert.equal(deliveries.at(-1).replace_pending, true);
    await releasePending(page);
    await page.waitForFunction(() => document.querySelector('#reply').value === '');
    assert.notEqual(deliveries[0].client_message_id, deliveries.at(-1).client_message_id, 'each genuinely new send gets a fresh identity');
    assert.equal(deliveries.at(-3).client_message_id, deliveries.at(-1).client_message_id, 'a failed send remains retryable with the original identity');
    replaceDraft = false; loseResponse = true;
    await page.locator('#reply').fill('A lost HTTP response cannot duplicate my message.');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('[data-story-sendstate="pending"]'));
    await releasePending(page);
    await page.waitForFunction(() => !document.querySelector('#send').disabled);
    const lostId = deliveries.at(-1).client_message_id;
    await page.reload(); // saved draft + send identity survive navigation after a lost response
    await page.locator('.story-feed').waitFor();
    assert.equal(await page.locator('#reply').inputValue(), 'A lost HTTP response cannot duplicate my message.');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#reply').value === '');
    assert.equal(deliveries.at(-1).client_message_id, lostId, 'network-loss retry after refresh uses the accepted send identity');
    assert.equal(events.filter(event => event.body === 'A lost HTTP response cannot duplicate my message.').length, 1);
    assert.deepEqual(errors, [], 'actual session mount has no uncaught browser errors');
    console.log(JSON.stringify({ width, scenario: 'tap/keyboard/input re-entry, receipt reconciliation, draft preservation and retry', firstSendRequests: 1, firstSendBubbles: 1 }));
    await page.close();
  }
} finally { pending.splice(0).forEach(release => release()); await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('composer_send_browser: desktop/iPad/phone send-once flow passed');
