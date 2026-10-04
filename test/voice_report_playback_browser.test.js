import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const assets = new Map(['story-view.js', 'common.js', 'markdown-inline.js', 'file-reference.js', 'tts-player.js']
  .map(name => ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
const calls = []; let legacyCalls = 0;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (assets.has(path)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(assets.get(path)); return; }
  if (path === '/voicemode.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end('export function stopVoiceMode() {} export async function startVoiceMode(options) { await fetch("/fixture-start", {method:"POST",body:JSON.stringify(options)}); }'); return;
  }
  if (path === '/fixture-start') { let text = ''; for await (const chunk of req) text += chunk; calls.push(JSON.parse(text)); res.end('{}'); return; }
  if (path.includes('voice-report') || path.includes('/tts')) { legacyCalls++; res.writeHead(500); res.end(); return; }
  if (path === '/api/session/s_voice/story') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'waiting', events: [
      { kind: 'report', ts: 5, body: 'The previous round is finished.' },
      { kind: 'you', ts: 8, body: 'Improve the current voice report.' },
      { kind: 'report', ts: 10, body: 'The new voice answer now streams immediately. You can ask for details.' },
    ], meta: { source: 'transcript', file: '/fixture.jsonl' } })); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<div id="story"></div><script type="module">const story=await import("/story-view.js");story.initStoryView({sessionId:"s_voice",panel:document.querySelector("#story")});</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.locator('[data-story-listen]').last().waitFor();
  assert.deepEqual(await page.locator('[data-story-listen]').allTextContents(), ['▶ Explain', '▶ Explain']);
  await page.locator('[data-story-listen]').last().click();
  for (let n = 0; !calls.length && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, [{ focusSessionId: 's_voice', source: 'session-explain', reportTs: 10 }], 'the chosen Story report enters the same interactive assistant');
  assert.equal(legacyCalls, 0, 'no independent script generation, polling or audio playlist remains');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('voice_report_playback_browser.test ok');
