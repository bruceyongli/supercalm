#!/usr/bin/env node
// Agentic UI test — a vision model (default gpt-5.6-sol) DRIVES the app on an emulated phone and acts
// as the release judge. Computer-use loop: each turn the model sees a screenshot + a map of tappable
// elements, chooses one action (tap/type/select/scroll/nav/back/wait/done); the harness executes it
// with REAL CDP touch events (so overlay-eats-tap and stuck-panel bugs reproduce), logs the issues the
// model files, and at the end asks for a PASS/FAIL gate verdict with blocking findings.
//
//   node bin/ui-agent-test.mjs [--base http://127.0.0.1:8801/aios/] [--model gpt-5.6-sol]
//                              [--steps 40] [--out /tmp/ui-agent-test] [--focus "…"] [--effort medium]
//
// Exit code: 0 on PASS, 1 on FAIL, 2 on harness error. Artifacts: step-NN.png + transcript.json +
// verdict.json in --out. Run it against a SCRATCH instance (AIOS_PORT/AIOS_DATA) — the agent may send
// input to sessions, launch a session, stop/kill — never point it at the live service.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fleetKey } from '../src/model_catalog.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = (opt('base', 'http://127.0.0.1:8801/aios/')).replace(/\/?$/, '/');
const MODEL = opt('model', 'gpt-5.6-sol');
const STEPS = Number(opt('steps', 40));
const OUT = opt('out', '/tmp/ui-agent-test');
const FOCUS = opt('focus', '');
const EFFORT = opt('effort', 'medium');
const VW = 390, VH = 844;
const CHROME = process.env.AIOS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PORTS = [8787, 8788, 8789, 8790, 8791, 8792];

const key = await fleetKey();
async function portFor(model) {
  for (const p of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) });
      if (r.ok && ((await r.json()).data || []).some((m) => m.id === model)) return p;
    } catch {}
  }
  throw new Error(`model ${model} not on any proxy port`);
}

const SYS = `You are a meticulous mobile QA agent with full control of a phone browser, testing "Supercalm" — a dark, monospace, mobile-first console that supervises CLI coding agents. You see a screenshot (390x844 phone) plus a numbered map of tappable elements. Each turn you do ONE action, observe, and file any VISUAL or FUNCTIONAL issues you notice (overlap, clipping, dead space, unreadable text, controls that don't respond or mis-respond, layouts that waste the small screen, anything a real phone user would curse at).

JOURNEYS to cover (self-paced; mark them done as you complete them):
1. dashboard-triage: read the dashboard, open the sidebar drawer (☰) and close it.
2. open-session: open a session from the list; confirm the story/messages are readable and fill the screen sensibly.
3. compose-send: tap the composer, type "status?" and send it; confirm it appears without breaking layout.
4. panels: open agent panels from the bottom bar glyphs (try 2 different ones + the gear); scroll inside; CLOSE each one and verify it actually closed (this has been buggy).
5. terminal-switch: switch the session to the terminal view and back to story.
6. new-session: open the new-session launcher (+ in the drawer's Sessions row, or from the dashboard); inspect the form fits the phone; CANCEL it (do not launch).
7. system-pages: visit Settings and Usage via the drawer; check they render phone-friendly.
8. phone-companion: tap the "📱 phone view" pill (bottom-right of non-session pages); verify it lands in the phone companion; use "Desktop site" or back to return.

Rules:
- ONE action per turn. Prefer tapping mapped elements by ref. Use scroll to reveal content (the map only lists visible elements).
- If typing, first tap the field, then use the type action.
- If an action appears to do NOTHING or does the wrong thing, file an issue — that is exactly what you're here to catch. Retry once at most, then move on.
- Do not get stuck: if a journey is impossible, file an issue and continue.
- NEVER launch a session (cancel the form) and never tap Kill on a working session; Stop/keys on the scratch session are allowed.

Respond with STRICT JSON only:
{"observation":"<1 sentence: what the screen shows / what your last action did>",
 "issues":[{"severity":"high"|"medium"|"low","screen":"<where>","issue":"<concrete defect>"}],
 "journeys_done":["dashboard-triage", ...cumulative],
 "action":{"type":"tap"|"type"|"select"|"scroll"|"nav"|"back"|"wait"|"done",
           "ref":"e12" (tap/select/type target),
           "text":"..." (type: text to enter; select: the option label),
           "dy":600 (scroll: +down/-up),
           "url":"settings" (nav: app-relative path),
           "why":"<short reason>"}}
Use {"action":{"type":"done"}} when all journeys are covered (or clearly blocked).`;

// ---- chrome/cdp ----------------------------------------------------------------------------------
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function pageWs(port) {
  const dl = Date.now() + 12000;
  while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { const pg = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (pg) return pg.webSocketDebuggerUrl; } } catch {} await delay(150); }
  throw new Error('devtools not ready');
}
await mkdir(OUT, { recursive: true });
const cdpPort = await freePort();
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=/tmp/aios-uat-${cdpPort}`, '--password-store=basic', '--mute-audio', `--remote-debugging-port=${cdpPort}`, `--window-size=${VW},${VH}`, 'about:blank'], { stdio: 'ignore' });
chrome.on('error', (e) => { console.error('chrome spawn error:', e.message); process.exit(2); });
const hardKill = setTimeout(() => chrome.kill('SIGKILL'), 30 * 60 * 1000);

const ws = new WebSocket(await pageWs(cdpPort));
let mid = 1; const pending = new Map();
const cdp = (method, params) => new Promise((res, rej) => { const i = mid++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws error')), { once: true }); });
await cdp('Page.enable'); await cdp('Runtime.enable').catch(() => {});
await cdp('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Network.enable').catch(() => {});
await cdp('Network.setUserAgentOverride', { userAgent: UA, platform: 'iPhone' }).catch(() => {});
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value);

async function tapXY(x, y) {
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await delay(40);
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function scrollBy(dy) {
  // touch-drag scroll on the dominant scroller under the midpoint (real behavior incl. momentum-free)
  await evaluate(`(() => {
    const el = document.elementFromPoint(${VW / 2}, ${VH / 2});
    let s = el; while (s && s !== document.body && s.scrollHeight <= s.clientHeight + 4) s = s.parentElement;
    (s && s !== document.body ? s : (document.scrollingElement || document.documentElement)).scrollBy({ top: ${Number(dy) || 0}, behavior: 'instant' });
  })()`);
}

// visible interactables → numbered map (the model taps by ref; we tap by real coordinates)
const MAP_EXPR = `(() => {
  const sels = 'a[href],button,[role="button"],input,textarea,select,summary,[onclick],[data-open],[data-tab],[data-main-view],[data-mode],[data-nav],.sessrow,.needcard,.dk-sess,.dk-row,label.setting';
  const seen = new Set(); const out = [];
  for (const el of document.querySelectorAll(sels)) {
    if (seen.has(el)) continue; seen.add(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > ${VH} || r.right < 0 || r.left > ${VW}) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(Math.min(${VW} - 2, Math.max(2, cx)), Math.min(${VH} - 2, Math.max(2, cy)));
    const covered = top && top !== el && !el.contains(top) && !top.contains(el);
    let label = (el.getAttribute('aria-label') || el.textContent || el.placeholder || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 42);
    if (el.tagName === 'SELECT' && el.selectedIndex >= 0) label = 'select: ' + (el.options[el.selectedIndex]?.textContent || '').trim().slice(0, 30);
    out.push({ tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), label, x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), covered: covered || undefined });
    if (out.length >= 90) break;
  }
  return { url: location.pathname + location.search + location.hash, scrollY: Math.round((document.scrollingElement || {}).scrollTop || 0), els: out };
})()`;

async function snapshot(stepN) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(OUT, `step-${String(stepN).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'));
  const map = (await evaluate(MAP_EXPR)) || { url: '?', els: [] };
  return { b64: shot.data, map };
}

// ---- model loop ----------------------------------------------------------------------------------
const port = await portFor(MODEL);
console.log(`judge: ${MODEL}@${port} · target: ${BASE} · max ${STEPS} steps → ${OUT}`);
async function chat(messages) {
  const body = { model: MODEL, temperature: 0.2, reasoning_effort: EFFORT, response_format: { type: 'json_object' }, messages };
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.error) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  const text = j.choices?.[0]?.message?.content || '';
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON: ' + String(text).slice(0, 160));
  return JSON.parse(m[0]);
}

const transcript = [];
const allIssues = [];
let journeysDone = [];
let refs = []; // current step's ref -> {x,y,tag}

function userTurn(stepN, map, note) {
  refs = map.els;
  const elList = map.els.map((e, i) => `e${i + 1} ${e.tag} (${e.x},${e.y} ${e.w}x${e.h})${e.covered ? ' [COVERED by another element]' : ''} ${e.label ? '"' + e.label + '"' : ''}`).join('\n');
  return {
    role: 'user',
    content: [
      { type: 'text', text: `step ${stepN}/${STEPS} · url: ${map.url} · scrollY: ${map.scrollY}${note ? `\nlast action result: ${note}` : ''}\nJourneys still open: ${['dashboard-triage', 'open-session', 'compose-send', 'panels', 'terminal-switch', 'new-session', 'system-pages', 'phone-companion'].filter((j) => !journeysDone.includes(j)).join(', ') || '(all covered — finish up and use done)'}${FOCUS ? `\nExtra operator focus: ${FOCUS}` : ''}\nTappable elements:\n${elList}\nReply with your strict json decision.` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,` } }, // placeholder replaced below
    ],
  };
}

try {
  await cdp('Page.navigate', { url: BASE });
  await delay(3000);
  let note = 'session start — you are on the app root';
  const history = [{ role: 'system', content: SYS }];
  for (let step = 1; step <= STEPS; step++) {
    const { b64, map } = await snapshot(step);
    const turn = userTurn(step, map, note);
    turn.content[1].image_url.url = `data:image/png;base64,${b64}`;
    // keep context bounded: system + last 3 exchanges + current turn (older images dropped)
    const win = [history[0], ...history.slice(1).slice(-6).map((m) => (m.role === 'user' ? { role: 'user', content: m.content.filter((c) => c.type === 'text') } : m)), turn];
    let d;
    try { d = await chat(win); } catch (e) { console.log(`  step ${step}: model error: ${e.message}`); note = 'model error, screen unchanged'; await delay(800); continue; }
    history.push({ role: 'user', content: turn.content.filter((c) => c.type === 'text') }, { role: 'assistant', content: JSON.stringify(d) });
    for (const iss of d.issues || []) { allIssues.push({ step, ...iss }); }
    if (Array.isArray(d.journeys_done)) journeysDone = [...new Set([...journeysDone, ...d.journeys_done])];
    const a = d.action || {};
    transcript.push({ step, url: map.url, observation: d.observation, issues: d.issues || [], action: a });
    console.log(`  ${String(step).padStart(2)} ${map.url.slice(0, 44).padEnd(44)} ${a.type || '?'} ${a.ref || a.url || a.dy || ''} ${(d.issues || []).length ? `⚠ ${(d.issues || []).length} issue(s)` : ''}`);
    if (a.type === 'done') break;
    try {
      const el = a.ref ? refs[Number(String(a.ref).replace(/^e/, '')) - 1] : null;
      if (a.type === 'tap' && el) { await tapXY(el.x, el.y); note = `tapped ${a.ref} ${el.tag}`; }
      else if (a.type === 'type' && a.text != null) {
        if (el) await tapXY(el.x, el.y);
        await delay(250);
        await cdp('Input.insertText', { text: String(a.text) });
        note = `typed "${String(a.text).slice(0, 30)}"`;
      } else if (a.type === 'select' && el && a.text != null) {
        note = (await evaluate(`(() => {
          const els = document.querySelectorAll('select');
          for (const s of els) { const r = s.getBoundingClientRect(); if (Math.abs(r.left + r.width/2 - ${el.x}) < 8 && Math.abs(r.top + r.height/2 - ${el.y}) < 8) {
            const o = [...s.options].find((o) => o.textContent.trim().toLowerCase().includes(${JSON.stringify(String(a.text).toLowerCase())}));
            if (!o) return 'option not found';
            s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return 'selected ' + o.textContent.trim();
          } }
          return 'select not found';
        })()`)) || 'select attempted';
      } else if (a.type === 'scroll') { await scrollBy(a.dy ?? 600); note = `scrolled ${a.dy ?? 600}`; }
      else if (a.type === 'nav' && a.url) { await cdp('Page.navigate', { url: new URL(String(a.url).replace(/^\//, ''), BASE).href }); note = `navigated to ${a.url}`; await delay(1500); }
      else if (a.type === 'back') { await evaluate('history.back()'); note = 'went back'; await delay(1200); }
      else if (a.type === 'wait') { note = 'waited'; }
      else { note = `action ${a.type} not executable (bad ref?)`; }
    } catch (e) { note = 'action failed: ' + e.message; }
    await delay(1600);
  }

  // ---- final gate verdict --------------------------------------------------------------------------
  const { b64: finalShot } = await snapshot(99);
  const verdictMsgs = [
    { role: 'system', content: 'You are the release gate for a mobile UI. Based on the QA run summarized below, return a strict json verdict: {"verdict":"PASS"|"FAIL","blocking":[{"issue":"...","screen":"..."}],"notable":[{"issue":"...","screen":"..."}],"summary":"<2 sentences>"} — FAIL if any issue would make a phone user unable (or angry) to do core work: triage, read a session, reply, use panels, navigate. Cosmetic nits alone are not blocking.' },
    { role: 'user', content: [
      { type: 'text', text: `QA run transcript (${transcript.length} steps). Journeys completed: ${journeysDone.join(', ') || 'none'}. Issues filed:\n${allIssues.map((i) => `- [${i.severity}] step ${i.step} ${i.screen}: ${i.issue}`).join('\n') || '(none)'}\n\nFinal screen attached. Return the strict json verdict.` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${finalShot}` } },
    ] },
  ];
  const verdict = await chat(verdictMsgs);
  await writeFile(join(OUT, 'transcript.json'), JSON.stringify({ base: BASE, model: MODEL, at: new Date().toISOString(), journeysDone, transcript, issues: allIssues }, null, 2));
  await writeFile(join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(`\nJourneys: ${journeysDone.join(', ') || 'none'}`);
  console.log(`Issues filed: ${allIssues.length}`);
  for (const i of allIssues) console.log(`  [${(i.severity || '?').toUpperCase().padEnd(6)}] ${i.screen}: ${i.issue}`);
  console.log(`\nGATE: ${verdict.verdict} — ${verdict.summary || ''}`);
  for (const b of verdict.blocking || []) console.log(`  ✖ BLOCKING ${b.screen}: ${b.issue}`);
  process.exitCode = verdict.verdict === 'PASS' ? 0 : 1;
} catch (e) {
  console.error('ui-agent-test error:', e.message);
  process.exitCode = 2;
} finally {
  clearTimeout(hardKill);
  try { ws.close(); } catch {}
  chrome.kill('SIGKILL');
}
