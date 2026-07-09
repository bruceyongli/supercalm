#!/usr/bin/env node
// UI lab — usage-state probes against the LIVE panel (docs/improve/supervisor-lab.md, usage layer).
// Born 2026-07-09: the supervisor lab proved brain decisions while the operator caught two USAGE
// issues it could never see (a task card that silently stopped updating; an ugly no-task state).
// This lab renders real screens headless, asserts DOM invariants per UI state, saves screenshot
// artifacts, and (optionally) has a vision model grade visual coherence. `npm run ui-lab [filter]`.
// Read-only: it never mutates sessions — it renders and probes.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.AIOS_UI_LAB_BASE || 'http://127.0.0.1:8793';
const CHROME = process.env.AIOS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VISION = process.env.AIOS_UI_LAB_VISION !== '0';
const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const OUT = join(process.cwd(), 'data', 'ui-lab');
mkdirSync(OUT, { recursive: true });

// ---- scenario table: url + DOM probes (each probe is a JS expr that must be truthy) ----------------
// Sessions are discovered live so the lab keeps working as sessions come and go.
async function discover() {
  const state = await (await fetch(`${BASE}/api/state`)).json();
  const sessions = state.sessions || [];
  const withCard = [];
  const between = [];
  for (const s of sessions.slice(0, 12)) {
    try {
      const t = await (await fetch(`${BASE}/api/session/${s.id}/tasks`)).json();
      if (!t?.ok) continue;
      if (t.active) withCard.push(s.id);
      else if (t.lastClosed || (t.archived || []).length) between.push(s.id);
    } catch {}
  }
  return { withCard: withCard[0], between: between[0] };
}

const PROBES = {
  'between-tasks-state': (sid) => ({
    url: `${BASE}/session?id=${sid}&desktop=1&sideTab=supervisor`,
    probes: [
      ["one merged empty-state block", "!!document.querySelector('#sup-doc .pm-between')"],
      ["no redundant second empty box", "!document.querySelector('#sup-doc .sup-empty-doc')"],
      ["start-next-task CTA present", "!!document.querySelector('#pm-new-between')"],
      ["card shell headline (not the legacy doc view)", "document.querySelector('#sup-doc h2')?.textContent.includes('Task card')"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
  'active-card-state': (sid) => ({
    url: `${BASE}/session?id=${sid}&desktop=1&sideTab=supervisor`,
    probes: [
      ["active card renders", "!!document.querySelector('#sup-doc .pm-card')"],
      ["card actions present", "!!document.querySelector('[data-pm-edit=done]') && !!document.querySelector('[data-pm-edit=crit]')"],
      ["no between-state while a card is active", "!document.querySelector('#sup-doc .pm-between')"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
};

// ---- minimal CDP client (same approach as bin/shot.mjs, plus Runtime.evaluate) ---------------------
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function withPage(fn) {
  const port = await freePort();
  const prof = join(OUT, `.chrome-${port}`);
  const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--headless=new', '--no-first-run', '--window-size=1400,1700', 'about:blank'], { stdio: 'ignore' });
  try {
    let ws = null;
    for (let i = 0; i < 40 && !ws; i++) {
      await delay(250);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        ws = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl || null;
      } catch {}
    }
    if (!ws) throw new Error('chrome did not expose a page target');
    const sock = new WebSocket(ws);
    await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws failed')); });
    let seq = 0;
    const pending = new Map();
    sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const cdp = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
      sock.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' timeout')); } }, 20000);
    });
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    return await fn({
      goto: async (url) => {
        // console-error collector must exist before app scripts run
        await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__uiLabErrors=[];window.addEventListener("error",e=>__uiLabErrors.push(String(e.message)));window.addEventListener("unhandledrejection",e=>__uiLabErrors.push("rejection:"+String(e.reason)));' });
        await cdp('Page.navigate', { url });
        await delay(5500); // panel mount + tasks fetch + SSE settle
      },
      eval: async (expr) => {
        const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
        return r.result?.value;
      },
      shot: async (file) => {
        const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(file, Buffer.from(r.data, 'base64'));
        return r.data;
      },
    });
  } finally {
    chrome.kill('SIGKILL');
  }
}

// ---- optional vision grade --------------------------------------------------------------------------
async function visionGrade(b64, label) {
  try {
    const { routeForModel } = await import('../src/model_catalog.js');
    const { callProxyModel, isVisionRoute } = await import('../src/agents/model.js');
    const route = routeForModel(process.env.AIOS_UI_LAB_VISION_MODEL || 'gpt-5.5');
    if (!isVisionRoute(route)) return null;
    const out = await callProxyModel(route, [
      { role: 'system', content: 'You review one screenshot of a dark-mode developer tool panel. Return STRICT JSON {"coherent":true|false,"issues":["<specific visual/usage problems: overflow, misalignment, unreadable contrast, redundant/confusing blocks, broken layout>"]}. Judge visual quality and usage clarity, not feature choices. Empty issues array if clean.' },
      { role: 'user', content: [{ type: 'text', text: `UI state: ${label}` }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] },
    ], { json: true, maxTokens: 400 });
    const m = String(out.content || '').match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return { coherent: null, issues: [`vision grade unavailable: ${String(e.message).slice(0, 80)}`] };
  }
}

// ---- run ---------------------------------------------------------------------------------------------
const { withCard, between } = await discover();
const plan = [];
if (between) plan.push(['between-tasks-state', between]);
if (withCard) plan.push(['active-card-state', withCard]);
if (!plan.length) { console.error('no suitable sessions found to probe'); process.exit(1); }

const results = [];
for (const [name, sid] of plan) {
  if (ONLY && !ONLY.test(name)) continue;
  const { url, probes } = PROBES[name](sid);
  await withPage(async (page) => {
    await page.goto(url);
    const fails = [];
    for (const [label, expr] of probes) {
      let v = null;
      try { v = await page.eval(expr); } catch (e) { v = `eval error: ${e.message}`; }
      if (v !== true) fails.push(`${label} -> ${JSON.stringify(v)}`);
    }
    const file = join(OUT, `${name}-${sid}.png`);
    const b64 = await page.shot(file);
    let vision = null;
    if (VISION) vision = await visionGrade(b64, name);
    const visualIssues = vision && vision.coherent === false ? vision.issues || [] : [];
    results.push({ name, sid, ok: !fails.length && !visualIssues.length, fails, vision, file });
    console.log(`${!fails.length && !visualIssues.length ? '✓' : '✗'} ${name} (${sid})${fails.length ? ' — ' + fails.join('; ') : ''}${visualIssues.length ? ' — vision: ' + visualIssues.join('; ') : ''}${vision?.issues?.length && vision.coherent !== false ? `  [vision notes: ${vision.issues.join('; ')}]` : ''}`);
  });
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} UI states green`);
writeFileSync(join(OUT, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`), `# UI lab report\n\n${results.map((r) => `## ${r.ok ? '✓' : '✗'} ${r.name} (${r.sid})\n${r.fails.map((f) => `- ${f}`).join('\n')}\n${r.vision ? `vision: ${JSON.stringify(r.vision)}` : ''}\nartifact: ${r.file}\n`).join('\n')}\n`);
process.exit(pass === results.length ? 0 : 1);
