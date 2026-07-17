// SPA projects view. Mounts into #view; lists every repo Supercalm has worked in (graph status +
// freshness + live-session count) with index / new-session actions. Faithful port of the standalone
// projects.js — the module-top `load()` call is moved into init() so DOM lookups resolve against the
// freshly-rendered markup. No timers/streams, so teardown just nulls module state.
// View contract: export init(host, params) + teardown().
import { api, escapeHtml as esc, fmtAgo } from '../common.js';
import { openLaunch } from '../shell.js';

const PROJECTS_CSS = `
    .pj-wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 32px; }
    .pj-head { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
    .pj-head h1 { font-family: 'IBM Plex Sans', sans-serif; font-size: 26px; font-weight: 600; letter-spacing: -.01em; color: #e9eef5; margin: 0; flex: 1; }
    .pj-sub { color: #8a95a5; font-size: 13px; margin: 0 0 20px; }
    .pj-row { align-items: center; }
    .pj-main { flex: 1; display: grid; gap: 3px; min-width: 0; }
    .pj-l1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pj-path { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #5c6675; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pj-counts { font-size: 11.5px; color: #8a95a5; }
    .pj-iso { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #8a95a5; cursor: pointer; margin-top: 3px; user-select: none; }
    .pj-iso input { accent-color: #2fd6be; margin: 0; }
    .pj-iso-hint { color: #5c6675; }
    .pj-pub input { accent-color: #e2b23e; }
`;

let host = null;
const $ = (s) => document.querySelector(s);

async function load() {
  let health = { projects: [] }, home = { sessions: [] };
  try { health = await api('api/product/health'); } catch {}
  try { home = await api('api/phone/home'); } catch {}
  const liveByPath = {};
  for (const s of home.sessions || []) if (s.status === 'working' || s.status === 'waiting') liveByPath[s.project_id || ''] = (liveByPath[s.project_id || ''] || 0) + 1;
  const rows = (health.graphs || []).map((p) => {
    const ready = p.status === 'ready';
    const counts = p.counts || {};
    const live = liveByPath[p.project_id] || 0;
    return `
    <div class="dk-row pj-row" data-pj-row>
      <div class="pj-main">
        <span class="pj-l1"><b class="dk-row-name">${esc(p.name)}</b>${live ? `<span class="dk-badge warn">${live} live</span>` : ''}
          <span class="dk-chip" style="color:${ready ? '#2fd6be' : '#8a95a5'};border-color:currentColor">${ready ? '● graph ready' : '○ not indexed'}</span>
          ${p.stale ? `<span class="dk-chip" style="color:#e2b23e;border-color:#e2b23e55" title="${esc((p.stale_reasons || []).join(', '))}">head changed</span>` : ''}
        </span>
        <span class="pj-path">${esc(p.path)}</span>
        <span class="pj-counts">${ready ? `${counts.file || 0} files · ${counts.route || 0} routes · indexed ${fmtAgo(p.indexed_at)} ago` : 'no code graph yet'}</span>
        <label class="pj-iso" title="Give every session on this project its own git worktree + branch so concurrent agents never clobber each other's tree; changes reach the app by merging to main. Off (default) = shared tree, you own merge/deploy.">
          <input type="checkbox" data-pj-iso="${esc(p.project_id)}"> multi-session isolation
          <span class="pj-iso-hint">— own worktree + branch per session</span>
        </label>
        <label class="pj-iso pj-pub" title="Auto-merge & deploy THIS project's approved work to the live service (deterministic gate → publish → sustained health, with auto-rollback + a circuit breaker). Requires multi-session isolation (turned on with it). Highest-risk — off by default.">
          <input type="checkbox" data-pj-pub="${esc(p.project_id)}"> autonomous deploy
          <span class="pj-iso-hint">— approved work self-deploys</span>
        </label>
      </div>
      <button class="dk-reply-btn" data-pj-index="${esc(p.project_id)}">${ready ? (p.stale ? 're-index' : 'index ✓') : 'index'}</button>
      <button class="dk-new sm" data-pj-launch="${esc(p.project_id)}">+ session</button>
    </div>`;
  }).join('');
  const list = $('#pj-list');
  if (!list) return;
  list.innerHTML = rows || '<div class="dk-allclear">No projects yet — start a session and type a new path; the project is created on the spot.</div>';
  for (const b of document.querySelectorAll('[data-pj-index]')) b.onclick = async () => {
    b.textContent = 'indexing…';
    try { await api(`api/project/${b.dataset.pjIndex}/graph/rebuild`, { method: 'POST' }); b.textContent = 'indexed ✓'; setTimeout(load, 800); }
    catch (e) { b.textContent = '⚠ ' + (e.message || e).slice(0, 30); }
  };
  // "+ session" opens the launch modal HERE with that project preselected. It used to navigate to the
  // legacy desktop page with a #launch= hash that nothing handles — a silent dead end.
  for (const b of document.querySelectorAll('[data-pj-launch]')) b.onclick = () => openLaunch({ projectId: b.dataset.pjLaunch });
  const postHelpers = (pid, patch) => api(`api/project/${pid}/helpers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  for (const c of document.querySelectorAll('[data-pj-iso]')) c.onchange = async () => {
    const pid = c.dataset.pjIso, want = c.checked;
    // isolation is a prerequisite for autonomous deploy — turning it OFF turns autonomous deploy off too.
    const patch = want ? { isolation: true } : { isolation: false, auto_publish: false };
    try { const r = await postHelpers(pid, patch); if (r?.helpers) { c.checked = !!r.helpers.isolation; const pub = document.querySelector(`[data-pj-pub="${pid}"]`); if (pub) pub.checked = !!r.helpers.auto_publish; } }
    catch { c.checked = !want; }
  };
  for (const c of document.querySelectorAll('[data-pj-pub]')) c.onchange = async () => {
    const pid = c.dataset.pjPub, want = c.checked;
    // autonomous deploy REQUIRES isolation → enabling it enables isolation too.
    const patch = want ? { auto_publish: true, isolation: true } : { auto_publish: false };
    try { const r = await postHelpers(pid, patch); if (r?.helpers) { c.checked = !!r.helpers.auto_publish; const iso = document.querySelector(`[data-pj-iso="${pid}"]`); if (iso) iso.checked = !!r.helpers.isolation; } }
    catch { c.checked = !want; }
  };
  // Fill each project's isolation + autonomous-deploy state AFTER the initial paint — don't block the list
  // render on N helper calls (checkboxes unchecked-until-known is a fine transient).
  for (const p of health.graphs || []) {
    api(`api/project/${p.project_id}/helpers`).then((r) => {
      const iso = document.querySelector(`[data-pj-iso="${p.project_id}"]`);
      const pub = document.querySelector(`[data-pj-pub="${p.project_id}"]`);
      if (iso) iso.checked = !!(r?.helpers?.isolation);
      if (pub) pub.checked = !!(r?.helpers?.auto_publish);
    }).catch(() => {});
  }
}

export function init(el) {
  host = el;
  if (!document.getElementById('view-projects-css')) {
    const st = document.createElement('style');
    st.id = 'view-projects-css';
    st.textContent = PROJECTS_CSS;
    document.head.appendChild(st);
  }
  host.innerHTML = `
    <div class="pj-wrap" data-pj>
      <div class="pj-head"><h1>Projects</h1><button class="dk-new sm" data-pj-add>+ Add project</button></div>
      <p class="pj-sub">Every repo Supercalm has worked in — with its code graph, freshness, and a one-click session.</p>
      <div id="pj-list">loading…</div>
    </div>`;
  // Add project = the launch modal opened straight on the new-project fields (path + name + first task).
  // The old header link navigated to the legacy desktop page — the redesign's only visible add-project
  // affordance was a dead end (first-time-user report, 2026-07-16).
  const add = host.querySelector('[data-pj-add]');
  if (add) add.onclick = () => openLaunch({ newProject: true });
  load();
}

export function teardown() {
  host = null;
}
