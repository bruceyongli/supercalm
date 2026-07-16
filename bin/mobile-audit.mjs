#!/usr/bin/env node
// Mobile UI audit — drives the app in headless Chrome under PHONE emulation (viewport + touch + UA),
// walks every phone-relevant surface (SPA dashboard/session/system pages, the /phone companion, the
// agent panels sheet + dock), screenshots each step, and records per-step console errors + page
// exceptions. Output = <out>/<step>.png + <out>/report.json — feed the PNGs to a vision model with
// bin/ui-review.mjs for the actual design review. Read-only: taps only navigation/tabs, never sends
// input to a session. Companion to bin/spa-audit.mjs (same CDP plumbing, mobile instead of desktop).
//   node bin/mobile-audit.mjs [--base http://127.0.0.1:8793/aios/] [--sid s_xxx] [--out /tmp/mobile-audit]
//                             [--viewport 390x844x2]
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = (opt('base', 'http://127.0.0.1:8793/aios/')).replace(/\/?$/, '/');
const OUT = opt('out', '/tmp/mobile-audit');
let SID = opt('sid', '');
const [VW, VH, DPR] = opt('viewport', '390x844x2').split('x').map(Number);
const CHROME = process.env.AIOS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function pageWs(port) {
  const dl = Date.now() + 12000;
  while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { const pg = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (pg) return pg.webSocketDebuggerUrl; } } catch {} await delay(150); }
  throw new Error('devtools not ready');
}

// pick a neutral session for the session-page steps: prefer waiting, else working, else any
if (!SID) {
  try {
    const st = await (await fetch(new URL('api/state', BASE))).json();
    const ss = st.sessions || [];
    SID = (ss.find((s) => s.status === 'waiting') || ss.find((s) => s.status === 'working') || ss[0])?.id || '';
  } catch {}
}

await mkdir(OUT, { recursive: true });
const port = await freePort();
const profile = `/tmp/aios-mobile-audit-${port}`;
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--password-store=basic', '--mute-audio', `--remote-debugging-port=${port}`, `--window-size=${VW},${VH}`, 'about:blank'], { stdio: 'ignore' });
child.on('error', (e) => { console.error('chrome spawn error:', e.message); process.exit(2); });
const hardKill = setTimeout(() => child.kill('SIGKILL'), 180000);

const report = { base: BASE, sid: SID, viewport: `${VW}x${VH}@${DPR}`, at: new Date().toISOString(), steps: [] };
let step = null; // the step currently collecting console/exception noise

try {
  const ws = new WebSocket(await pageWs(port));
  let id = 1; const pending = new Map();
  const call = (method, params) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') step?.exceptions.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown').slice(0, 400));
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) step?.console.push(m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    else if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') step?.console.push(`[${m.params.entry.source}] ${m.params.entry.text}`.slice(0, 300));
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws error')), { once: true }); });
  await call('Page.enable'); await call('Runtime.enable').catch(() => {}); await call('Log.enable').catch(() => {});
  await call('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: DPR, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await call('Network.enable').catch(() => {});
  await call('Network.setUserAgentOverride', { userAgent: UA, platform: 'iPhone' }).catch(() => {});

  const evaluate = (expression) => call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value);
  async function shot(name) { const r = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
  async function run(name, note, fn, settleMs = 1800) {
    step = { name, note, console: [], exceptions: [] };
    let info = null;
    try { info = await fn(); } catch (e) { step.error = String(e.message || e); }
    await delay(settleMs);
    step.url = await evaluate('location.href').catch(() => '');
    if (info && typeof info === 'object') Object.assign(step, info);
    await shot(name).catch((e) => { step.error = (step.error ? step.error + '; ' : '') + 'shot: ' + e.message; });
    report.steps.push(step);
    console.log(`· ${name}${step.error ? '  ⚠ ' + step.error : ''}${step.exceptions.length ? `  ✖ ${step.exceptions.length} exception(s)` : ''}`);
    step = null;
  }
  const nav = (path) => call('Page.navigate', { url: new URL(path, BASE).href }).then(() => delay(1200));
  // taps go through el.click() — every control on these surfaces wires click handlers
  const tap = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { tapped: false, missing: ${JSON.stringify(sel)} }; el.click(); return { tapped: true }; })()`);

  // ---- SPA shell on a phone -----------------------------------------------------------------
  await run('spa-dashboard', 'SPA dashboard as a phone lands on /', () => nav('.'), 2600);
  await run('spa-dashboard-drawer', 'sidebar drawer via the ☰ button', () => tap('#dk-menu-btn'));
  await run('spa-dashboard-phone-pill', 'the “📱 phone view” pill — should reach the phone companion', async () => {
    await tap('.dk-drawer-backdrop');
    await delay(400);
    return tap('#dk-phone-toggle');
  }, 2600);

  // ---- phone companion ----------------------------------------------------------------------
  await run('phone-home', 'phone triage home (/phone)', () => nav('phone'), 2600);
  if (SID) {
    await run('phone-session', 'phone session view (#s/<sid>)', () => nav(`phone#s/${SID}`), 2600);
    await run('phone-panels-sheet', 'agent panels sheet (tap the status strip)', () => tap('#open-panels'), 2600);
    // walk every tab the host rendered (+ the gear) — each mounts a real panel module
    const tabs = (await evaluate(`[...document.querySelectorAll('#pn-host-tabs [data-tab]')].map((b) => b.dataset.tab)`)) || [];
    report.panelTabs = tabs;
    for (const t of tabs) await run(`phone-panel-${t}`, `panels sheet tab: ${t}`, () => tap(`#pn-host-tabs [data-tab="${t}"]`), 2400);
    await run('phone-composer', 'composer: tap the fake field → real textarea mounts', async () => { await tap('[data-close-sheet]'); await delay(400); return tap('#fake-field'); });
  }

  // ---- SPA session view on a phone (where a session tap actually lands) ----------------------
  if (SID) {
    await run('spa-session', 'SPA session view on a phone', () => nav(`session?id=${SID}`), 3200);
    const glyphs = (await evaluate(`[...document.querySelectorAll('.dock-glyphs [data-tab]')].map((b) => b.dataset.tab)`)) || [];
    report.dockGlyphs = glyphs;
    for (const g of glyphs.slice(0, 3)) await run(`spa-session-dock-${g}`, `agent dock drawer: ${g}`, () => tap(`.dock-glyphs [data-tab="${g}"]`), 2400);
    await run('spa-session-dock-gear', 'agent dock: the Agents manager (gear)', () => tap('.dock-gear'), 2400);
  }

  // ---- system pages on a phone ----------------------------------------------------------------
  for (const p of ['projects', 'decisions', 'records', 'usage', 'health', 'settings']) {
    await run(`spa-${p}`, `${p} page on a phone`, () => nav(p), 2200);
  }
  await run('auth', 'auth page (standalone) on a phone', () => nav('auth'), 2200);

  try { ws.close(); } catch {}
} catch (e) {
  console.error('mobile-audit error:', e.message);
  process.exitCode = 2;
} finally {
  clearTimeout(hardKill);
  child.kill('SIGKILL');
}

await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const bad = report.steps.filter((s) => s.error || s.exceptions.length || s.console.length);
console.log(`\n${report.steps.length} steps → ${OUT}  (${bad.length} with errors/console noise — see report.json)`);
for (const s of bad) console.log(`  ✖ ${s.name}: ${[s.error, ...s.exceptions.slice(0, 2), ...s.console.slice(0, 3)].filter(Boolean).join(' | ').slice(0, 300)}`);
