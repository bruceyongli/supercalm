import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const model = (id, provider, label, defaultEffort) => ({ id, provider, label, efforts, defaultEffort });
const tools = [
  { id: 'claude', label: 'Claude Code', model: 'claude-opus-5-5', defaultEffort: 'max', efforts,
    models: [model('opus', 'claude', 'Opus 5.5', 'max'), model('claude-opus-5-5', 'claude', 'Opus 5.5', 'max')] },
  { id: 'codex', label: 'Codex', model: 'gpt-6.1-sol', defaultEffort: 'xhigh', efforts,
    models: [model('gpt-6-sol', 'codex', 'GPT-6 Sol', 'xhigh'), model('gpt-6.1-sol', 'codex', 'GPT-6.1 Sol', 'xhigh')] },
];
const posts = [];
const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/aios/api/launch-options') return json(res, { tools, projects: [{ id: 'p_fixture', path: '/fixture/project', name: 'Fixture' }] });
  if (path === '/aios/api/phone/home') return json(res, { sessions: [], counts: {} });
  if (path === '/aios/api/session' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    posts.push(JSON.parse(body));
    return json(res, { error: 'Captured fixture launch; no agent started.' });
  }
  if (path.startsWith('/aios/api/')) return json(res, {});
  const name = path.replace(/^\/aios\/?/, '') || 'app.html';
  const file = normalize(join(root, name));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 820, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
    await page.route('https://fonts.**/*', route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/aios/?desktop=1`);
    const open = () => page.evaluate(async () => { const { openLaunch } = await import('/aios/shell.js'); await openLaunch(); });
    await open();
    assert.equal(await page.locator('#nl-model').inputValue(), 'claude-opus-5-5');
    assert.equal(await page.locator('#nl-effort').inputValue(), 'max');
    await page.locator('#nl-tool [data-tool="codex"]').click();
    assert.equal(await page.locator('#nl-model').inputValue(), 'gpt-6.1-sol');
    assert.equal(await page.locator('#nl-effort').inputValue(), 'xhigh', 'Claude max cannot leak into Codex');
    await page.locator('#nl-effort').selectOption('high');
    await page.locator('#nl-model').selectOption('gpt-6-sol');
    assert.equal(await page.locator('#nl-effort').inputValue(), 'high', 'manual choices remain available within the selected agent');
    await page.locator('#nl-tool [data-tool="claude"]').click();
    assert.equal(await page.locator('#nl-model').inputValue(), 'claude-opus-5-5');
    assert.equal(await page.locator('#nl-effort').inputValue(), 'max');
    await page.locator('#nl-tool [data-tool="codex"]').click();
    await page.locator('#nl-task').fill('Test launch defaults');
    const count = posts.length;
    await page.locator('#nl-go').click();
    await page.waitForFunction(() => document.querySelector('#nl-gate')?.textContent.includes('Captured fixture'));
    assert.equal(posts.length, count + 1);
    assert.equal(posts.at(-1).model, 'gpt-6.1-sol');
    assert.equal(posts.at(-1).effort, 'xhigh');
    await page.locator('#nl-cancel').click();
    await open();
    assert.equal(await page.locator('#nl-model').inputValue(), 'claude-opus-5-5', 'new modal gets fresh defaults');
    await page.locator('#nl-task').fill('Test Claude launch default');
    await page.locator('#nl-go').click();
    await page.waitForFunction(() => document.querySelector('#nl-gate')?.textContent.includes('Captured fixture'));
    assert.equal(posts.at(-1).model, 'claude-opus-5-5', 'launch pins the explicit discovered version');
    assert.equal(posts.at(-1).tool, 'claude');
    await page.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log('launch_defaults_browser: desktop/tablet/phone default resets, manual choices and captured launch payloads passed');
