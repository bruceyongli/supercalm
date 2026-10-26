import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { parseSessionLog } from '../src/story.js';
import { messageToEvent } from '../src/story_spine.js';

// Real parser → HTTP → real Story module/DOM, without a production DB, terminal or coding agent.
const assets = new Map(['story-view.js', 'story-request.js', 'common.js', 'session-indicator.js', 'provider-issue.js',
  'markdown-inline.js', 'file-reference.js', 'tts-player.js'].map(name =>
  ['/' + name, readFileSync(new URL('../web/' + name, import.meta.url))]));
const states = new Map(), held = [], inputs = [];
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (assets.has(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(assets.get(url.pathname)); }
  const match = url.pathname.match(/^\/api\/session\/([^/]+)\/(story|input)$/);
  if (match) {
    const [_, id, action] = match, state = states.get(id);
    if (action === 'input') {
      let body = ''; for await (const chunk of req) body += chunk;
      inputs.push({ id, body: JSON.parse(body) });
      if (state.holdInput) { held.push(() => json(res, { ok: true })); return; }
      return json(res, { ok: true });
    }
    const cursor = url.searchParams.get('cursor');
    const payload = JSON.parse(JSON.stringify({ sessionId: state.owner || id, events: cursor ? state.older || [] : state.events,
      status: 'waiting', meta: { source: state.source || 'transcript', file: state.source === 'fallback' ? null : `${id}.jsonl`,
        trimmed: !cursor && !!state.cursor, cursor: cursor ? null : state.cursor || null } }));
    if (state.hold || cursor && state.holdOlder) {
      state.hold = false; state.holdOlder = false; held.push(() => json(res, payload)); return;
    }
    return json(res, payload);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>.story-feed{height:400px;overflow:auto}.story-body{white-space:pre-wrap}</style><div id="story"></div>
    <script type="module">import * as story from '/story-view.js'; window.story=story;
    window.samples=[];window.shown=null;
    new MutationObserver(()=>samples.push({id:shown,text:document.querySelector('#story').textContent}))
      .observe(document.querySelector('#story'),{childList:true,subtree:true,characterData:true});
    window.mount=id=>{shown=id;return story.initStoryView({sessionId:id,panel:document.querySelector('#story')});};
    window.ready=true;</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const waitHeld = async () => {
  const until = Date.now() + 5000;
  while (!held.length) { if (Date.now() > until) throw Error('held request missing'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const native = (id, text, ts = Date.now()) => parseSessionLog(JSON.stringify({ type: 'user', uuid: id,
  timestamp: new Date(ts).toISOString(), message: { content: [{ type: 'text', text }] } }));
const attachment = '/fixture/.aios/attachments/s_a/1792986394924-pasted-1.txt';
const request = 'Make the new naming rule the default.\n\nUse GPT6.1 sol max as fallback. 中文请求。';
const paste = `<pasted_content id="fe04">\n${request}\n\nAttached files available locally to this coding CLI:\n1. pasted-1.txt (TXT, text/plain): ${attachment}\n\nOpen these paths directly when you need the uploaded content.\n</pasted_content id="fe04">`;

try {
  for (const [engine, width] of [[chromium, 1440], [chromium, 390], [webkit, 820]]) {
    const browser = await engine.launch({ headless: true });
    try {
      states.clear(); inputs.length = 0;
      states.set('s_a', { events: [] }); states.set('s_b', { events: [{ kind: 'report', ts: 1, body: 'ONLY SESSION B' }] });
      const a = states.get('s_a'), b = states.get('s_b');
      const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width < 1000, isMobile: width < 600 });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await page.waitForFunction(() => window.ready);
      await page.evaluate(() => mount('s_a'));
      await page.evaluate(text => { window.echo = story.noteComposerSend(text, { sessionId: 's_a', clientMessageId: 'paste-send' }); }, request);
      assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 1);
      a.events = native('native-paste-1', paste);
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 1, 'paste receipt replaces optimistic echo, not a second bubble');
      assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 0);
      assert.equal(await page.locator('[data-story-sendstate="read"]').count(), 1);
      assert.doesNotMatch(await page.locator('#story').innerText(), /pasted_content/);
      const attachmentLink = await page.getByRole('link', { name: 'pasted-1.txt', exact: true }).getAttribute('href');
      assert.equal(new URL(attachmentLink, base).searchParams.get('path'), attachment);
      // Identical new sends cannot be acknowledged by the message already visible before clicking.
      await page.evaluate(text => { window.repeat = story.noteComposerSend(text, { sessionId: 's_a' }); }, request);
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 1);
      a.events.push(...native('native-paste-2', paste));
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 2, 'a genuine second send stays a distinct message');
      assert.equal(await page.locator('[data-story-sendstate="read"]').count(), 2);
      const prefix = 'These two requests deliberately have the same opening but different final instructions. ';
      await page.evaluate(text => { window.unmatched = story.noteComposerSend(text); }, prefix + 'Keep the folder.');
      a.events.push(...native('other-request', prefix + 'Remove the folder.'), { kind: 'you', ts: Date.now(), body: '' });
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 1, 'neither a shared prefix nor an empty event is a read receipt');
      await page.evaluate(() => story.cancelComposerSend(unmatched));

      // A saved database row removes duplication but is not proof that the coding agent consumed it.
      const long = 'Full request.\n\n' + 'Keep every requirement. 中文。 '.repeat(250) + '\n\nFinal requirement.';
      await page.evaluate(text => { window.stored = story.noteComposerSend(text, { sessionId: 's_a', clientMessageId: 'stored-long' }); }, long);
      a.source = 'fallback';
      a.events = [messageToEvent({ direction: 'in', source: 'text', ts: Date.now(), text: long, client_message_id: 'stored-long' })];
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 1, 'stored receipt merges by client message id even when fallback display is clipped');
      assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 1, 'stored is still unread');
      assert.equal(await page.locator('[data-story-sendstate="read"]').count(), 0);
      a.source = 'transcript'; a.events = native('long-user', `<pasted_content id="long">${long}</pasted_content>`);
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-kind="you"]').count(), 1);
      assert.equal(await page.locator('[data-story-sendstate="pending"]').count(), 0);
      assert.equal(await page.locator('[data-story-sendstate="read"]').count(), 1);
      assert.match(await page.locator('[data-kind="you"]').innerText(), /Full request/);

      // Wrong cache owner + wrong HTTP owner are rejected BEFORE a frame is painted, not on refresh.
      await page.evaluate(() => {
        sessionStorage.setItem(story.STORY_CACHE_KEY('s_b'), sessionStorage.getItem(story.STORY_CACHE_KEY('s_a')));
        samples.length = 0;
      });
      b.owner = 's_a'; b.events = [{ kind: 'report', ts: 1, body: 'WRONG HTTP OWNER SECRET' }];
      await page.evaluate(() => mount('s_b'));
      assert.doesNotMatch(await page.locator('#story').innerText(), /Full request|WRONG HTTP OWNER/);
      b.owner = 's_b'; b.events = [{ kind: 'report', ts: 1, body: 'ONLY SESSION B' }];
      await page.evaluate(() => story.refreshStory());
      assert.match(await page.locator('#story').innerText(), /ONLY SESSION B/);
      assert.equal(await page.evaluate(() => samples.some(s => s.id === 's_b' && /Full request|WRONG HTTP OWNER/.test(s.text))), false,
        'no transient cross-session content, including the initial cache paint');
      assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem(story.STORY_CACHE_KEY('s_b'))).sessionId), 's_b');
      assert.equal(await page.evaluate(() => story.noteComposerSend('WRONG ECHO', { sessionId: 's_a' })), null);
      await page.evaluate(async () => {
        story.cancelComposerSend(echo);
        await story.initStoryView({ sessionId: 's_a', panel: document.querySelector('#story'), signal: AbortSignal.abort() });
      });
      assert.match(await page.locator('#story').innerText(), /ONLY SESSION B/, 'aborted late initializer cannot reclaim the active singleton');

      // Ignore fetch abort deliberately: late-body guards must work even if cancellation loses a race.
      await page.evaluate(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = (url, options) => fetch(url, { ...options, signal: undefined });
        sessionStorage.clear(); samples.length = 0;
      });
      a.events = [{ kind: 'report', ts: 1, body: 'LATE SESSION A SECRET' }]; a.hold = true;
      await page.evaluate(() => { window.late = mount('s_a'); }); await waitHeld();
      await page.evaluate(() => mount('s_b'));
      held.shift()(); await page.evaluate(() => late);
      assert.doesNotMatch(await page.locator('#story').innerText(), /LATE SESSION A/);
      assert.equal(await page.evaluate(() => samples.some(s => s.id === 's_b' && s.text.includes('LATE SESSION A'))), false);
      // A → B → A still cannot accept the first A's old response with the same file/session id.
      a.events = [{ kind: 'report', ts: 2, body: 'OBSOLETE A GENERATION' }]; a.hold = true;
      await page.evaluate(() => { window.late = mount('s_a'); }); await waitHeld();
      await page.evaluate(() => mount('s_b'));
      a.events = [{ kind: 'report', ts: 3, body: 'FRESH A GENERATION' }];
      await page.evaluate(() => mount('s_a'));
      held.shift()(); await page.evaluate(() => late);
      assert.match(await page.locator('#story').innerText(), /FRESH A GENERATION/);
      assert.doesNotMatch(await page.locator('#story').innerText(), /OBSOLETE A GENERATION/);

      a.cursor = 'previous'; a.holdOlder = true; a.older = [{ kind: 'report', ts: 0, body: 'OLD A PAGE SECRET' }];
      await page.evaluate(() => story.refreshStory());
      await page.evaluate(() => { window.older = story.loadEarlierStory(); }); await waitHeld();
      await page.evaluate(() => mount('s_b'));
      held.shift()(); await page.evaluate(() => older);
      assert.doesNotMatch(await page.locator('#story').innerText(), /OLD A PAGE/);

      // A question's late answer completion must not mark B's coincidentally identical ask answered.
      const ask = { kind: 'ask', ts: 10, body: 'Which option?', options: [{ label: 'Continue', key: '1' }] };
      a.cursor = null; a.events = [ask]; a.holdInput = true; b.events = [ask];
      await page.evaluate(() => mount('s_a'));
      await page.locator('[data-story-ask-opt]').click(); await waitHeld();
      await page.evaluate(() => mount('s_b'));
      held.shift()();
      await page.evaluate(() => story.refreshStory());
      assert.equal(await page.locator('[data-story-ask-opt]').count(), 1, 'another session’s answer cannot retire the current prompt');
      assert.deepEqual(inputs.map(input => input.id), ['s_a'], 'only the explicitly clicked session receives fixture input');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine: engine.name(), width, pasteBubbles: 1, pendingAfterNativeReceipt: 0,
        cases: 'exact read receipts, fallback not read, wrong owner/cache, late initializer/echo, A-B-A, history and answer races', pass: true }));
    } finally { held.splice(0).forEach(release => release()); await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log('story_send_isolation_browser: passed');
