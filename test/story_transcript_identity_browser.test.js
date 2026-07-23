import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const assets = new Map([
  ['/story-view.js', readFileSync(new URL('web/story-view.js', root))],
  ['/common.js', readFileSync(new URL('web/common.js', root))],
  ['/tts-player.js', readFileSync(new URL('web/tts-player.js', root))],
]);
let version = 0;
const fixture = `<!doctype html><meta charset="utf-8"><body><div id="story"></div>
<script type="module">
  const story = await import('/story-view.js');
  window.__story = story;
  story.initStoryView({ sessionId: 's_concurrent', panel: document.querySelector('#story') });
  window.__storyReady = true;
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(assets.get(path)); return; }
  if (path === '/advance') { version = 1; res.writeHead(204); res.end(); return; }
  if (path === '/api/session/s_concurrent/story') {
    const body = version
      ? { ok: true, status: 'working', events: [{ kind: 'you', ts: 2, body: 'FRESH SESSION TASK' }], meta: { source: 'transcript', file: '/rollouts/fresh.jsonl' } }
      : { ok: true, status: 'working', events: [{ kind: 'you', ts: 1, body: 'OLDER SIBLING SECRET' }], meta: { source: 'transcript', file: '/rollouts/older.jsonl' } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__storyReady && document.body.textContent.includes('OLDER SIBLING SECRET'));
  await page.evaluate(async () => {
    await fetch('/advance');
    await window.__story.refreshStory({ quiet: false });
  });
  await page.waitForFunction(() => document.body.textContent.includes('FRESH SESSION TASK'));
  const text = await page.locator('#story').innerText();
  assert.match(text, /FRESH SESSION TASK/);
  assert.doesNotMatch(text, /OLDER SIBLING SECRET/, 'a different transcript file replaces rather than merges the sibling conversation');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('story_transcript_identity_browser.test ok');
