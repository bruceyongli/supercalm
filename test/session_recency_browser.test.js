import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const now = Date.now(), day = 86_400_000;
const waiting = (id, at) => ({ id, title: `Task ${id}`, project: 'Fixture', tool: 'codex', status: 'waiting', category: 'review',
  summary: 'The change is ready for review.', question: 'The change is ready for review.', unread: 1,
  last_activity: at, last_key: { id: id === 's_old' ? 10 : 11, ts: at, text: 'Ready for review.' } });
const sessions = [waiting('s_recent', now), waiting('s_old', now - 2 * day), waiting('s_old_reply', now - 3 * day),
  { id: 's_old_work', title: 'Long running task', project: 'Fixture', tool: 'codex', status: 'working', unread: 0, last_activity: now - 2 * day },
  { ...waiting('s_dismissed', now - 4 * day), dismissed: true, dismissed_at: now - day },
  { ...waiting('s_fresh_report', now - 5 * day), last_key: { id: 12, ts: now, text: 'Fresh update' } }];
const storyRequests = [], inputBodies = [];
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function json(res, data) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/aios/api/phone/home') return json(res, { sessions, counts: { waiting: 5, working: 1, live: 6 } });
  if (path === '/aios/api/version') return json(res, { version: 'test', channel: 'every' });
  if (path === '/aios/api/auth/status') return json(res, { mode: 'cli' });
  const story = path.match(/^\/aios\/api\/session\/([^/]+)\/story$/);
  if (story) { storyRequests.push(story[1]); return json(res, { events: [], status: 'waiting' }); }
  const input = path.match(/^\/aios\/api\/session\/([^/]+)\/input$/);
  if (input) {
    let body = ''; for await (const chunk of req) body += chunk;
    inputBodies.push({ id: input[1], ...JSON.parse(body) });
    return json(res, { ok: true });
  }
  if (path.startsWith('/aios/api/')) return json(res, {});
  let name = path.replace(/^\/aios\/?/, '') || 'app.html';
  if (name === 'phone') name = 'phone.html';
  if (!extname(name)) name = 'app.html';
  const file = normalize(join(webRoot, name));
  if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
  try { res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/aios/`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) {
    storyRequests.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://fonts.**/*', route => route.abort());
    await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
    await page.goto(base + '?desktop=1');
    try { await page.locator('#dk-older-needs:not([hidden])').waitFor({ timeout: 10000 }); }
    catch (error) { throw new Error(JSON.stringify({ errors, content: await page.evaluate(() => document.querySelector('#view')?.innerText || document.title) }) + '\n' + error.message); }
    assert.equal(await page.locator('#dk-older-needs').getAttribute('open'), null);
    assert.equal(await page.locator('#dk-older-side').getAttribute('open'), null);
    assert.equal(await page.locator('#dk-older-needs-count').textContent(), '2');
    assert.equal(await page.locator('#dk-cards [data-sid="s_recent"]').isVisible(), true);
    assert.equal(await page.locator('#dk-cards [data-sid="s_fresh_report"]').isVisible(), true, 'old session with a new report remains prominent');
    assert.equal(await page.locator('#dk-cards [data-sid="s_old"]').count(), 0);
    assert.equal(await page.locator('#dk-older-cards [data-dk-card]').count(), 0, 'closed group does not build historical cards');
    assert.equal(await page.locator('#dk-older-side [data-sid="s_old"]').isVisible(), false);
    assert.equal(storyRequests.includes('s_old'), false, 'closed Needs You does not fetch old questions');
    await page.evaluate(async () => {
      const { upsertSession } = await import('/aios/shell.js');
      upsertSession({ id: 's_recent', unread: 0 });
      upsertSession({ id: 's_fresh_report', unread: 0 });
    });
    assert.equal(await page.locator('[data-dk-allclear]').count(), 0, 'all-older does not pretend the attention queue is empty');
    await page.evaluate(async () => {
      const { upsertSession } = await import('/aios/shell.js');
      upsertSession({ id: 's_recent', unread: 1 });
      upsertSession({ id: 's_fresh_report', unread: 1 });
    });
    await page.locator('#dk-older-needs > summary').click();
    await page.locator('#dk-older-cards [data-sid="s_old"]').waitFor();
    assert.equal(await page.locator('#dk-older-cards [data-sid="s_dismissed"]').count(), 0, 'Dismissed is still separate');
    await page.locator('#dk-older-side > summary').evaluate(el => el.click());
    await page.evaluate(async () => {
      window.oldGroup = document.querySelector('#dk-older-side');
      window.oldDot = document.querySelector('[data-dk-sess][data-sid="s_old_work"] .dk-dot');
      const { upsertSession } = await import('/aios/shell.js');
      upsertSession({ id: 's_old_work', summary: 'Progress metadata changed, not its age.' });
    });
    assert.equal(await page.evaluate(() => oldGroup === document.querySelector('#dk-older-side') && oldGroup.open
      && oldDot === document.querySelector('[data-dk-sess][data-sid="s_old_work"] .dk-dot')), true, 'live updates retain expansion and pulse nodes');
    assert.equal(await page.locator('#dk-older-needs').evaluate(el => el.open), true);
    const reply = page.locator('#dk-older-cards [data-sid="s_old_reply"]');
    await reply.locator('[data-dk-reply]').click();
    await reply.locator('textarea').fill('Please continue with the reviewed change.');
    await reply.locator('[data-dk-send]').click();
    await page.waitForFunction(() => !document.querySelector('#dk-older-cards [data-sid="s_old_reply"]'));
    assert.equal(inputBodies.at(-1).id, 's_old_reply', 'expanded cards still send to the intended handler');
    const draft = page.locator('#dk-older-cards [data-sid="s_old"]');
    await draft.locator('[data-dk-reply]').click();
    await draft.locator('textarea').fill('Keep this draft when a fresh report arrives.');
    await page.locator('#dk-older-needs > summary').click();
    await page.locator('#dk-older-needs > summary').click();
    assert.equal(await draft.locator('textarea').inputValue(), 'Keep this draft when a fresh report arrives.', 'collapse never clears a reply draft');
    await draft.locator('textarea').focus();
    await page.evaluate(async () => {
      const { upsertSession } = await import('/aios/shell.js');
      upsertSession({ id: 's_old', last_key: { id: 30, ts: Date.now(), text: 'A new report' } });
    });
    await page.locator('#dk-cards [data-sid="s_old"]').waitFor();
    assert.equal(await page.locator('#dk-cards [data-sid="s_old"] textarea').inputValue(), 'Keep this draft when a fresh report arrives.', 'promoting a card preserves its draft and focus');
    assert.equal(await page.locator('#dk-sessions > [data-sid="s_old"]').count(), 1, 'new reports promote sidebar and Needs You together');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.close();
  }
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await phone.route('https://fonts.**/*', route => route.abort());
  await phone.goto(base + 'phone');
  const toggle = phone.locator('#toggle-older-needs');
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await phone.locator('.needcard[data-open="s_old"]').count(), 0);
  await toggle.click();
  assert.equal(await phone.locator('.needcard[data-open="s_old"]').isVisible(), true);
  await phone.locator('#refresh-needs').click();
  await phone.waitForFunction(() => !document.querySelector('#refresh-needs')?.disabled);
  assert.equal(await phone.locator('#toggle-older-needs').getAttribute('aria-expanded'), 'true', 'phone refresh retains explicit expansion');
  const oldSessions = phone.locator('#toggle-older-sessions');
  assert.equal(await oldSessions.getAttribute('aria-expanded'), 'false');
  await oldSessions.click();
  assert.equal(await phone.locator('#ph-older-sessions [data-open="s_old_work"]').isVisible(), true);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await phone.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('session_recency_browser: desktop/tablet/phone collapse, live state, fresh report promotion and reply handler passed');
