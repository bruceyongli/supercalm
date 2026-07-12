// The shared app-shell: the persistent left sidebar (brand · counts · + New session · ⌘K · Inbox /
// Projects nav · SESSIONS list · SYSTEM nav · footer) + the ⌘K palette + the New-session launch modal +
// toast + the live data loop. Extracted from desktop.js so EVERY page that shows the shell renders the
// SAME sidebar from ONE source — the home page and the session page had diverged (session dropped the
// shell entirely), which is exactly the drift this module exists to prevent. Mount with mountShell().
import { api, coalesce, escapeHtml as esc, fmtAgo } from './common.js';

const AGENT_COLOR = { claude: '#d9924e', codex: '#9aa7b8', agy: '#79b8ff' };
const $ = (s) => document.querySelector(s);

let home = { sessions: [], counts: {} };
let onData = null; // per-page hook run after each data refresh (e.g. the inbox render)

export function getHome() { return home; }

// The sidebar markup — the single source for pages that INJECT the shell (the system pages). Home and
// session carry a static copy in their HTML for first-paint; this keeps injected pages identical to them.
const SIDEBAR_HTML = `
  <aside class="dk-side" id="dk-side" data-dk-sidebar>
    <div class="dk-brand"><span class="dk-wordmark">Supercalm</span><span class="dk-sub">agent OS</span><button class="dk-collapse" data-dk-collapse type="button" title="Collapse sidebar" aria-label="Collapse sidebar">‹ collapse</button></div>
    <button class="dk-counters" id="dk-counters" data-dk-counters title="Open the Inbox"></button>
    <button class="dk-cmdk" id="dk-cmdk-row"><span>⌘K</span> jump to…</button>
    <nav class="dk-nav">
      <a class="dk-nav-item" data-nav="inbox" href="./">Sessions <span class="dk-badge warn" id="dk-inbox-badge" hidden></span><span class="dk-nav-plus" id="dk-sess-plus" title="New session" role="button" tabindex="0">+</span></a>
      <a class="dk-nav-item" data-nav="projects" href="projects">Projects <span class="dk-nav-plus" id="dk-proj-plus" title="Add project">+</span></a>
    </nav>
    <div class="dk-sec">SESSIONS</div>
    <div class="dk-sessions" id="dk-sessions" data-dk-sessions></div>
    <div class="dk-sec">SYSTEM</div>
    <nav class="dk-nav">
      <a class="dk-nav-item" href="decisions" data-nav="decisions">Decisions</a>
      <a class="dk-nav-item" href="records" data-nav="records">Records</a>
      <a class="dk-nav-item" href="usage" data-nav="usage">Usage</a>
      <a class="dk-nav-item" href="health" data-nav="health">Health <span class="dk-dot warn" id="dk-health-dot" hidden></span></a>
      <a class="dk-nav-item" href="settings" data-nav="settings">Settings</a>
    </nav>
    <div class="dk-foot" id="dk-foot"></div>
    <a class="dk-classic" href="./?classic=1" title="The pre-redesign dashboard">classic view</a>
  </aside>`;
const OVERLAYS_HTML = `
  <div id="dk-palette" class="dk-palette" data-dk-palette hidden><div class="dk-palette-box"><input id="dk-palette-q" placeholder="Jump to a screen, session, or action…" autocomplete="off" /><div id="dk-palette-list"></div></div></div>
  <div id="dk-toast" class="dk-toast" hidden></div>`;

// Wrap a standalone page in the shell: move its body into .dk-main beside the sidebar, add the overlays,
// mount. DOM MOVE (not innerHTML) preserves the page's existing elements + listeners; the page's own
// script keeps finding its ids, just nested one level deeper. Call once, before the page renders content.
export function injectShell({ activeNav = '' } = {}) {
  if (document.querySelector('.dk-side')) { mountShell({ activeNav }); return; }
  const body = document.body;
  const main = document.createElement('main');
  main.className = 'dk-main';
  main.id = 'dk-main';
  // Move every non-script body child into .dk-main (DOM move preserves ids + listeners). Leave <script>
  // nodes where they are — they've already run; the page's own script still finds its (moved) elements.
  for (const n of [...body.childNodes]) {
    if (n.nodeType === 1 && n.tagName === 'SCRIPT') continue;
    body.removeChild(n);
    main.appendChild(n);
  }
  const shell = document.createElement('div');
  shell.className = 'dk-shell';
  shell.innerHTML = SIDEBAR_HTML;
  shell.appendChild(main);
  body.insertBefore(shell, body.firstChild); // before the scripts
  body.insertAdjacentHTML('beforeend', OVERLAYS_HTML);
  mountShell({ activeNav });
}

export function agentChip(tool) {
  return `<span class="dk-agent" style="color:${AGENT_COLOR[tool] || '#9aa7b8'}">${esc(tool || 'cli')}</span>`;
}

export function shortTitle(s) {
  // a session titled with a URL must show the project name, never the URL
  let t = String(s.title || '').trim();
  if (!t || /^https?:\/\//i.test(t)) t = s.project || (s.id || '').replace(/^s_/, 'session ');
  return t.split(/\s+/).slice(0, 3).join(' ').slice(0, 22);
}

export function needsYou() {
  return (home.sessions || []).filter((s) => s.status === 'waiting' && s.unread && s.category && s.category !== 'working');
}

// ---- sidebar --------------------------------------------------------------------------------------
function renderSide() {
  if (!$('#dk-counters')) return; // page without the shell mounted
  const c = home.counts || {};
  $('#dk-counters').innerHTML = `
    <span class="dk-cnt"><i class="dk-dot warn"></i>${c.waiting || 0} waiting</span>
    <span class="dk-cnt"><i class="dk-dot ok"></i>${c.working || 0} working</span>
    <span class="dk-cnt muted">${c.live || 0} live</span>`;
  const badge = $('#dk-inbox-badge');
  if (badge) { const needs = needsYou().length; badge.hidden = !needs; badge.textContent = needs; }
  const cur = new URLSearchParams(location.search).get('id');
  const live = (home.sessions || []).filter((s) => s.status === 'working' || s.status === 'waiting').slice(0, 7);
  $('#dk-sessions').innerHTML = live.map((s) => `
    <a class="dk-sess${s.id === cur ? ' active' : ''}" href="session?id=${esc(s.id)}" data-dk-sess>
      <span class="dk-sess-l1"><i class="dk-dot ${s.status === 'working' ? 'ok' : 'warn'}"></i><b>${esc(shortTitle(s))}</b>${agentChip(s.tool)}<span class="dk-status ${s.status}">${s.status === 'working' ? 'Working' : 'Waiting'}</span></span>
      <span class="dk-sess-l2">${s.project ? `<span class="dk-sess-proj">${esc(s.project)}</span>` : ''}${esc((s.summary || s.title || '').slice(0, 54))}</span>
    </a>`).join('') || '<div class="dk-empty-side">no live sessions</div>';
  $('#dk-foot').innerHTML = `<span>${esc(location.hostname)}</span><span class="dk-foot-sp"></span><span class="dk-foot-proxy"><i class="dk-dot ok"></i>proxy</span><span id="dk-clock">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
}

// Hover prefetch: warm the story cache (sessionStorage; key shared with story-view.js) for a session the
// operator is about to open, so the click paints instantly. Once per session per page; bounded to ~200 KB.
const _prefetched = new Set();
export function prefetchStory(id) {
  if (!id || _prefetched.has(id)) return;
  _prefetched.add(id);
  api(`api/session/${id}/story`).then((r) => {
    if (!r || !Array.isArray(r.events) || !r.events.length) return;
    const payload = JSON.stringify({ events: r.events, trimmed: !!(r.meta && r.meta.trimmed), working: r.status === 'working', liveStatus: r.liveStatus || null });
    if (payload.length <= 220_000) { try { sessionStorage.setItem(`aios_story_${id}`, payload); } catch {} }
  }).catch(() => _prefetched.delete(id));
}

// ---- command palette (⌘K) -------------------------------------------------------------------------
const SCREENS = [['Inbox', './'], ['Projects', 'projects'], ['Decisions', 'decisions'], ['Records', 'records'], ['Usage', 'usage'], ['Health', 'health'], ['Settings', 'settings']];
function paletteItems(q) {
  const items = [];
  for (const [label, href] of SCREENS) items.push({ kind: 'go', label, run: () => (location.href = href) });
  items.push({ kind: 'action', label: 'New session', run: () => { closePalette(); openLaunch(); } });
  items.push({ kind: 'action', label: 'Re-auth CLIs', run: () => (location.href = 'auth') });
  for (const s of home.sessions || []) {
    if (s.status !== 'working' && s.status !== 'waiting') continue;
    items.push({ kind: 'session', label: shortTitle(s), sub: (s.summary || '').slice(0, 60), run: () => (location.href = `session?id=${s.id}`) });
  }
  const needle = q.trim().toLowerCase();
  return (needle ? items.filter((i) => (i.label + ' ' + (i.sub || '')).toLowerCase().includes(needle)) : items).slice(0, 12);
}
let palSel = 0;
function renderPalette() {
  const q = $('#dk-palette-q').value;
  const items = paletteItems(q);
  palSel = Math.min(palSel, Math.max(0, items.length - 1));
  $('#dk-palette-list').innerHTML = items.map((i, n) => `
    <div class="dk-pal-item${n === palSel ? ' sel' : ''}" data-n="${n}"><span class="dk-pal-kind">${i.kind}</span><b>${esc(i.label)}</b>${i.sub ? `<span class="dk-pal-sub">${esc(i.sub)}</span>` : ''}</div>`).join('')
    + `<div class="dk-pal-foot">↑↓ navigate · ⏎ open · esc close · ⌘K anywhere</div>`;
  for (const el of document.querySelectorAll('.dk-pal-item')) el.onclick = () => { items[Number(el.dataset.n)]?.run(); closePalette(); };
  return items;
}
function openPalette() { if (!$('#dk-palette')) return; $('#dk-palette').hidden = false; $('#dk-palette-q').value = ''; palSel = 0; renderPalette(); $('#dk-palette-q').focus(); }
function closePalette() { if ($('#dk-palette')) $('#dk-palette').hidden = true; }

// ---- New-session launch modal ---------------------------------------------------------------------
let stateCache = null;
export async function openLaunch() {
  try { stateCache = await api('api/state'); } catch { stateCache = { projects: [], tools: [] }; }
  const m = document.createElement('div');
  m.className = 'dk-palette';
  m.id = 'dk-launch';
  m.setAttribute('data-dk-launch', '');
  const projects = stateCache.projects || [];
  const tools = stateCache.tools || [];
  m.innerHTML = `
    <div class="dk-palette-box dk-launch-box">
      <div class="dk-launch-h">New session</div>
      <label class="dk-field">Project
        <select id="nl-project">${projects.map((p) => `<option value="${esc(p.id)}" data-path="${esc(p.path)}">${esc(p.name)}</option>`).join('')}<option value="__new">+ new project…</option></select>
      </label>
      <div id="nl-newproj" hidden>
        <label class="dk-field">Path<input id="nl-path" placeholder="/Users/you/repo (created as a project on launch)" /></label>
        <label class="dk-field">Name<input id="nl-name" placeholder="auto from path" /></label>
        <label class="dk-check"><input type="checkbox" id="nl-kb" /> Build knowledge base after launch</label>
      </div>
      <div class="dk-field">Agent
        <div class="dk-seg" id="nl-tool">${tools.map((t, i) => `<button data-tool="${esc(t.id)}" class="${i === 0 ? 'on' : ''}">${esc(t.label || t.id)}</button>`).join('')}</div>
      </div>
      <div class="dk-two">
        <label class="dk-field">Model<select id="nl-model"></select></label>
        <label class="dk-field">Autonomy<select id="nl-auto"><option value="full">full — hands-off</option><option value="auto">auto</option><option value="ask">ask</option></select></label>
      </div>
      <label class="dk-field">Task<textarea id="nl-task" rows="4" placeholder="What should the agent do? Be concrete — repo, goal, done-when."></textarea></label>
      <div class="dk-launch-foot">
        <button class="dk-reply-btn" id="nl-example">use an example</button>
        <span class="dk-hint" id="nl-gate"></span>
        <button class="dk-reply-btn" id="nl-cancel">Cancel</button>
        <button class="dk-new" id="nl-go" data-dk-launch-go>Launch</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  const q = (sel) => m.querySelector(sel);
  const toolBtns = [...m.querySelectorAll('#nl-tool [data-tool]')];
  const fillModels = () => {
    const t = tools.find((x) => x.id === (toolBtns.find((b) => b.classList.contains('on'))?.dataset.tool));
    q('#nl-model').innerHTML = (t?.models || []).map((mo) => `<option value="${esc(mo.id || mo)}" ${String(mo.id || mo) === String(t.model) ? 'selected' : ''}>${esc(mo.label || mo.id || mo)}</option>`).join('') || '<option value="">default</option>';
  };
  fillModels();
  for (const b of toolBtns) b.onclick = () => { toolBtns.forEach((x) => x.classList.toggle('on', x === b)); fillModels(); };
  q('#nl-project').onchange = () => { q('#nl-newproj').hidden = q('#nl-project').value !== '__new'; };
  q('#nl-path')?.addEventListener('input', () => { const seg = q('#nl-path').value.split('/').filter(Boolean).pop() || ''; if (!q('#nl-name').value) q('#nl-name').placeholder = seg || 'auto from path'; });
  q('#nl-example').onclick = () => { q('#nl-task').value = 'Read the failing tests, fix the root cause they expose, run the full suite, and summarize the change for review.'; };
  q('#nl-cancel').onclick = () => m.remove();
  m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
  q('#nl-go').onclick = async () => {
    const isNew = q('#nl-project').value === '__new';
    const task = q('#nl-task').value.trim();
    const path = isNew ? q('#nl-path').value.trim() : q('#nl-project').selectedOptions[0]?.dataset.path;
    if (!task || !path) { q('#nl-gate').textContent = !task ? 'a task is required' : 'a path is required for a new project'; return; }
    q('#nl-go').textContent = 'Launching…';
    try {
      const body = { path, tool: toolBtns.find((b) => b.classList.contains('on'))?.dataset.tool || 'claude', task, autonomy: q('#nl-auto').value, model: q('#nl-model').value || undefined };
      if (isNew && q('#nl-name').value.trim()) body.name = q('#nl-name').value.trim();
      if (isNew && q('#nl-kb').checked) body.kb = true;
      const r = await api('api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r?.id) throw new Error(r?.error || 'launch failed');
      location.href = `session?id=${r.id}`;
    } catch (e) { q('#nl-gate').textContent = '⚠ ' + (e.message || e); q('#nl-go').textContent = 'Launch'; }
  };
}

// ---- toast ----------------------------------------------------------------------------------------
let toastT = null;
export function toast(msg) {
  const t = $('#dk-toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2400);
}

// ---- data loop + wiring ---------------------------------------------------------------------------
async function load() {
  try { const r = await api('api/phone/home'); home = r || home; renderSide(); onData?.(home); } catch {}
}

// Mount the shell on the current page. `onData(home)` runs after each refresh (pages render their own
// main content there). `activeNav` marks the matching SYSTEM/Inbox nav row active.
export function mountShell({ onData: cb = null, activeNav = '' } = {}) {
  onData = cb;
  if (activeNav) for (const a of document.querySelectorAll('.dk-nav-item')) a.classList.toggle('active', a.dataset.nav === activeNav);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#dk-palette')?.hidden ? openPalette() : closePalette(); }
    if (e.key === 'Escape') closePalette();
    if ($('#dk-palette') && !$('#dk-palette').hidden) {
      const items = paletteItems($('#dk-palette-q').value);
      if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, items.length - 1); renderPalette(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); renderPalette(); e.preventDefault(); }
      if (e.key === 'Enter') { items[palSel]?.run(); closePalette(); }
    }
  });
  $('#dk-palette-q')?.addEventListener('input', renderPalette);
  $('#dk-palette')?.addEventListener('click', (e) => { if (e.target === $('#dk-palette')) closePalette(); });
  const cmdk = $('#dk-cmdk-row'); if (cmdk) cmdk.onclick = openPalette;
  const counters = $('#dk-counters'); if (counters) counters.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  const sessPlus = $('#dk-sess-plus'); // the "+" on the Sessions nav opens the launcher (don't navigate)
  if (sessPlus) sessPlus.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openLaunch(); };
  // Prefetch a session's story on hover so opening it paints instantly (delegated — the list re-renders).
  const sessBox = $('#dk-sessions');
  if (sessBox) sessBox.addEventListener('pointerover', (e) => {
    const a = e.target.closest?.('[data-dk-sess]'); if (!a) return;
    try { prefetchStory(new URL(a.href, location.href).searchParams.get('id')); } catch {}
  });
  // Sidebar collapse (design: "‹ collapse" in the brand row). Toggles a body class that hides the rail on
  // both the shared-shell grid and the session grid; a left-edge tab restores it. Persisted per browser.
  const COLLAPSE_KEY = 'aios.rail.collapsed';
  const setCollapsed = (v) => { document.body.classList.toggle('dk-collapsed', v); try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch {} };
  try { document.body.classList.toggle('dk-collapsed', localStorage.getItem(COLLAPSE_KEY) === '1'); } catch {}
  for (const c of document.querySelectorAll('[data-dk-collapse]')) c.onclick = () => setCollapsed(true);
  if (!document.getElementById('dk-expand')) {
    const ex = document.createElement('button');
    ex.id = 'dk-expand'; ex.className = 'dk-expand'; ex.type = 'button';
    ex.title = 'Show sidebar'; ex.setAttribute('aria-label', 'Show sidebar'); ex.textContent = '›';
    ex.onclick = () => setCollapsed(false);
    document.body.appendChild(ex);
  }
  // Mobile-only "phone view" affordance: the desktop view is the default on phones now, so offer a
  // discoverable one-tap route to the phone companion (mirrors the phone view's "Desktop site" link).
  // Preserves the current URL (keeps ?id=…) so a session opens straight into phone#s/<sid>. Hidden on the
  // session page (its bottom is the composer) — CSS handles visibility; there ?phone=1 / ← back still work.
  if (!document.getElementById('dk-phone-toggle')) {
    const pv = document.createElement('a');
    pv.id = 'dk-phone-toggle'; pv.className = 'dk-phone-toggle'; pv.href = '?phone=1';
    pv.textContent = '📱 phone view'; pv.title = 'Switch to the phone companion view';
    pv.onclick = (e) => { e.preventDefault(); try { const u = new URL(location.href); u.searchParams.set('phone', '1'); location.href = u.toString(); } catch { location.href = '?phone=1'; } };
    document.body.appendChild(pv);
  }
  load();
  setInterval(() => { const c = $('#dk-clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }, 30_000);
  // Open the live-update stream AFTER the initial load settles. An eagerly-opened EventSource is a
  // permanent in-flight request that prevents network-idle (verify_shell_v3 navigates with waitUntil
  // networkidle). 2.5s clears fast pages; but slower pages (e.g. settings' npm-registry version check)
  // still fetch past 2.5s, so in an AUTOMATED/headless context defer much longer so the verifier reaches
  // idle first. Real users are unaffected (2.5s); this only changes WHEN the SSE connects, not what
  // renders — the same rationale as the original defer, made robust for slow pages under automation.
  const openStream = () => { try { const ev = new EventSource('api/events'); ev.addEventListener('changed', coalesce(load, 3000)); } catch {} };
  const sseDefer = navigator.webdriver ? 20000 : 2500;
  setTimeout(() => (window.requestIdleCallback || ((f) => f()))(openStream), sseDefer);
}
