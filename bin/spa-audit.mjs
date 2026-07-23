#!/usr/bin/env node
// SPA regression gate — drives the LIVE single-shell app in headless Chrome (CDP) and asserts the
// architecture the operator required: ONE persistent sidebar, no page reloads, content-only view swaps,
// and a bounded stopped list. Complements the static source invariants (sidebar_consistency,
// ui_render_invariants) with a real runtime drive — NOT part of `npm test` (that stays hermetic; this
// needs a running server + Chrome). Run it against a live server as a deploy-time gate:
//   node bin/spa-audit.mjs [http://127.0.0.1:8793/aios/]
// Exits 0 on PASS, 1 on any regression. It catches, forever, the class of bug it was born from:
// a view whose async load() touches the DOM after teardown() (uncaught exception on fast view-switch),
// plus a full-navigation creeping back in (sidebar reload) or the stopped list dumping all N rows.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:8793/aios/';
const CHROME = process.env.AIOS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function pageWs(port) {
  const dl = Date.now() + 12000;
  while (Date.now() < dl) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { const pg = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (pg) return pg.webSocketDebuggerUrl; } } catch {} await delay(150); }
  throw new Error('devtools not ready');
}
const port = await freePort();
const profile = `/tmp/aios-spa-audit-${port}`;
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--password-store=basic', '--mute-audio', `--remote-debugging-port=${port}`, '--window-size=1400,950', 'about:blank'], { stdio: 'ignore' });
child.on('error', (e) => { console.error('chrome spawn error:', e.message); process.exit(2); });
const kill = setTimeout(() => { child.kill('SIGKILL'); }, 50000);
let loadCount = 0; const exceptions = [];
try {
  const wsUrl = await pageWs(port);
  const ws = new WebSocket(wsUrl);
  let id = 1; const pending = new Map();
  const call = (method, params) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === 'Page.loadEventFired') loadCount++;
    else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown');
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws error')), { once: true }); });
  await call('Page.enable'); await call('Runtime.enable').catch(() => {});
  await call('Page.navigate', { url: URL_ });
  const until = Date.now() + 8000; while (loadCount < 1 && Date.now() < until) await delay(100);
  await delay(2500);

  const audit = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rep = { steps: [], stopped: {}, actions: [], churn: {} };
    window.__spaSentinel = 'SENT_' + Math.floor(performance.now());
    const side = document.querySelector('.dk-side');
    if (side) side.dataset.persistId = 'PID_' + Math.floor(performance.now());
    const view = document.querySelector('#view');
    const sub = document.querySelector('.dk-sec-row-sub');
    const countShown = () => { let n = 0, el = document.querySelector('.dk-sec-row-sub'); el = el && el.nextElementSibling; while (el && el.classList && el.classList.contains('dk-row')) { n++; el = el.nextElementSibling; } return n; };
    const toggle = document.querySelector('[data-dk-stopped-toggle]');
    rep.stopped.header = sub && sub.textContent.trim();
    rep.stopped.shownCollapsed = countShown();
    rep.stopped.hasExpander = !!toggle;
    rep.stopped.total = toggle ? Number((toggle.textContent.match(/\\d+/) || [0])[0]) : rep.stopped.shownCollapsed;
    // fast view-switch drive — the teardown-race trigger
    const navs = ['decisions', 'records', 'usage', 'health', 'settings'];
    for (const nav of navs) {
      const a = document.querySelector('.dk-nav-item[data-nav="' + nav + '"]');
      if (!a) { rep.steps.push({ nav, found: false }); continue; }
      const before = view.firstElementChild;
      a.click(); await sleep(450);
      const sideNow = document.querySelector('.dk-side');
      rep.steps.push({ nav, path: location.pathname, viewSwapped: view.firstElementChild !== before, sideSameNode: sideNow === side, sentinel: window.__spaSentinel, navEntries: performance.getEntriesByType('navigation').length });
    }
    // Now hammer the asynchronous Records initializer specifically: 20ms is deliberately shorter than
    // its state/records requests, so every pass tears it down with work in flight. The slower tour above
    // proves each screen renders; this loop proves late continuations respect teardown.
    const recordsNav = document.querySelector('.dk-nav-item[data-nav="records"]');
    const usageNav = document.querySelector('.dk-nav-item[data-nav="usage"]');
    let churnIterations = 0;
    if (recordsNav && usageNav) {
      for (let n = 0; n < 6; n++) {
        recordsNav.click();
        await sleep(20);
        usageNav.click();
        await sleep(180);
        churnIterations++;
      }
    }
    rep.churn = {
      iterations: churnIterations,
      path: location.pathname,
      sideSameNode: document.querySelector('.dk-side') === side,
      sentinel: window.__spaSentinel,
      navEntries: performance.getEntriesByType('navigation').length,
    };
    const home = document.querySelector('.dk-nav-item[data-nav="inbox"]'); if (home) { home.click(); await sleep(450); }
    // Exercise the non-default persisted view too. A prior regression declared session state after
    // setMainView(), so Story mounted successfully while Terminal aborted with a temporal-dead-zone
    // error. The gate must prove that a real session shell—not merely any swapped #view—was mounted.
    localStorage.setItem('aios.session.mainView', 'terminal');
    const sess = document.querySelector('[data-dk-sess]');
    if (sess) {
      const before = view.firstElementChild;
      sess.click();
      for (let n = 0; n < 80; n++) {
        const viewFailed = [...view.children].some((el) => el.textContent?.trim().startsWith('View error:'));
        if (document.querySelector('#session-shell') || viewFailed) break;
        await sleep(100);
      }
      const sideNow = document.querySelector('.dk-side');
      rep.steps.push({
        nav: 'session',
        path: location.pathname,
        viewSwapped: view.firstElementChild !== before,
        sideSameNode: sideNow === side,
        sentinel: window.__spaSentinel,
        navEntries: performance.getEntriesByType('navigation').length,
        bodyClass: document.body.className,
        sessionShell: !!document.querySelector('#session-shell'),
        viewError: [...view.children].some((el) => el.textContent?.trim().startsWith('View error:')),
        terminalActive: document.querySelector('[data-mode="terminal"]')?.classList.contains('active') || false,
      });
    }
    // Action-flow regression: mock only the two mutating API responses, then drive the REAL launcher
    // and kill buttons. This catches programmatic location.href regressions that link-only audits miss,
    // without creating/killing an operator session on the target service.
    const realFetch = window.fetch.bind(window);
    const fakeId = 's_spa_audit_fake';
    window.fetch = async (input, opts = {}) => {
      const u = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = String(opts.method || input?.method || 'GET').toUpperCase();
      if (method === 'POST' && (u.pathname.endsWith('/api/session') || u.pathname.endsWith('/api/session/'))) {
        return new Response(JSON.stringify({ id: fakeId, title: 'SPA action audit', tool: 'claude', status: 'starting', last_activity: Date.now(), started_at: Date.now(), project: { id: 'p_audit', name: 'Audit' } }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'POST' && u.pathname.endsWith('/api/session/' + fakeId + '/kill')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, opts);
    };
    const home2 = document.querySelector('.dk-nav-item[data-nav="inbox"]'); if (home2) { home2.click(); await sleep(500); }
    document.querySelector('#dk-sess-plus')?.click();
    for (let n = 0; n < 50 && !document.querySelector('#nl-go'); n++) await sleep(100);
    const task = document.querySelector('#nl-task'); if (task) task.value = 'Visual SPA action audit';
    const project = document.querySelector('#nl-project');
    if (project?.value === '__new') { const path = document.querySelector('#nl-path'); if (path) path.value = '/tmp'; }
    const beforeLaunchView = view.firstElementChild;
    document.querySelector('#nl-go')?.click();
    for (let n = 0; n < 50 && !document.querySelector('#b-kill'); n++) await sleep(100);
    rep.actions.push({ action: 'launch', path: location.pathname, id: new URLSearchParams(location.search).get('id'), viewSwapped: view.firstElementChild !== beforeLaunchView, sideSameNode: document.querySelector('.dk-side') === side, sentinel: window.__spaSentinel, navEntries: performance.getEntriesByType('navigation').length });
    window.confirm = () => true;
    document.querySelector('#b-kill')?.click();
    for (let n = 0; n < 40 && new URLSearchParams(location.search).get('id'); n++) await sleep(100);
    rep.actions.push({ action: 'kill', path: location.pathname, id: new URLSearchParams(location.search).get('id'), sideSameNode: document.querySelector('.dk-side') === side, sentinel: window.__spaSentinel, navEntries: performance.getEntriesByType('navigation').length, title: document.title });
    // let any in-flight fetch from the LAST view resolve so its teardown-race (if any) throws now
    await sleep(1200);
    return rep;
  })()`;
  const r = await call('Runtime.evaluate', { expression: audit, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'browser audit evaluation failed');
  const rep = r.result?.value || { steps: [], stopped: {}, actions: [] };
  try { ws.close(); } catch {}

  // ---- assertions ----
  const fails = [];
  if (exceptions.length) fails.push(`${exceptions.length} page exception(s): ` + exceptions.slice(0, 4).join(' | '));
  if (loadCount !== 1) fails.push(`expected exactly 1 page load (SPA), saw ${loadCount} — a full navigation crept back in`);
  const s0 = rep.steps[0]?.sentinel;
  for (const st of rep.steps) {
    if (st.found === false) { fails.push(`nav "${st.nav}" not found in the rail`); continue; }
    if (!st.viewSwapped) fails.push(`nav "${st.nav}": #view did not swap`);
    if (!st.sideSameNode) fails.push(`nav "${st.nav}": .dk-side was RE-CREATED (sidebar reload)`);
    if (st.navEntries !== 1) fails.push(`nav "${st.nav}": ${st.navEntries} navigation entries — full nav, not pushState`);
    if (st.sentinel !== s0) fails.push(`nav "${st.nav}": window sentinel changed — document was replaced`);
  }
  const sessionStep = rep.steps.find((st) => st.nav === 'session');
  if (!sessionStep?.sessionShell) fails.push('persisted Terminal session route did not mount #session-shell');
  if (sessionStep?.viewError) fails.push('persisted Terminal session route rendered a View error');
  if (!sessionStep?.terminalActive) fails.push('persisted Terminal preference was not active after session mount');
  if (rep.churn?.iterations !== 6) fails.push(`Records teardown churn ran ${rep.churn?.iterations || 0}/6 iterations`);
  if (!rep.churn?.sideSameNode) fails.push('Records teardown churn re-created the sidebar');
  if (rep.churn?.sentinel !== s0 || rep.churn?.navEntries !== 1) fails.push('Records teardown churn replaced the document');
  const launch = rep.actions.find((a) => a.action === 'launch');
  const killed = rep.actions.find((a) => a.action === 'kill');
  if (!launch || launch.id !== 's_spa_audit_fake' || !launch.viewSwapped) fails.push('launch action did not route to the accepted starting session in place');
  if (!killed || killed.id) fails.push('kill action did not route home in place');
  const homeTitleRx = /^(?:Supercalm · idle|! \d+ waiting · Supercalm|\d+ working · \d+ live · Supercalm)$/;
  if (killed && !homeTitleRx.test(killed.title || '')) fails.push(`kill action left stale session browser identity on home: "${killed.title || ''}"`);
  for (const a of rep.actions) {
    if (!a.sideSameNode) fails.push(`${a.action}: .dk-side was re-created`);
    if (a.sentinel !== s0) fails.push(`${a.action}: document sentinel changed`);
    if (a.navEntries !== 1) fails.push(`${a.action}: ${a.navEntries} navigation entries — full navigation occurred`);
  }
  const cap = 10;
  if (rep.stopped.total > cap && rep.stopped.shownCollapsed > cap) fails.push(`stopped list not capped: showing ${rep.stopped.shownCollapsed} of ${rep.stopped.total} (cap ${cap})`);
  if (rep.stopped.total > cap && !rep.stopped.hasExpander) fails.push(`stopped list has ${rep.stopped.total} but no "show all" expander`);

  console.log(JSON.stringify({ loadEvents: loadCount, exceptions: exceptions.length, steps: rep.steps, churn: rep.churn, actions: rep.actions, stopped: rep.stopped, pass: fails.length === 0 }, null, 2));
  if (fails.length) { console.error('\nSPA AUDIT FAIL:\n - ' + fails.join('\n - ')); process.exitCode = 1; }
  else console.log('\nSPA AUDIT PASS — one document, one persistent sidebar, no reloads, stopped list bounded, zero page exceptions.');
} catch (e) {
  console.error('spa-audit error:', e.message); process.exitCode = 2;
} finally { clearTimeout(kill); child.kill('SIGKILL'); }
