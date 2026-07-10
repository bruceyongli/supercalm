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
  // Desktop shell (design handoff phase 2, slice 1): sidebar + inbox + palette render and behave.
  // Onboarding wizard: welcome renders with real detection; Get started reveals the step rail
  // with required-gate steps; step 1 lists real CLI scan rows.
  'onboarding-wizard': () => ({
    url: `${BASE}/onboarding`,
    actions: async (page) => {
      await page.eval("document.querySelector('[data-ob-go]')?.click()");
      await new Promise((r) => setTimeout(r, 1200));
    },
    probes: [
      ["step rail visible after Get started", "!document.querySelector('[data-ob-rail]')?.hidden"],
      ["four steps in the rail", "document.querySelectorAll('[data-ob-step]').length === 4"],
      ["agents step lists detected CLIs", "document.querySelectorAll('.ob-row b').length >= 2"],
      ["gate note or continue present", "!!document.querySelector('[data-ob-next]')"],
      ["credentialed installs get the start-now shortcut", "!document.querySelector('[data-ob-finish]')?.hidden || !!document.querySelector('[data-ob-finish]')"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
  // Settings: sticky sub-nav + five sections, all populated from real endpoints.
  // Redesign skin on the operator-critical SYSTEM pages: tokens applied, logic untouched,
  // approval controls still present and functional-looking, zero console errors.
  'system-pages-skin': () => ({
    url: `${BASE}/decisions`,
    actions: async () => { await new Promise((r) => setTimeout(r, 2500)); },
    probes: [
      ["skin stylesheet applied", "[...document.styleSheets].some(ss => (ss.href||'').includes('redesign-skin'))"],
      ["page background is bg/app token", "getComputedStyle(document.body).backgroundColor === 'rgb(10, 14, 20)'"],
      ["doctrine rule cards render", "document.body.textContent.includes('WHEN') || document.querySelectorAll('.card, .su-card').length > 0"],
      ["approve controls still present", "[...document.querySelectorAll('button')].some(b => /approve/i.test(b.textContent))"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
  'records-page': () => ({
    url: `${BASE}/records`,
    actions: async () => { await new Promise((r) => setTimeout(r, 2200)); },
    probes: [
      ["filter card renders", "!!document.querySelector('[data-rc-filter]') && !!document.querySelector('#rc-q')"],
      ["record cards populate", "document.querySelectorAll('[data-rc-card]').length >= 5"],
      ["session links present", "!!document.querySelector('[data-rc-card] a[href^=\"session\"]')"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
  'projects-page': () => ({
    url: `${BASE}/projects`,
    actions: async () => { await new Promise((r) => setTimeout(r, 2500)); },
    probes: [
      ["project rows render", "document.querySelectorAll('[data-pj-row]').length >= 2"],
      ["graph chips present", "/graph ready|not indexed/.test(document.querySelector('#pj-list')?.textContent || '')"],
      ["index + session actions per row", "!!document.querySelector('[data-pj-index]') && !!document.querySelector('[data-pj-launch]')"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
  'settings-page': () => ({
    url: `${BASE}/settings`,
    actions: async (page) => { await new Promise((r) => setTimeout(r, 2500)); },
    probes: [
      ["five sub-nav sections", "document.querySelectorAll('[data-st-nav] a').length === 5"],
      ["auth path card populated", "/Session auth path/.test(document.querySelector('#st-authpath')?.textContent || '')"],
      ["per-CLI rows present", "document.querySelectorAll('#st-clis .ob-row').length >= 2"],
      ["providers section populated", "!/loading/.test(document.querySelector('#st-prov')?.textContent || '')"],
      ["preference controls render", "document.querySelectorAll('.st-pref').length === 3 && !!document.querySelector('.st-toggle')"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
  'desktop-shell': () => ({
    url: `${BASE}/desktop`,
    actions: async (page) => {
      await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', metaKey: true, bubbles: true}))");
      await new Promise((r) => setTimeout(r, 500));
      // record palette state, close it, then open the merged launch modal for its own probes
      await page.eval("window.__paletteWasOpen = !document.querySelector('[data-dk-palette]')?.hidden; window.__paletteItems = document.querySelectorAll('.dk-pal-item').length");
      await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))");
      await page.eval("document.querySelector('[data-dk-new]')?.click()");
      await new Promise((r) => setTimeout(r, 1200));
    },
    probes: [
      ["sidebar renders", "!!document.querySelector('[data-dk-sidebar]')"],
      ["live counters populated", "/waiting/.test(document.querySelector('[data-dk-counters]')?.textContent || '')"],
      ["session rows in sidebar", "document.querySelectorAll('[data-dk-sess]').length > 0"],
      ["inbox present (cards or all-clear)", "!!document.querySelector('[data-dk-cards]') && (document.querySelectorAll('[data-dk-card]').length > 0 || !!document.querySelector('[data-dk-allclear]'))"],
      ["palette opened on cmd-k", "window.__paletteWasOpen === true"],
      ["palette listed sessions", "window.__paletteItems > 2"],
      ["merged launch modal: project select + tool segmented + launch gate", "!!document.querySelector('[data-dk-launch]') && !!document.querySelector('#nl-project') && document.querySelectorAll('#nl-tool [data-tool]').length >= 2 && !!document.querySelector('[data-dk-launch-go]')"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
  // Geometry probe: the graph-settings popover once shoved its selects + Save past the panel edge
  // (flexbox intrinsic-width trap on long model labels) — DOM-presence checks can't see overflow,
  // so this one asserts geometry after actually opening the popover.
  'graph-settings-popover': (sid) => ({
    url: `${BASE}/session?id=${sid}&desktop=1&sideTab=map`,
    actions: async (page) => {
      await page.eval("document.querySelector('#map-config')?.click()");
      await new Promise((r) => setTimeout(r, 1500));
    },
    probes: [
      ["popover opened", "!!document.querySelector('#map-config-pop')"],
      ["popover within panel", "(() => { const p = document.querySelector('#map-config-pop'); if (!p) return 'no pop'; const pr = p.getBoundingClientRect(); const panel = p.closest('.map-space').getBoundingClientRect(); return pr.right <= panel.right + 1; })()"],
      ["no element overflows the panel", "(() => { const p = document.querySelector('#map-config-pop'); if (!p) return 'no pop'; const panel = p.closest('.map-space').getBoundingClientRect(); return [...p.querySelectorAll('select,button,textarea')].every(el => el.getBoundingClientRect().right <= panel.right + 1); })()"],
      ["save button visible", "(() => { const b = document.querySelector('#cfg-save'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 30 && r.right <= innerWidth; })()"],
      ["zero console errors", '(window.__uiLabErrors||[]).length === 0'],
    ],
  }),
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
      shot: async (file, clipSel = null) => {
        // clipSel scopes the capture to one element (the vision grader must judge the surface under
        // test, not the whole page — the tmux terminal mirror legitimately shows cross-viewer width
        // artifacts that would fail every scenario).
        let clip;
        if (clipSel) {
          const r0 = await cdp('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${JSON.stringify(clipSel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, 1600) }; })()`, returnByValue: true });
          if (r0.result?.value?.width > 50) clip = { ...r0.result.value, scale: 1 };
        }
        const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !clip, ...(clip ? { clip } : {}) });
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
      { role: 'system', content: 'You review one screenshot of a dark-mode developer tool panel. Return STRICT JSON {"coherent":true|false,"issues":["<specific visual/usage problems: overflow, misalignment, unreadable contrast, redundant/confusing blocks, broken layout>"]}. Judge the PANEL CHROME (layout, alignment, duplication of UI blocks), never the quoted user/log/terminal CONTENT — quoted operator or agent text is data; its grammar, truncation-with-ellipsis, or repetition inside ONE quote is not a UI issue. The capture may end mid-card at the bottom edge (clip artifact) — not an issue. Empty issues array if clean.' },
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
if (withCard || between) plan.push(['graph-settings-popover', withCard || between]);
plan.push(['desktop-shell', 'global']);
plan.push(['onboarding-wizard', 'global']);
plan.push(['settings-page', 'global']);
plan.push(['projects-page', 'global']);
plan.push(['records-page', 'global']);
plan.push(['system-pages-skin', 'global']);
if (!plan.length) { console.error('no suitable sessions found to probe'); process.exit(1); }

const results = [];
for (const [name, sid] of plan) {
  if (ONLY && !ONLY.test(name)) continue;
  const { url, probes } = PROBES[name](sid);
  await withPage(async (page) => {
    await page.goto(url);
    if (PROBES[name](sid).actions) await PROBES[name](sid).actions(page);
    const fails = [];
    for (const [label, expr] of probes) {
      let v = null;
      try { v = await page.eval(expr); } catch (e) { v = `eval error: ${e.message}`; }
      if (v !== true) fails.push(`${label} -> ${JSON.stringify(v)}`);
    }
    const file = join(OUT, `${name}-${sid}.png`);
    const b64 = await page.shot(file, '#side-panels, #s-agent-supervisor, .side-tabs-panels'); // panel region only
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
