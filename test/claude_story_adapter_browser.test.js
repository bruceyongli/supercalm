import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { parseSessionLog } from '../src/story.js';

const assets = new Map(['story-view.js', 'common.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js', 'styles.css']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
const native = (second, type, content, extra = {}) => JSON.stringify({ type, version: '2.1.291',
  timestamp: new Date(Date.UTC(2026, 9, 6, 8, 0, second)).toISOString(), message: { content, ...extra } });
const tool = (second, id, description) => native(second, 'assistant', [{ type: 'tool_use', id, name: 'Bash', input: {
  description, command: 'python parser_check.py',
} }], { stop_reason: 'tool_use' });
const base = [native(0, 'user', 'Fix Story, not the coding CLI.'),
  native(1, 'assistant', [{ type: 'text', text: 'The report parser is receiving the CLI records.' }], { id: 'opening', stop_reason: 'tool_use' }),
  tool(2, 'first', 'Inspect the native output format'), tool(3, 'second', 'Compare the report boundary'),
  native(4, 'user', [{ type: 'tool_result', tool_use_id: 'second', is_error: true,
    content: 'Exit code 1\nok\nTraceback:\nTypeError: invalid boundary\n<script>window.injected=true</script>' }]),
  native(5, 'assistant', [{ type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: { questions: [
    { question: 'Which view should we verify?', header: 'View', options: [{ label: 'Story' }, { label: 'Terminal' }] },
  ] } }], { stop_reason: 'tool_use' }),
];
let phase = 'working';
let revised = false;
const received = [];
function current() {
  const extra = phase === 'working' ? [] : phase === 'cancelled' ? [
    native(6, 'user', [{ type: 'tool_result', tool_use_id: 'question', content: 'User cancelled the question.', is_error: true }]),
  ] : [
    JSON.stringify({ type: 'user', timestamp: new Date(Date.UTC(2026, 9, 6, 8, 0, 6)).toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'question', content: 'Answered.' }] },
      toolUseResult: { answers: { 'Which view should we verify?': 'Story' } } }),
    native(7, 'assistant', [{ type: 'text', text: '## Result\n\n| Item | Status |\n|---|---|\n| Native report | Visible |' }], { id: 'final', stop_reason: 'end_turn' }),
  ];
  const records = base.slice();
  if (revised) {
    records[1] = native(1, 'assistant', [{ type: 'text', text: 'Confirmed the native records use explicit completion boundaries.' }], { id: 'opening', stop_reason: 'tool_use' });
    records[3] = tool(3, 'second', 'Check the explicit completion boundary');
  }
  return parseSessionLog([...records, ...extra].join('\n'));
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(assets.get(path)); return; }
  if (path === '/cancel') { phase = 'cancelled'; res.writeHead(204); res.end(); return; }
  if (path === '/revise') { revised = true; res.writeHead(204); res.end(); return; }
  if (path === '/api/session/s_native/story') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events: current(), status: phase === 'working' ? 'working' : 'waiting',
      meta: { source: 'transcript', file: '/fixture-native.jsonl', trimmed: false } })); return;
  }
  if (path === '/api/session/s_native/input' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ handler: path, body: JSON.parse(body) }); phase = 'answered';
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
    <style>#story{max-width:100%;height:600px}.story-feed{height:450px;overflow:auto}</style><div id="story"></div>
    <script type="module">import * as story from '/story-view.js'; window.story=story;
      await story.initStoryView({sessionId:'s_native',panel:document.querySelector('#story')});window.ready=true;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) {
    phase = 'working'; revised = false; received.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
    assert.equal(await page.locator('[data-kind="report"]').count(), 0, 'live tool_use commentary is not a completed report');
    assert.match(await page.locator('[data-kind="work"] .story-title').innerText(), /Compare the report boundary/);
    const failed = page.locator('[data-kind="fail"]');
    assert.equal(await failed.locator('.story-body').innerText(), 'TypeError: invalid boundary');
    await failed.locator('[data-story-steps-toggle]').click();
    assert.match(await failed.locator('.story-tool-output').innerText(), /Exit code 1\nok/);
    assert.equal(await page.evaluate(() => window.injected), undefined, 'tool output is escaped, never executed');
    await page.evaluate(() => story.refreshStory());
    assert.equal(await failed.locator('.story-tool-output').count(), 1, 'expanded error remains open across refresh, using the source index');
    await page.evaluate(async () => { await fetch('/revise'); await story.refreshStory(); });
    assert.equal(await page.locator('[data-kind="note"]').count(), 1, 'rewritten message block updates in place without a ghost duplicate');
    assert.equal(await page.locator('[data-kind="work"]').count(), 1, 'a changed tool headline does not duplicate the same invocation');
    assert.match(await page.locator('[data-kind="work"] .story-title').innerText(), /Check the explicit completion boundary/);
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    assert.deepEqual(received, [{ handler: '/api/session/s_native/input', body: { text: 'Story', source: 'text' } }], 'native question choice reaches the shared input handler exactly once');
    await page.evaluate(() => story.refreshStory());
    assert.equal(await page.locator('[data-kind="report"] table').count(), 1, 'native end_turn report renders its actual rich content');
    assert.match(await page.locator('[data-kind="ask"]').innerText(), /answered "Story"/);
    assert.equal(await page.locator('[data-story-ask-opt]').count(), 0, 'durable structured answer removes stale options');
    await page.evaluate(() => { window.reportNode = document.querySelector('[data-kind="report"]'); });
    await page.evaluate(() => story.refreshStory());
    assert.equal(await page.evaluate(() => document.querySelector('[data-kind="report"]') === reportNode), true, 'unchanged report keeps its DOM identity');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px does not overflow horizontally`);
    await page.close();
  }
  phase = 'working';
  revised = false;
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
  await page.evaluate(async () => { await fetch('/cancel'); await story.refreshStory(); });
  assert.match(await page.locator('[data-kind="ask"]').innerText(), /Question cancelled/);
  assert.equal(await page.locator('[data-story-ask-opt]').count(), 0, 'cancelled CLI prompts cannot be answered from stale Story controls');
  await page.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('claude_story_adapter_browser: desktop/tablet/phone native parse → Story → input handler, grounded errors and report stability passed');
