import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(root, 'web');
const outDir = join(root, 'test-results', 'attention-options');
mkdirSync(outDir, { recursive: true });

const now = Date.now();
const sessions = [
  { id: 's_opt', title: 'Configure release checks', project: 'aios', tool: 'codex', model: 'gpt-test', status: 'waiting', category: 'decision', summary: 'Choose the runtime and verification scope.', question: 'Choose the runtime and verification scope.', unread: 1, last_key: { id: 11, text: 'choices', ts: now }, last_activity: now },
  { id: 's_done', title: 'Completed migration', project: 'aios', tool: 'claude', model: 'claude-test', status: 'waiting', category: 'review', summary: 'Migration is done and verified.', question: 'Migration is done and verified.', unread: 1, last_key: { id: 12, text: 'done', ts: now - 1000 }, last_activity: now - 1000 },
  { id: 's_reply', title: 'Confirm deployment window', project: 'aios', tool: 'codex', model: 'gpt-test', status: 'waiting', category: 'action', summary: 'When should this deploy?', question: 'When should this deploy?', unread: 1, last_key: { id: 13, text: 'when', ts: now - 1500 }, last_activity: now - 1500 },
  { id: 's_noise', title: 'Reconcile and qualify the Supervisor candidate', project: 'aios', tool: 'claude', model: 'claude-test', status: 'waiting', category: 'review', summary: '✔ Port candidate stack onto current main ✔ Overlay evaluator tooling untracked … +23 completed ⏵⏵ bypass permissions on (shift+tab to cycle) install gh … new task? /clear to save 112.7k tokens', question: '✔ Port candidate stack onto current main ✔ Overlay evaluator tooling untracked … +23 completed ⏵⏵ bypass permissions on (shift+tab to cycle) install gh … new task? /clear to save 112.7k tokens', unread: 1, last_key: { id: 14, text: 'raw terminal footer', ts: now - 1800 }, last_activity: now - 1800 },
  { id: 's_work', title: 'Active implementation', project: 'aios', tool: 'codex', model: 'gpt-test', status: 'working', category: null, summary: 'Implementing the next slice.', question: null, unread: 0, last_key: null, last_activity: now - 2000 },
];
const stories = {
  s_opt: {
    events: [
      { kind: 'ask', ts: now, askId: 'prompt-1', title: 'Needs your decision — Runtime', body: 'Which runtime?', options: [{ label: 'Node.js', description: 'Use the existing built-in stack.' }, { label: 'Bun' }] },
      { kind: 'ask', ts: now, askId: 'prompt-1', title: 'Needs your decision — Checks', body: 'How much verification?', options: [{ label: 'Focused checks' }, { label: 'Full checks', description: 'Run every suite.' }] },
    ],
  },
  s_done: { events: [{ kind: 'report', ts: now - 900, body: 'Migration is done and verified.' }] },
};
const answerBodies = [];
const dismissBodies = [];
const inputBodies = [];
const uploadBodies = [];
let homeRequests = 0;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/aios/api/phone/home') {
    homeRequests++;
    return sendJson(res, { ok: true, sessions, counts: { waiting: 4, working: 1, live: 5 } });
  }
  if (path === '/aios/api/auth/status') return sendJson(res, { mode: 'cli' });
  if (path === '/aios/api/version') return sendJson(res, { version: 'test' });
  if (path === '/aios/api/launch-options') return sendJson(res, { projects: [], tools: [] });
  if (path === '/aios/api/usage/summary') return sendJson(res, {
    ok: true,
    totals: { events: 1, sessions: 1, total_tokens: 10, cached_input_tokens: 2, output_tokens: 1 },
    byModel: [{ name: 'test-model', total_tokens: 10 }],
    byProject: [{ name: 'test-project', total_tokens: 10 }],
    recent: [{ id: 1, ts: now, event_type: 'usage', model: 'test-model', project: 'test-project', total_tokens: 10, message: 'test event' }],
  });
  if (path === '/aios/api/usage/subscriptions') return sendJson(res, { ok: true, subscriptions: [] });
  if (path === '/aios/api/tools/versions') return sendJson(res, { tools: [{ installed: true }] });
  if (path === '/aios/api/models/providers') return sendJson(res, { providers: [{ id: 'test' }] });
  const story = path.match(/^\/aios\/api\/session\/([^/]+)\/story$/);
  if (story) return sendJson(res, { ok: true, ...(stories[story[1]] || { events: [] }), status: 'waiting' });
  const upload = path.match(/^\/aios\/api\/session\/([^/]+)\/upload$/);
  if (upload && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    uploadBodies.push({ sid: upload[1], ...body });
    return sendJson(res, {
      ok: true,
      attachment: {
        name: body.name,
        type: body.type,
        size: body.size,
        path: `/tmp/${body.name}`,
        format: 'TXT',
        isImage: false,
      },
    }, 201);
  }
  const detail = path.match(/^\/aios\/api\/session\/([^/]+)$/);
  if (detail) {
    const session = sessions.find((item) => item.id === detail[1]) || { id: detail[1], title: detail[1], tool: 'codex', status: 'waiting' };
    return sendJson(res, {
      ...session,
      project: { id: 'p_aios', name: 'aios' },
      autonomy: 'full',
      effort: 'xhigh',
      orchestration: 'off',
      messages: [],
      events: [],
    });
  }
  const answers = path.match(/^\/aios\/api\/session\/([^/]+)\/answers$/);
  if (answers && req.method === 'POST') {
    answerBodies.push(JSON.parse(await readBody(req)));
    return sendJson(res, { ok: true });
  }
  const input = path.match(/^\/aios\/api\/session\/([^/]+)\/input$/);
  if (input && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    inputBodies.push({ sid: input[1], ...body });
    if (body.text === 'Send this Story request.' && body.replace_pending !== true) {
      return sendJson(res, {
        error: 'Terminal has a different unfinished draft. Your Story message was kept.',
        busy: true,
        reason: 'pending-draft',
        pendingDraft: 'Preserve this unfinished Terminal draft.',
      }, 409);
    }
    return sendJson(res, { ok: true });
  }
  if (path === '/aios/api/transcribe' && req.method === 'POST') return sendJson(res, { error: 'forced transcription failure' }, 503);
  if (path === '/aios/api/messages/read' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    dismissBodies.push(body);
    const session = sessions.find((item) => item.id === body.session_id);
    const dismissedAt = Date.now();
    if (body.dismiss && session) Object.assign(session, {
      unread: 0,
      dismissed: true,
      dismissed_at: dismissedAt,
      dismissed_report_id: body.through_id,
      dismissed_report_text: session.question,
    });
    return sendJson(res, {
      ok: true,
      marked: 1,
      unread: 0,
      ...(body.dismiss ? { dismissal: { dismissed: true, dismissed_at: dismissedAt, report_id: body.through_id, report_text: session?.question || '' } } : {}),
    });
  }
  const restore = path.match(/^\/aios\/api\/attention\/([^/]+)\/restore$/);
  if (restore && req.method === 'POST') {
    const session = sessions.find((item) => item.id === restore[1]);
    if (session) Object.assign(session, {
      unread: 1,
      dismissed: false,
      dismissed_at: null,
      dismissed_report_id: null,
      dismissed_report_text: null,
    });
    return sendJson(res, { ok: true, restored: true, reopened: true, unread: 1 });
  }
  if (path.startsWith('/aios/api/')) return sendJson(res, {});

  let relative = path.replace(/^\/aios\/?/, '') || 'app.html';
  if (relative === 'phone') relative = 'phone.html';
  if (!extname(relative)) relative = 'app.html';
  const file = normalize(join(webRoot, relative));
  if (!file.startsWith(webRoot)) { res.writeHead(403); res.end(); return; }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/aios/`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-dk-card][data-sid="s_opt"] .dk-card-questions').waitFor();
  assert.equal(await page.locator('#dk-on-the-go').getAttribute('aria-pressed'), 'false',
    'Needs You exposes an explicit opt-in on-the-go assistant switch');

  const optionCard = page.locator('[data-dk-card][data-sid="s_opt"]');
  assert.match(await optionCard.locator('.dk-card-title').innerText(), /Configure release checks/);
  assert.equal(await optionCard.locator('.dk-card-next').count(), 0,
    'structured choices are the action; the card does not repeat an Action needed box above them');
  const doneCardInitial = page.locator('[data-dk-card][data-sid="s_done"]');
  assert.match(await doneCardInitial.locator('.dk-card-outcome').innerText(), /Migration is done and verified/);
  assert.equal(await doneCardInitial.locator('.dk-card-next').count(), 0,
    'a completed review uses its Review result / Request changes controls instead of generic instructional copy');
  assert.equal((await doneCardInitial.innerText()).match(/Migration is done and verified/g)?.length, 1,
    'a duplicated review report appears only once');
  assert.deepEqual(await doneCardInitial.locator('.dk-card-actions').getByRole('link').allTextContents(), ['Review result']);
  assert.deepEqual(await doneCardInitial.locator('.dk-card-actions').getByRole('button').allTextContents(), ['Request changes', 'Dismiss']);
  const noiseCard = page.locator('[data-dk-card][data-sid="s_noise"]');
  assert.match(await noiseCard.locator('.dk-card-outcome').innerText(), /Completed 25 items/i);
  assert.doesNotMatch(await noiseCard.innerText(), /bypass permissions|new task|tokens/i,
    'raw TUI controls never reach the high-attention card');
  assert.ok((await doneCardInitial.boundingBox()).height < 180,
    'a normal Needs You item stays compact enough to scan several at once');
  await page.locator('#dk-cmdk-row').click();
  await page.locator('#dk-palette-q').fill('Configure release');
  await page.locator('.dk-pal-preview-row.important').waitFor();
  assert.match(await page.locator('.dk-pal-preview').innerText(), /Request[\s\S]*Configure release checks[\s\S]*Action needed/i,
    '⌘K exposes the same request/action brief before navigation');
  await page.screenshot({ path: join(outDir, 'command-preview.png') });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(outDir, 'needs-you-options.png'), fullPage: true });
  const homeRequestsBeforeRefresh = homeRequests;
  const refreshResponse = page.waitForResponse((response) => response.url().endsWith('/api/phone/home'));
  await page.locator('#dk-needs-refresh').click();
  await refreshResponse;
  await page.waitForFunction(() => document.querySelector('#dk-needs-refresh')?.textContent.trim() === '↻ Refresh');
  assert.equal(homeRequests, homeRequestsBeforeRefresh + 1, 'desktop Refresh fetches the authoritative Needs-you projection');
  assert.equal(await optionCard.locator('[data-dk-question]').count(), 2, 'Needs you renders every structured question');
  assert.deepEqual(await optionCard.locator('[data-dk-choice]').allTextContents().then((items) => items.map((item) => item.replace(/\s+/g, ' ').trim())), [
    'Node.jsUse the existing built-in stack.', 'Bun', 'Focused checks', 'Full checksRun every suite.',
  ]);

  const initialOrder = await page.locator('[data-dk-sessions] [data-dk-sess]').evaluateAll((rows) => rows.map((row) => row.dataset.sid));
  await page.evaluate(async () => {
    const shell = await import('./shell.js');
    shell.upsertSession({ id: 's_work', last_activity: Date.now() + 60000 });
  });
  assert.deepEqual(await page.locator('[data-dk-sessions] [data-dk-sess]').evaluateAll((rows) => rows.map((row) => row.dataset.sid)), initialOrder,
    'activity updates do not reshuffle the sidebar');

  const workingDot = page.locator('[data-dk-sess][data-sid="s_work"] .dk-dot');
  const dotStyle = await workingDot.evaluate((dot) => {
    const style = getComputedStyle(dot);
    return { width: style.width, height: style.height, radius: style.borderRadius, duration: style.animationDuration };
  });
  assert.deepEqual(dotStyle, { width: '7px', height: '7px', radius: '50%', duration: '2.8s' }, 'working indicator stays round and blinks slowly');
  await workingDot.evaluate((dot) => { window.__workingStatusDot = dot; });
  await page.evaluate(async () => {
    const shell = await import('./shell.js');
    shell.upsertSession({ id: 's_work', summary: 'A new progress update', last_activity: Date.now() + 120000 });
  });
  assert.equal(await page.evaluate(() => window.__workingStatusDot === document.querySelector('[data-dk-sess][data-sid="s_work"] .dk-dot')), true,
    'activity and summary updates preserve the live dot node so its animation timeline does not restart');

  await optionCard.getByRole('button', { name: /Node\.js/ }).click();
  assert.equal(answerBodies.length, 0, 'the first of multiple questions does not prematurely resume the session');
  await optionCard.getByRole('button', { name: /Full checks/ }).click();
  await optionCard.waitFor({ state: 'detached' });
  assert.equal(answerBodies.length, 1, 'the last required selection submits one complete response');
  assert.deepEqual(answerBodies[0].answers.map((answer) => answer.values[0].label), ['Node.js', 'Full checks']);

  const replyCard = page.locator('[data-dk-card][data-sid="s_reply"]');
  await replyCard.getByRole('button', { name: 'Reply' }).click();
  await replyCard.locator('textarea').fill('Deploy now');
  await replyCard.locator('[data-dk-send]').click();
  await replyCard.waitFor({ state: 'detached' });
  assert.deepEqual(inputBodies[0], { sid: 's_reply', text: 'Deploy now', source: 'text' },
    'a successful text reply immediately removes the answered item from Needs you');

  const doneCard = page.locator('[data-dk-card][data-sid="s_done"]');
  await doneCard.getByRole('button', { name: 'Dismiss' }).click();
  await doneCard.waitFor({ state: 'detached' });
  const dismissal = dismissBodies.find((body) => body.session_id === 's_done');
  assert.equal(dismissal?.session_id, 's_done');
  assert.equal(dismissal?.dismiss, true, 'Dismiss is persisted as an explicit attention decision');
  assert.equal(dismissal?.through_id, 12, 'dismissal is bounded to the visible report');
  assert.equal(await page.locator('[data-dk-row][data-sid="s_done"]').count(), 1, 'dismissal leaves the session itself in the list');
  await page.locator('#dk-dismissed-toggle').click();
  assert.equal(await page.locator('[data-dk-dismissed-row][data-sid="s_done"]').count(), 1, 'desktop archives the handled report in Dismissed');
  await page.screenshot({ path: join(outDir, 'dismissed-section.png'), fullPage: true });
  await page.close();

  for (const relative of ['usage']) {
    const usage = await browser.newPage({ viewport: { width: 1320, height: 900 } });
    await usage.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await usage.goto(base + relative, { waitUntil: 'domcontentloaded' });
    const recent = usage.locator('#recent');
    const toggle = usage.locator('#recent-toggle');
    await recent.waitFor({ state: 'attached' });
    await usage.waitForFunction(() => document.querySelector('#recent')?.children.length > 0);
    assert.equal(await recent.getAttribute('hidden'), '', `${relative}: recent events start closed`);
    assert.equal(await recent.evaluate((el) => getComputedStyle(el).display), 'none', `${relative}: hidden disclosure has no layout`);
    await toggle.click();
    assert.equal(await recent.getAttribute('hidden'), null, `${relative}: toggle removes the hidden attribute`);
    assert.equal(await recent.evaluate((el) => getComputedStyle(el).display), 'grid', `${relative}: open disclosure renders its rows`);
    await toggle.click();
    assert.equal(await recent.evaluate((el) => getComputedStyle(el).display), 'none', `${relative}: closing the disclosure removes it from layout`);
    await usage.close();
  }

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript(() => {
    window.__voiceAlerts = [];
    window.alert = (message) => window.__voiceAlerts.push(String(message));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getSupportedConstraints: () => ({}),
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      },
    });
    class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'audio/webm';
        this.state = 'inactive';
      }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(2400)], { type: this.mimeType }) });
        queueMicrotask(() => this.onstop?.());
      }
    }
    window.MediaRecorder = FakeMediaRecorder;
  });
  await phone.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await phone.goto(base, { waitUntil: 'domcontentloaded' });
  await phone.waitForFunction(() => location.pathname === '/aios/phone' && location.hash === '#home');
  assert.match(phone.url(), /\/aios\/phone#home$/, 'the canonical app defaults to phone home at iPhone width');
  await phone.locator('.needcard[data-open="s_opt"] .needqs').waitFor();
  const onTheGoButton = phone.locator('#on-the-go-mode');
  assert.equal(await onTheGoButton.getAttribute('aria-pressed'), 'false', 'phone companion exposes the same opt-in assistant');
  const onTheGoBox = await onTheGoButton.boundingBox();
  assert.ok(onTheGoBox && onTheGoBox.x >= 0 && onTheGoBox.x + onTheGoBox.width <= 390,
    'the on-the-go switch stays inside the iPhone viewport');
  assert.equal(await phone.locator('.needcard[data-open="s_done"]').count(), 0, 'a second device respects the server-side dismissal');
  await phone.locator('#toggle-dismissed').click();
  assert.equal(await phone.locator('.ph-dismissed-row[data-open="s_done"]').count(), 1, 'the second device can find the dismissed session');
  await phone.screenshot({ path: join(outDir, 'phone-dismissed-section.png'), fullPage: true });
  await phone.locator('[data-restore-attention="s_done"]').click();
  await phone.locator('.needcard[data-open="s_done"]').waitFor();
  const restoredPhoneCard = phone.locator('.needcard[data-open="s_done"]');
  assert.match(await restoredPhoneCard.locator('.needrequest').innerText(), /Completed migration/);
  assert.match(await restoredPhoneCard.locator('.needoutcome').innerText(), /Migration is done and verified/);
  assert.equal(await restoredPhoneCard.locator('.neednext').count(), 0,
    'phone also avoids repeating default review instructions');
  assert.equal((await restoredPhoneCard.innerText()).match(/Migration is done and verified/g)?.length, 1,
    'phone also collapses a duplicated review report');
  assert.deepEqual(await restoredPhoneCard.locator('.needacts button').allTextContents(), ['▶ Listen', 'Review result', 'Dismiss']);
  await phone.screenshot({ path: join(outDir, 'phone-needs-you-options.png'), fullPage: true });
  const phoneRequestsBeforeRefresh = homeRequests;
  const phoneRefreshResponse = phone.waitForResponse((response) => response.url().endsWith('/api/phone/home'));
  await phone.locator('#refresh-needs').click();
  await phoneRefreshResponse;
  assert.equal(homeRequests, phoneRequestsBeforeRefresh + 1, 'phone Refresh fetches the authoritative Needs-you projection');
  assert.equal(await phone.locator('.needcard[data-open="s_opt"] .needq').count(), 2, 'phone Needs you renders the complete option prompt');
  const [cardBox, actionsBox] = await Promise.all([
    phone.locator('.needcard[data-open="s_opt"]').boundingBox(),
    phone.locator('.needcard[data-open="s_opt"] .needacts').boundingBox(),
  ]);
  assert.ok(cardBox && actionsBox && actionsBox.x >= cardBox.x && actionsBox.x + actionsBox.width <= cardBox.x + cardBox.width,
    'phone option-card actions stay inside the card');
  await restoredPhoneCard.locator('.needrequest').click();
  await phone.waitForFunction(() => location.pathname === '/aios/session' && new URLSearchParams(location.search).get('from') === 'phone');
  assert.equal(new URL(phone.url()).pathname, '/aios/session', 'a phone card opens the canonical session route');
  await phone.locator('[data-mode="story"]').waitFor();
  assert.equal(await phone.locator('[data-mode="terminal"]').count(), 1,
    'the phone uses the same Story and Terminal workspace as every other device');
  assert.equal(await phone.locator('#attach').count(), 1, 'the shared mobile composer exposes attachment upload');
  assert.equal(await phone.locator('#mic').count(), 1, 'the shared mobile composer exposes dictation');
  await phone.screenshot({ path: join(outDir, 'phone-shared-session.png'), fullPage: true });
  await phone.locator('#file-input').setInputFiles({
    name: 'phone-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('attachment from the phone'),
  });
  await phone.locator('.attachment-chip.ready').waitFor();
  assert.equal(uploadBodies.at(-1)?.sid, 's_done', 'the phone uploads through the shared session attachment route');

  await phone.locator('#reply').fill('Keep this typed draft exactly.');
  await phone.locator('#mic').click();
  await phone.waitForFunction(() => document.querySelector('#mic')?.classList.contains('rec'));
  await phone.waitForTimeout(450);
  await phone.locator('#mic').click();
  await phone.waitForFunction(() => window.__voiceAlerts.some((message) => message.includes('Transcription failed')));
  assert.equal(await phone.locator('#reply').inputValue(), 'Keep this typed draft exactly.',
    'failed phone dictation restores the exact pre-recording draft');

  const longPhoneReply = 'Please keep this response attached to the current session. '.repeat(120);
  await phone.locator('#reply').fill(longPhoneReply);
  const [fieldBox, sendBox] = await Promise.all([
    phone.locator('#reply').boundingBox(),
    phone.locator('#send').boundingBox(),
  ]);
  assert.ok(fieldBox && fieldBox.height <= 180, 'a long phone reply scrolls inside a bounded editor');
  assert.ok(sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= 844,
    'Send remains reachable with a long reply');
  await phone.locator('#send').click();
  await phone.waitForFunction(() => document.querySelector('#reply')?.value === '');
  assert.equal(inputBodies.at(-1)?.sid, 's_done', 'the visible Send delivers the long reply to the current session');
  assert.equal(inputBodies.at(-1)?.attachments?.length, 1, 'the same send includes the uploaded phone attachment');
  await phone.locator('#reply').fill('Send this Story request.');
  await phone.locator('#send').click();
  await phone.waitForFunction(() => document.querySelector('#reply')?.value === 'Preserve this unfinished Terminal draft.');
  assert.deepEqual(inputBodies.slice(-2).map((body) => ({ text: body.text, replace: body.replace_pending })), [
    { text: 'Send this Story request.', replace: false },
    { text: 'Send this Story request.', replace: true },
  ], 'Story automatically retries through a different unfinished Terminal draft');
  assert.match(await phone.locator('#composer-notice').innerText(), /kept the unfinished Terminal draft here/i,
    'the composer reports the accurate unified-draft outcome instead of claiming the session is resuming');
  await phone.screenshot({ path: join(outDir, 'phone-story-terminal-draft.png'), fullPage: true });
  assert.equal(await phone.locator('#reply').inputValue(), 'Preserve this unfinished Terminal draft.',
    'the displaced Terminal draft moves into the visible Story composer instead of becoming phone-inaccessible history');
  await phone.locator('#reply').fill('');
  await phone.locator('.brand a').click();
  await phone.waitForFunction(() => location.pathname === '/aios/phone' && location.hash === '#home');
  assert.equal(new URL(phone.url()).pathname, '/aios/phone', 'the canonical session Back returns to phone home');
  const phoneVersion = phone.locator('.ph-app-foot [data-aios-update]');
  await phone.waitForFunction(() => document.querySelector('.ph-app-foot [data-aios-version]')?.textContent === 'vtest');
  await phoneVersion.click();
  const phoneUpdateSheet = phone.locator('#aios-update-control .auc-sheet');
  await phoneUpdateSheet.waitFor();
  const phoneUpdateBox = await phoneUpdateSheet.boundingBox();
  assert.ok(phoneUpdateBox && Math.abs(phoneUpdateBox.y + phoneUpdateBox.height - 844) < 2,
    'the phone footer version opens the PWA refresh bottom sheet');
  await phone.screenshot({ path: join(outDir, 'phone-pwa-update.png'), fullPage: true });
  await phone.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('ui_attention_options_browser.test ok');
