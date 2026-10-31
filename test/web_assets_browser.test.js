import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { createWebAssets } from '../src/web_assets.js';

const webDir = fileURLToPath(new URL('../web', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'aios-browser-cache-'));
const assets = createWebAssets({ webDir, cacheDir: root });
const current = await assets.current();
let immutableRequests = 0, homeRequests = 0, delayMs = 0;
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname.replace(/^\/aios/, '') || '/';
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (p === '/cache-gap') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); return res.end('<!doctype html><title>Between app visits</title>'); }
    if (p.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (p === '/api/phone/home') homeRequests++;
      if (p === '/api/events') { res.writeHead(204); return res.end(); }
      return res.end(JSON.stringify({ ok: true, sessions: [], counts: {}, projects: [], tools: [], defaults: {},
        version: '0.0.1', channel: 'every', flags: {}, groups: [], host: {}, capacity: {} }));
    }
    if (p.startsWith('/assets/')) {
      immutableRequests++;
      const asset = await assets.get(p);
      if (!asset) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { ...asset.headers, 'content-type': types[asset.ext] || 'application/octet-stream' });
      return res.end(asset.body);
    }
    const path = p === '/' ? '/app.html' : p === '/phone' ? '/phone.html' : p;
    let body = await readFile(join(webDir, path));
    if (path.endsWith('.html')) {
      // No external network in a deterministic local performance regression. Font non-blocking
      // markup is covered separately by the HTML test; this measures our app assets only.
      body = await assets.html(body.toString().replace(/<link\b[^>]*https:\/\/fonts\.[^>]+>/g, ''));
    }
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/aios/`;
try {
  for (const [name, engine, width] of [['desktop', chromium, 1280], ['iphone', webkit, 390], ['ipad', webkit, 820]]) {
    // PWA/reopen caching needs a persistent profile. WebKit's ephemeral/private context does not
    // retain its HTTP disk cache across documents; it is not the installed-app storage model.
    const browser = await engine.launchPersistentContext(join(root, 'profile-' + name), {
      headless: true, viewport: { width, height: 1000 }, ...(width < 1000 ? { isMobile: true, hasTouch: true } : {}),
    });
    try {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      delayMs = 100;
      const before = immutableRequests, beforeHome = homeRequests, start = Date.now();
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.body.textContent.includes('Supercalm'));
      const coldMs = Date.now() - start, cold = immutableRequests - before;
      assert.ok(cold >= 15, 'real application module graph loads');
      assert.ok(homeRequests > beforeHome, 'home is fetched from the server');
      await page.goto(base + 'cache-gap');
      const second = immutableRequests, secondHome = homeRequests, warmStart = Date.now();
      await page.goto(base, { waitUntil: 'networkidle' });
      assert.equal(immutableRequests - second, 0, 'repeat open uses browser cache for every versioned asset');
      assert.ok(homeRequests > secondHome, 'session state is still live, never cached with code');
      assert.deepEqual(errors, [], 'no module identity/cycle errors');
      const urls = await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name));
      assert.ok(urls.some(url => url.includes(`/assets/${current.id}/`)));
      console.log(JSON.stringify({ device: name, width, simulatedRequestDelayMs: delayMs, coldAssetRequests: cold,
        warmAssetRequests: immutableRequests - second, coldMs, warmMs: Date.now() - warmStart, freshHome: true }));
      await page.close();
    } finally { await browser.close(); }
  }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
console.log('web_assets_browser: desktop/iPhone/iPad real modules, warm cache and fresh session data passed');
