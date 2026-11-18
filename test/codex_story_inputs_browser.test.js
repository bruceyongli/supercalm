import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { parseSessionLog } from '../src/story.js';
import { reconcileStoryInputs, nativeInputEvidence } from '../src/story_inputs.js';

const assets = new Map(['story-view.js', 'story-request.js', 'story-live.js', 'common.js', 'session-indicator.js',
  'provider-issue.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
const ts = n => 1794986600000 + n * 1000;
const record = (n, role, text, phase, metadata) => ({ type: 'response_item', timestamp: new Date(ts(n)).toISOString(), metadata,
  payload: { type: 'message', role, id: `message-${n}`, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const prefix = '保留已经提交的原答和记录。'.repeat(15);
const texts = [prefix + '修复数学中文输入。', prefix + '还有写作和阅读的完成状态。'];
let native = [], inputs = [];
function payload() {
  const parsed = parseSessionLog(native.map(r => JSON.stringify(r)).join('\n'));
  const evidence = nativeInputEvidence(parsed);
  const result = reconcileStoryInputs(parsed, inputs, { receipts: evidence.inputReceipts, windowStart: evidence.inputWindowStart });
  return { ok: true, sessionId: 's_codex', status: 'working', events: result.events,
    meta: { source: 'transcript', file: '/fixture/own-rollout.jsonl', readInputIds: result.readInputIds } };
}
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(assets.get(path)); }
  if (path === '/api/session/s_codex/story') {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(payload()));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>.story-feed{height:420px;overflow:auto}</style><div id="story"></div>
    <script type="module">import * as story from '/story-view.js';window.story=story;
    // A pre-release cache must not bring internal handoffs back after upgrading.
    sessionStorage.setItem('aios_story13_s_codex', JSON.stringify({sessionId:'s_codex',events:[{kind:'report',ts:1,body:'OLD INTERNAL HANDOFF'}]}));
    await story.initStoryView({sessionId:'s_codex',panel:document.querySelector('#story')});window.ready=true;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const [name, type, width] of [['chromium', chromium, 1440], ['webkit-phone', webkit, 390], ['webkit-ipad', webkit, 820]]) {
    native = [record(0, 'user', '修复三个问题'), record(1, 'assistant', '先检查输入和记录链路。', 'commentary')];
    inputs = [];
    const browser = await type.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 1000, hasTouch: width < 1000 });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const url = `http://127.0.0.1:${server.address().port}/`;
      await page.goto(url); await page.waitForFunction(() => window.ready);
      assert.doesNotMatch(await page.locator('#story').innerText(), /OLD INTERNAL HANDOFF/);
      // Two inputs accepted mid-turn. Reload/another device must not depend on optimistic echoes.
      inputs = texts.map((text, i) => ({ id: i + 1, ts: ts(i + 2), direction: 'in', source: 'text', text,
        client_message_id: `send-${i}`, delivery_state: 'sent' }));
      native.push(record(4, 'assistant', 'Internal compaction report', 'final_answer', { compaction_output: true }),
        record(5, 'assistant', '已定位原因，继续修复。', 'commentary'));
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 3);
      for (const text of texts) assert.ok((await page.locator('#story').innerText()).includes(text));
      assert.equal(await page.locator('[data-kind="report"]').count(), 0);
      await page.reload(); await page.waitForFunction(() => window.ready);
      assert.equal(await page.locator('[data-kind="you"]').count(), 3);
      const otherContext = await browser.newContext({ viewport: { width, height: 900 } });
      const other = await otherContext.newPage(); await other.goto(url); await other.waitForFunction(() => window.ready);
      assert.equal(await other.locator('[data-kind="you"]').count(), 3, 'independent browser sees durable inputs');
      const sentKey = await page.locator('[data-kind="you"]').last().getAttribute('data-story-key');
      // The transcript catches up; receipt identities update in place, never add duplicate bubbles.
      native.splice(2, 0, record(2, 'user', texts[0]), record(3, 'user', texts[1]));
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 3);
      assert.equal(await page.locator('[data-kind="you"]').last().getAttribute('data-story-key'), sentKey,
        'native read keeps the same durable bubble identity while updating its delivery label');
      assert.equal(await page.locator('[data-kind="you"]').filter({ hasText: texts[1] }).innerText().then(text => /read/i.test(text)), true);
      native.push(record(6, 'assistant', '修复已经发布，原答保留。', 'final_answer'));
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="report"]').count(), 1);
      assert.doesNotMatch(await page.locator('#story').innerText(), /Internal compaction|OLD INTERNAL/);
      const legacy = record(7, 'user', 'Legacy native input before receipt'); delete legacy.payload.id;
      native.push(legacy); await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 4);
      inputs.push({ id: 3, ts: ts(7), direction: 'in', source: 'text', text: 'Legacy native input before receipt',
        client_message_id: 'send-legacy', delivery_state: 'sent' });
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 4, 'late receipt cannot duplicate a legacy no-ID native record');
      native.push({ type: 'event_msg', timestamp: new Date(ts(8)).toISOString(), payload: { type: 'user_message', message: 'Late native mirror' } });
      await page.evaluate(() => story.refreshStory());
      native.push(record(9, 'user', 'Late native mirror'));
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 5, 'an appended identified mirror re-keys the original no-ID bubble');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine: name, width, midTurnInputs: 2, survivesReload: true,
        independentBrowser: true, nativeReadWithoutDuplicate: true, internalReports: 0, finalReports: 1 }));
      await otherContext.close(); await context.close();
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
