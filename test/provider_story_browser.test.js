import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { PROVIDER_CONTINUE_TEXT } from '../web/provider-issue.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const sid = 's_provider_story';
const initial = { id: sid, tool: 'codex', toolLabel: 'Codex', status: 'waiting', title: 'Provider failure fixture',
  autonomy: 'full', effort: 'xhigh', model: 'gpt-6.1-sol', revision: 1,
  project: { name: 'SemaMorph', path: '/fixture' }, composer_history: [] };
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const streams = new Set(), received = [], accepted = new Map();
let session, issue, events, release, rejectSend = false, reportId = 0;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === `/aios/api/session/${sid}/story/updates`) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.flushHeaders();
    streams.add(res); req.on('close', () => streams.delete(res)); res.on('error', () => streams.delete(res)); return;
  }
  if (path === `/aios/api/session/${sid}/story`) return json(res, { ok: true, sessionId: sid, events, status: session.status,
    providerIssue: issue, pendingQuestion: null, meta: { source: 'transcript', file: '/fixture.jsonl' } });
  if (path === `/aios/api/session/${sid}/input`) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    if (accepted.has(body.client_message_id)) return json(res, { ok: true, duplicate: true, message: accepted.get(body.client_message_id) });
    release = () => {
      release = null;
      if (rejectSend) return json(res, { error: 'Submission was not confirmed. Please retry.', inputBlocked: true }, 409);
      const message = { id: received.length, ts: Date.now() };
      accepted.set(body.client_message_id, message);
      events.push({ kind: 'you', ts: message.ts, body: body.text });
      issue = null; session.status = 'working';
      json(res, { ok: true, message });
    }; return;
  }
  if (path === `/aios/api/session/${sid}`) return json(res, session);
  if (path === '/aios/api/phone/home') return json(res, { sessions: [], counts: {} });
  if (path === '/aios/api/launch-options') return json(res, { projects: [], tools: [{ id: 'codex', models: [], efforts: ['xhigh'], autonomies: ['full'] }] });
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
const base = `http://127.0.0.1:${server.address().port}/aios/`;
const waitFor = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture request did not arrive'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
function update(code, phase = 'blocked') {
  issue = code ? { code, phase, reportId: ++reportId } : null;
  session.status = phase === 'retrying' || !code ? 'working' : 'waiting';
  for (const res of streams) res.write(`event: update\ndata: ${JSON.stringify({ session: sid })}\n\n`);
}
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [1440, 820, 390]) {
        session = { ...initial }; events = [{ kind: 'you', ts: 1, body: 'Finish the requested implementation.' }];
        issue = null; received.length = 0; accepted.clear(); rejectSend = false;
        const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 1000, serviceWorkers: 'block' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route('https://fonts.**/*', route => route.abort());
        await page.goto(base + `session?id=${sid}&view=story&noresize&desktop=1`, { waitUntil: 'domcontentloaded' });
        await page.locator('.story-feed').waitFor(); await waitFor(() => streams.size);
        await page.locator('#reply').fill('Keep this unfinished message — 不要删除。');
        update('capacity');
        const card = page.locator('[data-story-provider-issue]'), button = page.locator('[data-story-continue]');
        await card.waitFor();
        assert.match(await card.innerText(), /Model at capacity/);
        assert.equal(await page.locator('[data-kind="ask"]').count(), 0, 'not a false question');
        const box = await button.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= 900 && box.x >= 0 && box.x + box.width <= width, 'Continue is visible at every device size');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.AIOS_TEST_SCREENSHOTS) {
          await mkdir(process.env.AIOS_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.AIOS_TEST_SCREENSHOTS, `provider-story-${engine.name()}-${width}.png`) });
        }
        await page.evaluate(() => { window.originalIssue = document.querySelector('[data-story-provider-issue]'); });
        for (const res of streams) res.write(`event: update\ndata: ${JSON.stringify({ session: sid })}\n\n`);
        await page.evaluate(async () => (await import('/aios/story-view.js')).refreshStory());
        assert.equal(await page.evaluate(() => originalIssue === document.querySelector('[data-story-provider-issue]')), true, 'unchanged SSE retains focused card/button');
        rejectSend = true;
        await button.click(); await waitFor(() => release);
        assert.equal(await button.isDisabled(), true);
        await page.evaluate(() => document.querySelector('[data-story-continue]').click());
        assert.equal(received.length, 1, 'pending repeated taps cannot send twice');
        release(); await card.getByRole('alert').waitFor();
        assert.equal(await page.locator('#reply').inputValue(), 'Keep this unfinished message — 不要删除。');
        assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 0, 'no fake sent bubble after rejection');
        rejectSend = false;
        await button.click(); await waitFor(() => release);
        assert.equal(received[0].client_message_id, received[1].client_message_id, 'retry keeps its delivery identity');
        assert.equal(received[1].text, PROVIDER_CONTINUE_TEXT);
        assert.equal(received[1].provider_retry.code, 'capacity');
        release(); await card.waitFor({ state: 'detached' });
        await page.waitForFunction(text => [...document.querySelectorAll('[data-kind="you"]')].filter(el => el.textContent.includes(text)).length === 1, PROVIDER_CONTINUE_TEXT);
        assert.equal(await page.locator('#reply').inputValue(), 'Keep this unfinished message — 不要删除。');
        for (const code of ['authentication', 'billing', 'permission', 'context', 'model', 'request', 'generic']) {
          events.push({ kind: 'fail', ts: Date.now(), title: 'Native provider error', body: `API Error: ${code}: exact diagnostic`, providerIssue: { code, phase: 'blocked' } });
          update(code);
          await page.evaluate(async () => (await import('/aios/story-view.js')).refreshStory());
          await page.waitForFunction(code => document.querySelector('[data-story-provider-issue]')?.dataset.providerCode === code, code);
          assert.equal(await button.count(), 0, `${code} needs corrective action, not blind retries`);
          if (code === 'authentication') assert.equal(await card.getByRole('link', { name: 'Sign in' }).count(), 1);
          await card.locator('summary').click();
          assert.match(await card.locator('pre').innerText(), new RegExp(`${code}: exact diagnostic`), 'the real native error remains readable in Story');
        }
        update('overloaded', 'retrying');
        await page.waitForFunction(() => document.querySelector('[data-story-provider-issue]')?.classList.contains('retrying'));
        assert.match(await card.innerText(), /no action needed yet/); assert.equal(await button.count(), 0);
        // A navigation while delivery is in flight must not add a Continue echo to the new session.
        update('capacity'); await button.waitFor();
        await button.click(); await waitFor(() => release);
        await page.evaluate(async () => {
          const story = await import('/aios/story-view.js');
          story.destroyStoryView();
          await story.initStoryView({ sessionId: 's_other_fixture', panel: document.querySelector('[data-story-panel]') });
        });
        release();
        await page.evaluate(async () => (await import('/aios/story-view.js')).refreshStory());
        assert.equal(await page.locator('[data-story-provider-issue]').count(), 0);
        assert.doesNotMatch(await page.locator('[data-story-panel]').innerText(), /Continue the current task|Continue sent/);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ engine: engine.name(), width, liveTransport: 'real SSE', blockerVisible: true,
          stableDOM: true, inputHandler: received[0].provider_retry, rejectedThenRetried: 'same identity', draftPreserved: true, navigationFenced: true }));
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally {
  release?.(); for (const res of streams) res.end(); await new Promise(resolve => server.close(resolve));
}
console.log('provider_story_browser: desktop/iPad/iPhone Chromium + WebKit passed');
