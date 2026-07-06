#!/usr/bin/env node
// Standalone headless-Chrome screenshot via CDP — self-contained UI verification that doesn't depend
// on the (flaky) chrome-devtools MCP. Same approach as src/agents/evidence.js cdpScreenshot.
//   node bin/shot.mjs <url> [out.png] [waitMs] [WxH]
import { spawn } from 'node:child_process';
import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [url, out = '/tmp/shot.png', waitMs = '4500', size = '1400,1700'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node bin/shot.mjs <url> [out.png] [waitMs] [W,H]');
  process.exit(1);
}
const CHROME = process.env.AIOS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function pageWs(port) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) {
        const pg = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pg) return pg.webSocketDebuggerUrl;
      }
    } catch {}
    await delay(150);
  }
  throw new Error('devtools endpoint not ready');
}

const port = await freePort();
const profile = `/tmp/aios-shot-${port}`;
// SHOT_GL=1 swaps the GPU-off flag for software-WebGL (SwiftShader via ANGLE) so headless can render
// three.js/WebGL canvases (e.g. the 3D session graph). Default keeps --disable-gpu for plain pages.
const gpuFlags = process.env.SHOT_GL
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--disable-gpu'];
const child = spawn(
  CHROME,
  ['--headless=new', ...gpuFlags, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--password-store=basic', '--mute-audio', `--remote-debugging-port=${port}`, `--window-size=${size}`, 'about:blank'],
  { stdio: 'ignore' }
);
child.on('error', (e) => {
  console.error('chrome spawn error:', e.message);
  process.exit(1);
});
const kill = setTimeout(() => child.kill('SIGKILL'), 40000);

try {
  const wsUrl = await pageWs(port);
  const ws = new WebSocket(wsUrl);
  let id = 1;
  let loaded = false;
  const pending = new Map();
  const call = (method, params) =>
    new Promise((res, rej) => {
      const i = id++;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message || 'cdp error')) : p.res(m.result);
    } else if (m.method === 'Page.loadEventFired') loaded = true;
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      console.error('PAGE EXCEPTION:', d?.exception?.description || d?.text || JSON.stringify(d));
    } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) {
      console.error('PAGE', m.params.type + ':', (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
  });
  await call('Page.enable');
  await call('Runtime.enable').catch(() => {});
  await call('Page.navigate', { url });
  const until = Date.now() + 8000;
  while (!loaded && Date.now() < until) await delay(100);
  await delay(Number(waitMs));
  // SHOT_EVAL: optional JS to run in the page before capture (e.g. click a button), then settle.
  if (process.env.SHOT_EVAL) {
    await call('Runtime.evaluate', { expression: process.env.SHOT_EVAL, awaitPromise: true }).catch((e) => console.error('eval:', e.message));
    await delay(Number(process.env.SHOT_EVAL_WAIT || 1600));
  }
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('wrote', out);
  try {
    ws.close();
  } catch {}
} finally {
  clearTimeout(kill);
  child.kill('SIGKILL');
}
