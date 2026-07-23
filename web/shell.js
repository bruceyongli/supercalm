// The shared app-shell: the persistent left sidebar (brand · counts · + New session · ⌘K · Inbox /
// Projects nav · SESSIONS list · SYSTEM nav · footer) + the ⌘K palette + the New-session launch modal +
// toast + the live data loop. Extracted from desktop.js so EVERY page that shows the shell renders the
// SAME sidebar from ONE source — the home page and the session page had diverged (session dropped the
// shell entirely), which is exactly the drift this module exists to prevent. Mount with mountShell().
import { api, escapeHtml as esc, fmtAgo, wireMic } from './common.js';
import { navigate } from './navigation.js';
import { isStaleSessionPatch, mergeSessionPatch, mergeSessionSnapshot } from './session-state.js';

const AGENT_COLOR = { claude: '#d9924e', codex: '#9aa7b8', agy: '#79b8ff' };
const $ = (s) => document.querySelector(s);

let home = { sessions: [], counts: {} };
const sessionsById = new Map();
// Keep rows where the operator last saw them. `last_activity` can move every 1.5s while several agents
// are producing output; sorting on every patch made the rail and dashboard continually trade places.
// The first snapshot establishes recency order, new sessions are inserted at the top, and later patches
// only update their existing keyed row. A recovery snapshot removes missing rows without reshuffling the
// survivors.
let sessionOrder = [];
let hasSessionSnapshot = false;
let sessionMutationEpoch = 0;
const sessionTouchedAt = new Map();
let onData = null; // per-page hook run after each data refresh (e.g. the inbox render)

export function getHome() { return home; }

// SPA views subscribe to the shared home-data loop (the router calls mountShell ONCE for the app's life,
// so a view can't use the single onData hook). Returns an unsubscribe fn; fires immediately with current
// home so a freshly-mounted view paints without waiting for the next poll.
const homeSubs = new Set();
export function subscribeHome(cb) { homeSubs.add(cb); try { cb(home); } catch {} return () => homeSubs.delete(cb); }
const sessionEventSubs = new Set();
export function subscribeSessionEvents(cb, { replayId = null } = {}) {
  sessionEventSubs.add(cb);
  // A session view can mount after the shared EventSource already consumed Starting -> Working. Replay
  // the normalized row once so subscribing is race-free without another broad fetch.
  if (replayId) {
    const row = sessionsById.get(replayId);
    if (row) queueMicrotask(() => {
      if (!sessionEventSubs.has(cb)) return;
      const payload = {
        ...row,
        session: row.id,
        previousStatus: row.status,
        project: row.project ? { name: row.project } : null,
        source: 'store-replay',
      };
      try { cb(payload, row); } catch {}
    });
  }
  return () => sessionEventSubs.delete(cb);
}

function normalizeSession(s) {
  if (!s?.id) return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (v !== undefined) out[k] = v;
  if (Object.hasOwn(s, 'project')) out.project = typeof s.project === 'object' ? (s.project?.name || '') : (s.project || '');
  return out;
}
function recalcHome() {
  const ordered = [];
  const seen = new Set();
  for (const id of sessionOrder) {
    const row = sessionsById.get(id);
    if (!row) continue;
    ordered.push(row);
    seen.add(id);
  }
  // Defensive fallback for a row introduced by a future mutation path that forgot to update the order.
  for (const [id, row] of sessionsById) {
    if (seen.has(id)) continue;
    ordered.push(row);
    sessionOrder.push(id);
  }
  const sessions = ordered;
  home = {
    ...home,
    sessions,
    counts: {
      waiting: sessions.filter((s) => s.status === 'waiting').length,
      working: sessions.filter((s) => s.status === 'working').length,
      live: sessions.filter((s) => ['starting', 'working', 'waiting'].includes(s.status)).length,
      dismissed: sessions.filter((s) => s.dismissed).length,
    },
  };
}
function publishHome(change = { type: 'replace', ids: [] }) {
  renderSide(change);
  onData?.(home, change);
  for (const cb of homeSubs) { try { cb(home, change); } catch {} }
}
function replaceHome(next, { requestedAtEpoch = sessionMutationEpoch } = {}) {
  const incoming = [];
  for (const raw of next?.sessions || []) {
    const s = normalizeSession(raw);
    if (s) incoming.push(s);
  }
  const changedAfterRequest = new Set(
    [...sessionTouchedAt].filter(([, epoch]) => epoch > requestedAtEpoch).map(([id]) => id),
  );
  const reconciled = mergeSessionSnapshot([...sessionsById.values()], incoming, changedAfterRequest);
  const incomingIds = reconciled.map((s) => s.id);
  if (!hasSessionSnapshot) {
    sessionOrder = incomingIds;
    hasSessionSnapshot = true;
  } else {
    const known = new Set(sessionsById.keys());
    const present = new Set(incomingIds);
    const newcomers = incomingIds.filter((id) => !known.has(id));
    const retained = sessionOrder.filter((id) => present.has(id));
    const placed = new Set([...newcomers, ...retained]);
    sessionOrder = [...newcomers, ...retained, ...incomingIds.filter((id) => !placed.has(id))];
  }
  sessionsById.clear();
  for (const s of reconciled) sessionsById.set(s.id, s);
  for (const id of [...sessionTouchedAt.keys()]) {
    if (!sessionsById.has(id)) sessionTouchedAt.delete(id);
  }
  home = { ...(next || {}), sessions: [] };
  recalcHome();
  publishHome({ type: 'replace', ids: [...sessionsById.keys()] });
}
export function upsertSession(raw, { publish = true } = {}) {
  let patch = normalizeSession(raw);
  if (!patch) return null;
  const current = sessionsById.get(patch.id) || {};
  if (!current.id && !patch.status) return null; // a scoped metadata patch cannot construct a session row
  if (isStaleSessionPatch(current, patch)) return current;
  // POST /api/session returns a Starting projection while the status SSE can win the network race and
  // publish Working first. Never let that older, unversioned response roll lifecycle state backward.
  if (patch.status === 'starting' && current.status && current.status !== 'starting'
      && (!patch.ts || Number(patch.ts) < Number(current.ts || 0))) {
    const lifecycle = new Set(['status', 'question', 'summary', 'category', 'stage', 'last_activity', 'ended_at', 'exit_code', 'parked', 'degraded']);
    patch = Object.fromEntries(Object.entries(patch).filter(([key]) => !lifecycle.has(key)));
  }
  const next = mergeSessionPatch(current, patch);
  sessionsById.set(next.id, next);
  sessionTouchedAt.set(next.id, ++sessionMutationEpoch);
  if (!current.id) sessionOrder = [next.id, ...sessionOrder.filter((id) => id !== next.id)];
  recalcHome();
  if (publish) publishHome({ type: current.id ? 'patch' : 'create', ids: [next.id] });
  return next;
}

export function agentChip(tool) {
  return `<span class="dk-agent" style="color:${AGENT_COLOR[tool] || '#9aa7b8'}">${esc(tool || 'cli')}</span>`;
}

// Rail/drawer rows: the full first line (CSS ellipsizes at rail width; ≤720 clamps to 2 lines) —
// the 3-word shortTitle left "Print a short" fragments that made sessions indistinguishable (judge).
export function railTitle(s) {
  let t = String(s.title || '').trim().split('\n')[0];
  if (!t || /^https?:\/\//i.test(t)) t = s.project || (s.id || '').replace(/^s_/, 'session ');
  return t.slice(0, 120);
}
export function shortTitle(s) {
  // a session titled with a URL must show the project name, never the URL
  let t = String(s.title || '').trim();
  if (!t || /^https?:\/\//i.test(t)) t = s.project || (s.id || '').replace(/^s_/, 'session ');
  return t.split(/\s+/).slice(0, 3).join(' ').slice(0, 22);
}

export function needsYou() {
  return (home.sessions || []).filter((s) => !s.dismissed && s.status === 'waiting' && s.unread && s.category && s.category !== 'working');
}

export function dismissedAttention() {
  return (home.sessions || [])
    .filter((s) => s.dismissed)
    .sort((a, b) => Number(b.dismissed_at || 0) - Number(a.dismissed_at || 0));
}

// ---- sidebar --------------------------------------------------------------------------------------
function keyedNode(html, key) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const node = t.content.firstElementChild;
  node.dataset.key = key;
  node.dataset.render = html;
  return node;
}
function syncAttributes(current, next) {
  for (const { name } of [...current.attributes]) {
    if (!next.hasAttribute(name)) current.removeAttribute(name);
  }
  for (const { name, value } of [...next.attributes]) {
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  }
}
function patchRailSession(current, next) {
  if (!current.matches('[data-dk-sess]') || !next.matches('[data-dk-sess]')) return false;
  const currentDot = current.querySelector('.dk-sess-l1 > .dk-dot');
  const nextDot = next.querySelector('.dk-sess-l1 > .dk-dot');
  const currentTitle = current.querySelector('.dk-sess-l1 > b');
  const nextTitle = next.querySelector('.dk-sess-l1 > b');
  const currentAgent = current.querySelector('.dk-sess-l1 > .dk-agent');
  const nextAgent = next.querySelector('.dk-sess-l1 > .dk-agent');
  const currentAge = current.querySelector('.dk-sess-l1 > .dk-sess-age');
  const nextAge = next.querySelector('.dk-sess-l1 > .dk-sess-age');
  const currentSummary = current.querySelector('.dk-sess-l2');
  const nextSummary = next.querySelector('.dk-sess-l2');
  if (!currentDot || !nextDot || !currentTitle || !nextTitle || !currentAgent || !nextAgent
      || !currentAge || !nextAge || !currentSummary || !nextSummary) return false;

  syncAttributes(current, next);
  // Keep the connected status-dot node alive. Replacing it on every activity/summary event resets its
  // CSS animation, so frequently-updating sessions look as though they blink faster (or never pulse).
  syncAttributes(currentDot, nextDot);
  currentTitle.textContent = nextTitle.textContent;
  syncAttributes(currentAgent, nextAgent);
  currentAgent.textContent = nextAgent.textContent;
  currentAge.textContent = nextAge.textContent;
  if (currentSummary.innerHTML !== nextSummary.innerHTML) currentSummary.innerHTML = nextSummary.innerHTML;
  return true;
}
function reconcileKeyed(container, specs) {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const wanted = new Set(specs.map((s) => s.key));
  for (const [key, el] of existing) if (!wanted.has(key)) el.remove();
  specs.forEach((spec, i) => {
    let el = existing.get(spec.key);
    if (!el || el.dataset.render !== spec.html) {
      const fresh = keyedNode(spec.html, spec.key);
      if (el && patchRailSession(el, fresh)) {
        el.dataset.render = spec.html;
      } else {
        if (el) el.replaceWith(fresh);
        el = fresh;
      }
    }
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
}

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
  // The rail lists only LIVE sessions (working/waiting) — a lean quick-nav. Stopped/parked sessions are
  // browsed on the dashboard page body (desktop.js #dk-rows), not stuffed into the nav rail.
  const live = (home.sessions || []).filter((s) => ['starting', 'working', 'waiting'].includes(s.status));
  // Rail rows (operator, 2026-07-16): the dot IS the status — no Working/Waiting words; the freed
  // width goes to the title (flex) and a right-aligned last-activity age (the triage signal the rail
  // lacked: waiting 30s and waiting 2h are different urgencies).
  const specs = live.length ? live.map((s) => ({ key: s.id, html: `
    <a class="dk-sess${s.id === cur ? ' active' : ''}" href="session?id=${esc(s.id)}" data-dk-sess data-sid="${esc(s.id)}">
      <span class="dk-sess-l1"><i class="dk-dot ${s.status === 'working' ? 'ok pulse' : s.status === 'waiting' ? 'warn' : ''}"></i><b>${esc(railTitle(s))}</b>${agentChip(s.tool)}<span class="dk-sess-age">${fmtAgo(s.last_activity)}</span></span>
      <span class="dk-sess-l2">${s.project ? `<span class="dk-sess-proj">${esc(s.project)}</span>` : ''}${esc((s.summary || (s.status === 'starting' ? 'Starting…' : '') || s.title || '').slice(0, 64))}</span>
    </a>` })) : [{ key: '__empty', html: '<div class="dk-empty-side">no live sessions</div>' }];
  reconcileKeyed($('#dk-sessions'), specs);
  // Footer = the important stuff only (operator): the running build (version, was the hostname) + the
  // REAL auth mode (fetched below; the old chip was a hardcoded green "proxy" dot). The wall clock is
  // gone — the OS shows the time.
  const am = authMode; // fetched once per page (fetchAuthMode below); null until known
  const chip = am == null ? '' : am.badge;
  $('#dk-foot').innerHTML = `<span title="Supercalm build">${appVersion ? 'v' + esc(appVersion) : esc(location.hostname)}</span><span class="dk-foot-sp"></span><span class="dk-foot-proxy">${chip}</span>`;
}

// Auth-mode footer chip: one fetch per page load (a footer status, not a live feed). proxy (external
// fleet) / aios (Supercalm's own login + shim) / pinned → green, named. cli (the CLIs' own logins —
// legitimate, but Supercalm can't see whether they're actually signed in) → a neutral dot; the
// dashboard hero carries the actionable "finish setup" message for true fresh installs.
let authMode = null;
let appVersion = null; // footer build stamp; renderSide falls back to the hostname until known
(async () => {
  try {
    const [r, v] = await Promise.all([api('api/auth/status').catch(() => ({})), api('api/version').catch(() => ({}))]);
    appVersion = v.version || null;
    const mode = r.mode || 'cli';
    authMode = mode === 'cli'
      ? { badge: '<i class="dk-dot"></i>cli auth' }
      : { badge: `<i class="dk-dot ok"></i>${esc(mode)}` };
  } catch { authMode = { badge: '' }; }
  const foot = $('#dk-foot');
  if (foot && (authMode || appVersion)) {
    foot.innerHTML = `<span title="Supercalm build">${appVersion ? 'v' + esc(appVersion) : esc(location.hostname)}</span><span class="dk-foot-sp"></span><span class="dk-foot-proxy">${authMode?.badge || ''}</span>`;
  }
})();

// Hover prefetch: warm the story cache (sessionStorage; key shared with story-view.js) for a session the
// operator is about to open, so the click paints instantly. Once per session per page; bounded to ~200 KB.
const _prefetched = new Set();
export function prefetchStory(id) {
  if (!id || _prefetched.has(id)) return;
  _prefetched.add(id);
  api(`api/session/${id}/story`).then((r) => {
    if (!r || !Array.isArray(r.events) || !r.events.length) return;
    const storySource = r.meta?.source || 'transcript';
    const payload = JSON.stringify({ events: r.events, trimmed: !!r.meta?.trimmed, working: r.status === 'working', liveStatus: r.liveStatus || null,
      storySource, storyIdentity: `${storySource}|${r.meta?.file || ''}` });
    if (payload.length <= 220_000) { try { sessionStorage.setItem(`aios_story5_${id}`, payload); } catch {} } // key must match story-view.js STORY_CACHE_KEY (v5)
  }).catch(() => _prefetched.delete(id));
}

// ---- command palette (⌘K) -------------------------------------------------------------------------
const SCREENS = [['Inbox', './'], ['Projects', 'projects'], ['Decisions', 'decisions'], ['Records', 'records'], ['Usage', 'usage'], ['Health', 'health'], ['Settings', 'settings']];
function paletteItems(q) {
  const items = [];
  for (const [label, href] of SCREENS) items.push({ kind: 'go', label, run: () => navigate(href) });
  items.push({ kind: 'action', label: 'New session', run: () => { closePalette(); openLaunch(); } });
  items.push({ kind: 'action', label: 'Re-auth CLIs', run: () => (location.href = 'auth') });
  for (const s of home.sessions || []) {
    if (!['starting', 'working', 'waiting'].includes(s.status)) continue;
    items.push({ kind: 'session', label: shortTitle(s), sub: (s.summary || '').slice(0, 60), run: () => navigate(`session?id=${s.id}`) });
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
// opts: { projectId } preselects an existing project (Projects-page row action); { path } preselects
// "+ new project…" with the path prefilled. Both optional — the plain open picks the first project,
// or "+ new project…" on a fresh install with none.
let stateCache = null;
let launchOptionsAt = 0;
let launchOptionsPromise = api('api/launch-options').then((r) => { stateCache = r; launchOptionsAt = Date.now(); return r; }).catch(() => { launchOptionsPromise = null; return null; });
export function getLaunchOptions() {
  if (stateCache && Date.now() - launchOptionsAt < 30000) return Promise.resolve(stateCache);
  if (!stateCache && launchOptionsPromise) return launchOptionsPromise;
  launchOptionsPromise = api('api/launch-options').then((r) => { stateCache = r; launchOptionsAt = Date.now(); return r; }).catch(() => { launchOptionsPromise = null; return null; });
  return launchOptionsPromise;
}
export async function openLaunch(opts = {}) {
  document.body.classList.remove('dk-drawer'); // launched from the phone drawer: close it so the modal isn't buried under it
  document.getElementById('dk-launch')?.remove();
  const m = document.createElement('div');
  m.className = 'dk-palette';
  m.id = 'dk-launch';
  m.setAttribute('data-dk-launch', '');
  m.innerHTML = '<div class="dk-palette-box dk-launch-box"><div class="dk-launch-h">New session</div><div class="dk-hint">Loading session options…</div></div>';
  document.body.appendChild(m); // modal appears immediately; only its small option list loads asynchronously
  stateCache = await getLaunchOptions() || { projects: [], tools: [] };
  if (!m.isConnected) return;
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
      <div class="dk-field">Task
        <span class="dk-task-wrap">
          <textarea id="nl-task" rows="4" placeholder="What should the agent do? Be concrete — repo, goal, done-when."></textarea>
          <button type="button" id="nl-mic" class="dk-mic" aria-label="Dictate the task"></button>
        </span>
        <span class="dk-mic-status" id="nl-mic-status" aria-live="polite"></span>
      </div>
      <div class="dk-launch-foot">
        <button class="dk-reply-btn" id="nl-example">use an example</button>
        <span class="dk-hint" id="nl-gate"></span>
        <button class="dk-reply-btn" id="nl-cancel">Cancel</button>
        <button class="dk-new" id="nl-go" data-dk-launch-go>Launch</button>
      </div>
    </div>`;
  const q = (sel) => m.querySelector(sel);
  const toolBtns = [...m.querySelectorAll('#nl-tool [data-tool]')];
  const fillModels = () => {
    const t = tools.find((x) => x.id === (toolBtns.find((b) => b.classList.contains('on'))?.dataset.tool));
    q('#nl-model').innerHTML = (t?.models || []).map((mo) => `<option value="${esc(mo.id || mo)}" ${String(mo.id || mo) === String(t.model) ? 'selected' : ''}>${esc(mo.label || mo.id || mo)}</option>`).join('') || '<option value="">default</option>';
  };
  fillModels();
  for (const b of toolBtns) b.onclick = () => { toolBtns.forEach((x) => x.classList.toggle('on', x === b)); fillModels(); };
  // Visibility must be SYNCED, not only reacted to: on a fresh install with zero projects,
  // "+ new project…" is the pre-selected first option and no change event ever fires — the old
  // onchange-only wiring left the path field permanently hidden, so a first-time user could not
  // add a project from anywhere (this modal is the only add-project surface in the redesign).
  const syncNewProj = () => { q('#nl-newproj').hidden = q('#nl-project').value !== '__new'; };
  q('#nl-project').onchange = syncNewProj;
  if (opts.projectId && projects.some((p) => p.id === opts.projectId)) q('#nl-project').value = opts.projectId;
  else if (opts.newProject || opts.path) { q('#nl-project').value = '__new'; if (opts.path) q('#nl-path').value = opts.path; }
  syncNewProj();
  if (q('#nl-project').value === '__new' && !q('#nl-path').value) setTimeout(() => q('#nl-path').focus(), 0);
  q('#nl-path')?.addEventListener('input', () => { const seg = q('#nl-path').value.split('/').filter(Boolean).pop() || ''; if (!q('#nl-name').value) q('#nl-name').placeholder = seg || 'auto from path'; });
  q('#nl-example').onclick = () => { q('#nl-task').value = 'Read the failing tests, fix the root cause they expose, run the full suite, and summarize the change for review.'; };
  const mic = wireMic(q('#nl-mic'), q('#nl-task'), q('#nl-mic-status'), { hint: () => toolBtns.find((b) => b.classList.contains('on'))?.dataset.tool }); // speak the task; STT matches the selected agent
  const closeLaunch = () => { try { mic.abort(); } catch {} m.remove(); }; // never leave the mic live behind a closed modal
  q('#nl-cancel').onclick = closeLaunch;
  m.addEventListener('click', (e) => { if (e.target === m) closeLaunch(); });
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
      if (isNew) launchOptionsAt = 0;
      upsertSession(r);
      closeLaunch();
      navigate(`session?id=${r.id}`);
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
let loadPromise = null;
async function load() {
  if (loadPromise) return loadPromise;
  const requestedAtEpoch = sessionMutationEpoch;
  loadPromise = api('api/phone/home')
    .then((next) => { replaceHome(next, { requestedAtEpoch }); return true; })
    .catch(() => false)
    .finally(() => { loadPromise = null; });
  return loadPromise;
}
// Explicit operator recovery path for the Needs-you queue. SSE remains the ordinary update transport;
// this fetches the authoritative home projection immediately when the operator suspects a missed event.
export async function refreshHome() {
  return load();
}

// Mount the shell on the current page. `onData(home)` runs after each refresh (pages render their own
// main content there). `activeNav` marks the matching SYSTEM/Inbox nav row active.
export function mountShell({ onData: cb = null, activeNav = '' } = {}) {
  onData = cb;
  window.addEventListener('aios:navigate', renderSide);
  if (activeNav) for (const a of document.querySelectorAll('.dk-nav-item')) a.classList.toggle('active', a.dataset.nav === activeNav);
  // One persisted transition owns every collapse entry point (button, restore tab, shortcut). CSS turns
  // this class into --rail-width:0, so every geometry consumer releases the space together.
  const COLLAPSE_KEY = 'aios.rail.collapsed';
  const setCollapsed = (v) => { document.body.classList.toggle('dk-collapsed', v); try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch {} };
  try { document.body.classList.toggle('dk-collapsed', localStorage.getItem(COLLAPSE_KEY) === '1'); } catch {}
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#dk-palette')?.hidden ? openPalette() : closePalette(); }
    // Documented session shortcut: Cmd/Ctrl+\ toggles the same persisted collapse path as the buttons.
    if (document.body.classList.contains('session-page') && (e.metaKey || e.ctrlKey) && (e.code === 'Backslash' || e.key === '\\')) {
      e.preventDefault();
      setCollapsed(!document.body.classList.contains('dk-collapsed'));
      return;
    }
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
  // Sidebar collapse (design: "‹ collapse" in the brand row). The body class sets the ONE shared
  // --rail-width token to zero; a fixed left-edge tab restores it. Persisted per browser.
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
  // The phone-companion route lives in the drawer's SYSTEM nav (`.dk-nav-phone`, ≤720 only) — the old
  // floating bottom-right pill sat OVER table values / provider controls at every scroll end (judge-
  // blocking twice). A nav row can't cover content.
  document.querySelectorAll('.dk-nav-phone').forEach((pv) => {
    pv.onclick = (e) => { e.preventDefault(); try { const u = new URL(location.href); u.searchParams.set('phone', '1'); location.href = u.toString(); } catch { location.href = '?phone=1'; } };
  });
  // Mobile drawer controls (SYSTEM pages / desktop dashboard on a phone): a ☰ button opens the off-canvas
  // sidebar, a backdrop or any nav tap closes it. CSS gates visibility to ≤720px non-session pages.
  if (!document.getElementById('dk-menu-btn')) {
    const setDrawer = (v) => document.body.classList.toggle('dk-drawer', v);
    const mb = document.createElement('button');
    mb.id = 'dk-menu-btn'; mb.className = 'dk-menu-btn'; mb.type = 'button';
    mb.setAttribute('aria-label', 'Open menu'); mb.textContent = '☰';
    mb.onclick = () => setDrawer(!document.body.classList.contains('dk-drawer'));
    const bd = document.createElement('div'); bd.className = 'dk-drawer-backdrop';
    bd.onclick = () => setDrawer(false);
    document.body.appendChild(mb); document.body.appendChild(bd);
    document.querySelector('.dk-side')?.addEventListener('click', (e) => { if (e.target.closest('a,[data-nav]')) setDrawer(false); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
  }
  load();
  // Open the live-update stream immediately for interactive users. It is a permanent in-flight request,
  // so automated/headless verification (which waits for network-idle) gets a longer defer before opening
  // exactly the same stream.
  const openStream = () => {
    try {
      const ev = new EventSource('api/events');
      ev.addEventListener('session-status', (e) => {
        let payload;
        try { payload = JSON.parse(e.data || '{}'); } catch { return; }
        if (!payload?.session) return;
        const row = upsertSession({ ...payload, id: payload.session });
        for (const cb of sessionEventSubs) { try { cb(payload, row); } catch {} }
      });
    } catch {}
  };
  // In the interactive app connect on the next task so a sub-second queued launch cannot finish before
  // the browser starts listening. Automation keeps the delay because its network-idle assertion cannot
  // complete while an EventSource is open.
  const sseDefer = navigator.webdriver ? 20000 : 0;
  setTimeout(() => (window.requestIdleCallback || ((f) => f()))(openStream), sseDefer);
  // Lost SSE events recover eventually, but ordinary status/activity changes never hit this path.
  const recovery = setInterval(() => { if (!document.hidden) load(); }, 120000);
  addEventListener('pagehide', () => clearInterval(recovery), { once: true });
}
