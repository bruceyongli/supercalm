import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { parseSessionLog } from '../src/story.js';

const root = new URL('../', import.meta.url);
const assets = new Map(['story-view.js', 'common.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('web/' + name, root))]));
let multi = false, fail = false;
const received = [];
const nativeEvents = () => {
  const questions = [{ title: 'Which runtime?', options: ['Node', 'Bun'] },
    { title: 'Which checks?', options: ['Focused', 'Full'], multiSelect: multi }];
  const row = payload => JSON.stringify({ type: 'response_item', timestamp: '2026-10-03T16:30:49.160Z', payload });
  return parseSessionLog([row({ type: 'function_call', name: 'request_user_input_async', call_id: 'call_async_browser', arguments: JSON.stringify({ questions }) }),
    row({ type: 'function_call_output', call_id: 'call_async_browser', output: '{"accepted":true}' })].join('\n'));
};
const fixture = `<!doctype html><meta name="viewport" content="width=device-width"><div id="story"></div>
<script type="module">window.story=await import('/story-view.js');await story.initStoryView({sessionId:'s_async_browser',panel:document.querySelector('#story')});window.ready=true;</script>`;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(assets.get(path)); }
  if (path.endsWith('/story')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, events: nativeEvents(), status: 'working', meta: { source: 'transcript', file: 'private-native.jsonl' } }));
  }
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ path, body: JSON.parse(raw) });
    res.writeHead(fail ? 409 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(fail ? { error: 'The agent is busy; nothing was delivered.' } : { ok: true }));
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    multi = false; fail = false;
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    assert.equal(await page.locator('[data-kind="ask"]').count(), 2, 'both title-based questions render despite immediate ack');
    const baseline = received.length;
    await page.locator('[data-story-async-opt]').filter({ hasText: 'Node' }).click();
    assert.equal(received.length, baseline, 'the first choice does not prematurely send a multi-question prompt');
    await page.evaluate(() => window.story.refreshStory({ quiet: false }));
    assert.equal(await page.locator('[data-story-async-opt][aria-pressed="true"]').count(), 1, 'live refresh preserves the selection');
    await page.locator('[data-story-async-opt]').filter({ hasText: 'Full' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.story-answered').length === 2);
    assert.equal(received.length, baseline + 1);
    assert.equal(received.at(-1).path, '/api/session/s_async_browser/answers');
    assert.deepEqual(received.at(-1).body.answers.map(a => a.values[0].label), ['Node', 'Full']);
    assert.equal(received.at(-1).body.answers[0].ask_id, 'call_async_browser');
    await page.evaluate(() => window.story.refreshStory({ quiet: false }));
    assert.equal(await page.locator('[data-story-async-opt]').count(), 0, 'accepted choice does not reappear on a stale native ack');
    await page.close();
    console.log(JSON.stringify({ viewport: width, native: 'request_user_input_async', questions: 2, handler: '/answers', completeSubmissions: 1 }));
  }
  multi = true; fail = true;
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready);
  const baseline = received.length;
  await page.locator('[data-story-async-opt]').filter({ hasText: 'Bun' }).click();
  await page.locator('[data-story-async-opt]').filter({ hasText: 'Focused' }).click();
  await page.locator('[data-story-async-opt]').filter({ hasText: 'Full' }).click();
  assert.equal(received.length, baseline, 'multi-select waits for explicit submit');
  await page.locator('[data-story-async-send]').click();
  await page.locator('[role="alert"]').first().waitFor();
  assert.equal(await page.locator('.story-answered').count(), 0, 'failed delivery never dismisses the questions');
  assert.equal(await page.locator('[data-story-async-opt][aria-pressed="true"]').count(), 3, 'failed delivery preserves all choices');
  fail = false;
  await page.locator('[data-story-async-send]').click();
  await page.waitForFunction(() => document.querySelectorAll('.story-answered').length === 2);
  assert.deepEqual(received.at(-1).body.answers[1].values.map(v => v.label), ['Focused', 'Full']);
  await page.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log('codex_async_question_browser.test ok');
