import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const assets = new Map([
  ['/story-view.js', readFileSync(new URL('web/story-view.js', root))],
  ['/common.js', readFileSync(new URL('web/common.js', root))],
  ['/file-reference.js', readFileSync(new URL('web/file-reference.js', root))],
  ['/tts-player.js', readFileSync(new URL('web/tts-player.js', root))],
]);
const received = [];
let mode = 'trust';
const fixture = `<!doctype html><meta charset="utf-8"><body><div id="story"></div>
<script type="module">
  const story = await import('/story-view.js');
  window.__story = story;
  await story.initStoryView({ sessionId: 's_terminal_question', panel: document.querySelector('#story') });
  window.__storyReady = true;
</script>`;

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(assets.get(path)); return; }
  if (path === '/free') { mode = 'free'; res.writeHead(204); res.end(); return; }
  if (path === '/api/session/s_terminal_question/story') {
    const pendingQuestion = mode === 'trust' ? {
      ts: 20,
      body: 'Quick safety check: Is this a project you created or one you trust?',
      options: [{ label: 'No, exit' }, { label: 'Yes, I trust this folder' }],
    } : mode === 'free' ? {
      ts: 30,
      body: 'What should the home screen emphasize?',
      options: [],
    } : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, status: pendingQuestion ? 'waiting' : 'working', pendingQuestion,
      events: [{ kind: 'you', ts: 10, body: 'Build my project without losing this prompt.' }],
      meta: { source: 'fallback', file: null },
    }));
    return;
  }
  if (path === '/api/session/s_terminal_question/input' && req.method === 'POST') {
    received.push(await readBody(req));
    mode = 'answered';
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__storyReady);

  const card = page.locator('[data-kind="ask"]');
  await card.waitFor();
  assert.match(await card.innerText(), /Quick safety check: Is this a project you created or one you trust\?/,
    'Story mirrors the terminal question verbatim');
  assert.deepEqual(await card.locator('[data-story-ask-opt]').allTextContents(), ['No, exit', 'Yes, I trust this folder'],
    'Story mirrors every terminal choice');
  await card.getByRole('button', { name: 'Yes, I trust this folder' }).click();
  assert.deepEqual(received[0], { text: 'Yes, I trust this folder', source: 'text' },
    'a Story choice reaches the shared session input handler');
  await card.locator('.story-answered').waitFor();

  await page.evaluate(async () => { await fetch('/free'); await window.__story.refreshStory({ quiet: false }); });
  const free = page.locator('[data-kind="ask"]');
  await free.getByLabel('Reply to this question').fill('Prioritize the projects that need my decision.');
  await free.getByRole('button', { name: 'Reply' }).click();
  assert.deepEqual(received[1], { text: 'Prioritize the projects that need my decision.', source: 'text' },
    'a free-form terminal question is answerable inline in Story');
  await free.locator('.story-answered').waitFor();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('story_terminal_question_browser.test ok');
