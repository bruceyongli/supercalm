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
  { id: 's_work', title: 'Active implementation', project: 'aios', tool: 'codex', model: 'gpt-test', status: 'working', category: null, summary: 'Implementing the next slice.', question: null, unread: 0, last_key: null, last_activity: now - 2000 },
];
const stories = {
  s_opt: {
    events: [
      { kind: 'ask', ts: now, askId: 'prompt-1', title: 'Needs your decision — Runtime', body: 'Which runtime?', options: [{ label: 'Node.js', description: 'Use the existing built-in stack.' }, { label: 'Bun' }] },
      { kind: 'ask', ts: now, askId: 'prompt-1', title: 'Needs your decision — Checks', body: 'How much verification?', options: [{ label: 'Focused checks' }, { label: 'Full checks', description: 'Run every suite.' }] },
    ],
  },
  s_done: { events: [] },
};
const answerBodies = [];
const dismissBodies = [];
const inputBodies = [];
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
    return sendJson(res, { ok: true, sessions, counts: { waiting: 3, working: 1, live: 4 } });
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
  const answers = path.match(/^\/aios\/api\/session\/([^/]+)\/answers$/);
  if (answers && req.method === 'POST') {
    answerBodies.push(JSON.parse(await readBody(req)));
    return sendJson(res, { ok: true });
  }
  const input = path.match(/^\/aios\/api\/session\/([^/]+)\/input$/);
  if (input && req.method === 'POST') {
    inputBodies.push({ sid: input[1], ...JSON.parse(await readBody(req)) });
    return sendJson(res, { ok: true });
  }
  if (path === '/aios/api/messages/read' && req.method === 'POST') {
    dismissBodies.push(JSON.parse(await readBody(req)));
    return sendJson(res, { ok: true, marked: 1, unread: 0 });
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

  const optionCard = page.locator('[data-dk-card][data-sid="s_opt"]');
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
  assert.equal(dismissal?.through_id, 12, 'dismissal is bounded to the visible report');
  assert.equal(await page.locator('[data-dk-row][data-sid="s_done"]').count(), 1, 'dismissal leaves the session itself in the list');
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
  await phone.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await phone.goto(base + 'phone', { waitUntil: 'domcontentloaded' });
  await phone.locator('.needcard[data-open="s_opt"] .needqs').waitFor();
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
  await phone.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('ui_attention_options_browser.test ok');
