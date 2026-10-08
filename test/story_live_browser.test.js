import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { readStoryPage } from '../src/story_reader.js';
import { createStoryUpdates } from '../src/story_updates.js';

// Drive filesystem → SSE → bounded reader → REAL Story DOM. Lifecycle never leaves Working.
const root = await mkdtemp(join(tmpdir(), 'aios-story-live-'));
const assets = new Map(['story-view.js', 'story-live.js', 'common.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
const files = new Map();
const sources = new Map();
let holdNext = false, held = null, failNext = false, failedRequests = 0;
const requests = [], connections = new Map();
const ts = n => new Date(1_700_000_000_000 + n * 1000).toISOString();
const record = (family, n, role, text, final = false) => JSON.stringify(family === 'codex'
  ? { timestamp: ts(n), type: 'response_item', payload: { type: 'message', role, phase: role === 'assistant' ? (final ? 'final_answer' : 'commentary') : undefined,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }
  : { timestamp: ts(n), type: role, message: { id: `${family}-${n}`, stop_reason: role === 'assistant' ? (final ? 'end_turn' : 'tool_use') : undefined, content: [{ type: 'text', text }] } }) + '\n';
const updates = createStoryUpdates({ resolve: async sid => sources.get(sid), debounceMs: 30, repairMs: 1000, pingMs: 1000 });
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(assets.get(url.pathname)); }
  const match = url.pathname.match(/^\/api\/session\/([^/]+)\/story(\/updates)?$/);
  if (match) {
    const sid = match[1];
    if (match[2]) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.flushHeaders();
      connections.set(sid, (connections.get(sid) || 0) + 1);
      const close = updates.subscribe(sid, res);
      req.on('close', () => { close(); connections.set(sid, connections.get(sid) - 1); });
      res.on('error', close); return;
    }
    const cursor = url.searchParams.get('cursor'); requests.push({ sid, cursor });
    if (failNext && !cursor) {
      failNext = false; failedRequests++;
      res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"Transient network/server error"}');
    }
    const result = await readStoryPage({ file: files.get(sid), cursor });
    const payload = { ok: true, events: result.events, status: 'working', meta: { ...result.meta, file: files.get(sid), source: 'transcript' } };
    if (holdNext && !cursor) { holdNext = false; held = () => { json(res, payload); held = null; }; return; }
    return json(res, payload);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>.story-feed{height:380px;overflow:auto;overflow-anchor:none}.story-body{white-space:pre-wrap}</style><div id="story"></div>
    <script type="module">import * as story from '/story-view.js'; window.story=story;
    window.fixtureHidden=false; Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.fixtureHidden});
    await story.initStoryView({sessionId:${JSON.stringify(url.searchParams.get('sid'))},panel:document.querySelector('#story'),live:true}); window.ready=true;</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
const waitHeld = async () => {
  const end = Date.now() + 5000;
  while (!held) { if (Date.now() > end) throw Error('held request missing'); await new Promise(r => setTimeout(r, 5)); }
};
const waitFor = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw Error('Story stream lifecycle did not settle'); await new Promise(r => setTimeout(r, 10)); }
};
try {
  for (const width of [1440, 820, 390]) for (const family of ['codex', 'claude']) {
    const sid = `s_${family}_${width}`, file = join(root, sid + '.jsonl');
    files.set(sid, file); sources.set(sid, { file, state: ['working'] });
    const work = family === 'codex'
      ? { timestamp: ts(2), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'work', arguments: JSON.stringify({ cmd: 'printf fixture' }) } }
      : { timestamp: ts(2), type: 'assistant', message: { id: 'work', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'work', name: 'Bash', input: { command: 'printf fixture' } }] } };
    await writeFile(file, record(family, 0, 'user', 'Verify live reporting') + record(family, 1, 'assistant', 'Real progress, not a status transition.') + JSON.stringify(work) + '\n');
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: width < 1000 });
    if (width < 600) {
      const network = await page.context().newCDPSession(page);
      await network.send('Network.enable');
      await network.send('Network.emulateNetworkConditions', { offline:false, latency:200, downloadThroughput:80*1024, uploadThroughput:40*1024 });
    }
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?sid=${sid}`);
    await page.waitForFunction(() => window.ready);
    await page.waitForFunction(() => document.body.textContent.includes('Real progress'));
    assert.equal(await page.locator('[data-kind="work"]').count(), 0, 'generic terminal filler is not an agent report');
    const began = Date.now();
    await appendFile(file, record(family, 3, 'assistant', '## Report 1\n\nThe first change is ready.', true));
    await page.waitForFunction(() => document.body.textContent.includes('The first change is ready.'));
    const latencyMs = Date.now() - began;
    assert.ok(latencyMs < (width < 600 ? 5000 : 2500), `native update is prompt at ${width}px (${latencyMs}ms)`);
    assert.equal(await page.locator('[data-kind="report"]').count(), 1, 'report appears while status remains Working');
    await page.evaluate(() => { window.firstReport=document.querySelector('[data-kind="report"]'); });
    // An old snapshot held on a slow connection must not consume the only dirty notification.
    holdNext = true;
    await page.evaluate(() => { void story.refreshStory(); });
    await waitHeld();
    await appendFile(file, record(family, 4, 'assistant', 'Fresh update during the held request.'));
    await page.waitForTimeout(700); // notify while the old HTTP result is still in flight
    held();
    await page.waitForFunction(() => document.body.textContent.includes('Fresh update during the held request.'));
    assert.equal(await page.evaluate(() => document.querySelector('[data-kind="report"]')===firstReport), true, 'unchanged report DOM survives live updates');
    // Mobile suspension/another workspace: three exchanges finish while there are no viewers.
    await page.evaluate(() => { fixtureHidden=true; document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => connections.get(sid) === 0);
    assert.equal(connections.get(sid), 0, 'hidden views release the stream');
    for (let n=2; n<=4; n++) await appendFile(file, record(family, n*10, 'user', `Request ${n}`) + record(family, n*10+1, 'assistant', `Report ${n}: actual result.`, true));
    await page.evaluate(() => { fixtureHidden=false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelectorAll('[data-kind="report"]').length===4);
    const text = await page.locator('#story').innerText();
    for (let n=2; n<=4; n++) assert.match(text, new RegExp(`Report ${n}: actual result`), 'reconnect fills every missed report, not only the last one');
    assert.ok(requests.filter(r=>r.sid===sid&&r.cursor).length>=2, 'catch-up uses bounded older pages');
    assert.equal(connections.get(sid), 1, 'resume owns one stream, never accumulates connections');
    failNext = true;
    const failuresBefore = failedRequests;
    await appendFile(file, record(family, 50, 'user', 'Give the final result') + record(family, 51, 'assistant', 'Report 5: "Worked in the terminal" is quoted in this actual report, which must stay.', true));
    await page.waitForFunction(() => document.body.textContent.includes('Report 5:'));
    assert.equal(failedRequests, failuresBefore + 1, 'a failed final-report fetch is retried without a new source update');
    assert.equal(await page.locator('[data-kind="report"]').count(), 5, 'retry keeps earlier reports and actual quoted text');
    await page.evaluate(() => story.destroyStoryView());
    await waitFor(() => connections.get(sid) === 0);
    assert.equal(connections.get(sid), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, family, weakNetwork:width<600, latencyMs, reports:5, status:'working', heldFetchRecovered:true, transientRetry:true, genericFiller:0 }));
    await page.close();
  }
} finally {
  held?.(); updates.close(); await browser.close(); await new Promise(r=>server.close(r));
  await rm(root, { recursive:true, force:true });
}
console.log('story_live_browser: native file → SSE → Story, slow-fetch recovery, all missed reports and mobile resume passed');
