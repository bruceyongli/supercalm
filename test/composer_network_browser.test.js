import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createWebAssets } from '../src/web_assets.js';

// Actual versioned SPA/composer → real HTTP fixture → durable receipt/native report surrogate.
// No live session receives input. Silence SSE, stall old downloads, and lose accepted POST replies.
const webDir = process.env.AIOS_BROWSER_FIXTURE_WEB_ROOT || fileURLToPath(new URL('../web/', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'aios-composer-network-'));
const assets = createWebAssets({ webDir, cacheDir: join(root, 'assets') });
const snapshot = await assets.current();
const sid = 's_delivery_network';
const session = { id: sid, tool: 'codex', status: 'waiting', title: 'Network fixture', autonomy: 'full',
  model: 'gpt-6.1-sol', effort: 'high', project: { name: 'Fixture', path: '/fixture' } };
let storyEvents = [], posts = [], mode = 'ok', holdNext = false, holdAll = false;
const receipts = new Map(), held = new Set(), hung = new Set();
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const payload = () => ({ ok: true, sessionId: sid, status: 'waiting', events: [...storyEvents], meta: { source: 'transcript', file: '/fixture.jsonl' } });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture'), path = url.pathname.replace(/^\/aios/, '');
  if (path.endsWith('/input')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); posts.push(body);
    if (mode === 'not-received') return res.destroy();
    let receipt = receipts.get(body.client_message_id);
    if (!receipt) {
      receipt = { id: receipts.size + 1, ts: Date.now() }; receipts.set(body.client_message_id, receipt);
      storyEvents.push({ kind: 'you', ts: receipt.ts, body: body.text },
        { kind: 'report', ts: receipt.ts + 1, body: `Answered: ${body.text}` });
    }
    if (mode === 'lost') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
      setTimeout(() => res.destroy(), 50); return;
    }
    if (mode === 'hung-body') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":');
      hung.add(res); res.on('close', () => hung.delete(res)); return;
    }
    return json(res, { ok: true, message: receipt });
  }
  if (path.includes('/input-receipt/')) {
    const receipt = receipts.get(path.split('/').at(-1));
    return json(res, { accepted: !!receipt, pending: false, message: receipt || null });
  }
  if (path.endsWith('/story')) {
    const body = payload();
    if (holdNext || holdAll) {
      holdNext = false; const entry = { res, body }; held.add(entry);
      res.on('close', () => held.delete(entry)); return;
    }
    return json(res, body);
  }
  if (path === `/api/session/${sid}`) return json(res, session);
  if (path === '/api/phone/home') return json(res, { sessions: [], counts: {} });
  if (path === '/api/launch-options') return json(res, { projects: [], tools: [{ id: 'codex', models: [], efforts: ['high'], autonomies: ['full'] }] });
  if (path === '/api/version') return json(res, { version: 'fixture', channel: 'every' });
  if (path.startsWith('/api/')) return json(res, {});
  const asset = await assets.get(path);
  if (asset) { res.writeHead(200, { 'content-type': asset.ext === '.css' ? 'text/css' : 'text/javascript', ...asset.headers }); return res.end(asset.body); }
  let name = path.replace(/^\//, '') || 'app.html';
  if (!extname(name)) name = 'app.html';
  if (name.includes('..')) { res.writeHead(400); return res.end(); }
  try {
    const raw = await readFile(join(webDir, name));
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(name)] || 'application/octet-stream' });
    res.end(name === 'app.html' ? await assets.html(raw.toString()) : raw);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const until = async check => {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw Error('fixture did not settle'); await new Promise(r => setTimeout(r, 20)); }
};
const release = () => { for (const { res, body } of held) json(res, body); held.clear(); };
try {
  for (const [type, width] of [[chromium, 1440], [webkit, 390], [webkit, 820]]) {
    mode = 'ok'; holdNext = holdAll = false; posts = []; receipts.clear(); storyEvents = [{ kind: 'report', ts: 1, body: 'Earlier report' }];
    const browser = await type.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width < 1000, isMobile: width < 600 });
      const errors = [], dialogs = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await page.route('https://fonts.**/*', route => route.abort());
      await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
      await page.goto(base + `/aios/session?id=${sid}&noresize&desktop=1`);
      await page.locator('.story-feed').waitFor();
      await page.evaluate(async id => { window.story = await import(`/aios/assets/${id}/story-view.js`); }, snapshot.id);
      const send = async text => { await page.locator('#reply').fill(text); await page.locator('#send').click(); };

      // A stale, pre-send GET can stay open indefinitely; acceptance must prioritize a fresh GET.
      holdNext = true;
      await page.evaluate(() => { void story.refreshStory(); }); await until(() => held.size);
      await send('发布了吗？学生等着安装');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-kind="report"]')].some(el => el.textContent.includes('Answered:')), null, { timeout: 6000 });
      assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 0);
      assert.equal(await page.locator('#reply').inputValue(), '');
      assert.equal(posts.length, 1);
      release();

      // Acceptance is visible without the much larger transcript: sent is not the same as read.
      holdAll = true;
      await send('Accepted while report downloads are stalled.');
      await page.waitForFunction(() => document.querySelector('[data-story-sendstate="sent"]'), null, { timeout: 5000 });
      assert.match(await page.locator('[data-story-sendstate="sent"]').innerText(), /sent.*syncing report/);
      assert.equal(await page.locator('#reply').inputValue(), '');
      holdAll = false; release();
      await page.waitForFunction(() => !document.querySelector('[data-story-sendstate="sent"]'));

      // TCP closes after native acceptance. Recovery is a GET, never a second operator instruction.
      mode = 'lost'; const beforeLost = posts.length;
      await send('Lost response, one instruction.');
      await page.waitForFunction(() => document.querySelector('#reply').value === '', null, { timeout: 10000 });
      assert.equal(posts.length, beforeLost + 1);
      assert.equal(storyEvents.filter(e => e.kind === 'you' && e.body === 'Lost response, one instruction.').length, 1);

      // Headers arrive but the JSON body never finishes: enforce the REAL production deadline.
      mode = 'hung-body'; const beforeHung = posts.length, started = Date.now();
      await send('Hung HTTP acknowledgement.');
      await until(() => hung.size);
      await page.locator('#reply').fill('Keep my next draft.');
      await page.waitForFunction(() => !document.querySelector('#send').disabled && !sessionStorage.getItem('aios_pending_send_s_delivery_network'), null, { timeout: 22000 });
      assert.ok(Date.now() - started < 22000);
      assert.equal(await page.locator('#reply').inputValue(), 'Keep my next draft.');
      assert.equal(posts.length, beforeHung + 1);

      // A request which never arrived remains recoverable; a deliberate retry reuses its identity.
      mode = 'not-received'; await send('Preserve an actually unsent request.');
      await page.waitForFunction(() => !document.querySelector('#send').disabled);
      const unsent = posts.at(-1).client_message_id;
      assert.equal(await page.locator('#reply').inputValue(), 'Preserve an actually unsent request.');
      assert.equal(receipts.has(unsent), false);
      mode = 'ok'; await page.locator('#send').click();
      await page.waitForFunction(() => document.querySelector('#reply').value === '');
      assert.equal(posts.at(-1).client_message_id, unsent);
      assert.equal(storyEvents.filter(e => e.kind === 'you' && e.body === 'Preserve an actually unsent request.').length, 1);
      await page.waitForFunction(() => !document.querySelector('[data-story-sendstate="pending"]'));
      assert.equal(await page.locator('[data-kind="you"]').filter({ hasText: 'Preserve an actually unsent request.' }).count(), 1,
        'a deliberate retry replaces its existing uncertain bubble instead of duplicating it');
      assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
      console.log(JSON.stringify({ engine: type.name(), width, versionedAssets: true, stalledStoryBypassed: true,
        sentBeforeStory: true, lostReplyPosts: 1, hungReplyMs: Date.now() - started, newDraftPreserved: true, pass: true }));
    } finally { holdAll = false; release(); for (const res of hung) res.destroy(); await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
