// SPA projects view. Mounts into #view; lists every repo Supercalm has worked in (graph status +
// freshness + live-session count) with index / new-session actions. Faithful port of the standalone
// projects.js — the module-top `load()` call is moved into init() so DOM lookups resolve against the
// freshly-rendered markup. No timers/streams, so teardown just nulls module state.
// View contract: export init(host, params) + teardown().
import { api, escapeHtml as esc, fmtAgo } from '../common.js';

const PROJECTS_CSS = `
    .pj-wrap { max-width: 1080px; margin: 0 auto; padding: 32px; }
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
    .pj-autopub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 18px; padding: 10px 14px; border: 1px solid #2a3340; border-radius: 10px; background: #121722; }
    .pj-autopub.on { border-color: #e2b23e88; background: #1c1a12; }
    .pj-autopub-toggle { display: flex; align-items: center; gap: 7px; cursor: pointer; color: #e9eef5; font-size: 13px; white-space: nowrap; }
    .pj-autopub-toggle input { accent-color: #e2b23e; margin: 0; }
    .pj-autopub-desc { color: #8a95a5; font-size: 12px; flex: 1; min-width: 220px; }
    .pj-autopub-note { color: #e2b23e; font-size: 12px; font-weight: 600; white-space: nowrap; }
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
      </div>
      <button class="dk-reply-btn" data-pj-index="${esc(p.project_id)}">${ready ? (p.stale ? 're-index' : 'index ✓') : 'index'}</button>
      <button class="dk-new sm" data-pj-launch="${esc(p.path)}">+ session</button>
    </div>`;
  }).join('');
  const list = $('#pj-list');
  if (!list) return;
  list.innerHTML = rows || '<div class="dk-allclear">No projects yet — start a session and type a new path; the project is created on the spot.</div>';
  for (const b of document.querySelectorAll('[data-pj-index]')) b.onclick = async () => {
    b.textContent = 'indexing…';
    try { await api(`api/project/${b.dataset.pjIndex}/graph?rebuild=1`); b.textContent = 'indexed ✓'; setTimeout(load, 800); }
    catch (e) { b.textContent = '⚠ ' + (e.message || e).slice(0, 30); }
  };
  for (const b of document.querySelectorAll('[data-pj-launch]')) b.onclick = () => (location.href = `desktop#launch=${encodeURIComponent(b.dataset.pjLaunch)}`);
  for (const c of document.querySelectorAll('[data-pj-iso]')) c.onchange = async () => {
    const prev = !c.checked;
    try { await api(`api/project/${c.dataset.pjIso}/helpers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isolation: c.checked }) }); }
    catch { c.checked = prev; } // revert the box if the write failed
  };
  // Fill each project's isolation state AFTER the initial paint — don't block the list render on N
  // helper calls (a checkbox unchecked-until-known is a fine transient).
  for (const p of health.graphs || []) {
    api(`api/project/${p.project_id}/helpers`).then((r) => {
      const box = document.querySelector(`[data-pj-iso="${p.project_id}"]`);
      if (box) box.checked = !!(r?.helpers?.isolation);
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
      <div class="pj-head"><h1>Projects</h1><a class="dk-new sm" href="desktop">+ Add via new session</a></div>
      <p class="pj-sub">Every repo Supercalm has worked in — with its code graph, freshness, and a one-click session.</p>
      <div class="pj-autopub" id="pj-autopub-wrap" hidden>
        <label class="pj-autopub-toggle"><input type="checkbox" id="pj-autopub"> <b>Autonomous deploy</b></label>
        <span class="pj-autopub-desc">Auto-merge & deploy each session's <b>approved</b> work to the live service (deterministic gate → publish → sustained health, with auto-rollback). Applies only to projects with <b>multi-session isolation</b> on. Highest-risk — off by default.</span>
        <span id="pj-autopub-note" class="pj-autopub-note"></span>
      </div>
      <div id="pj-list">loading…</div>
    </div>`;
  load();
  wireAutoPublish();
}

// Global "Autonomous deploy" capability — the autoPublish feature flag (POST /api/flags). Env-locked when
// AIOS_AUTO_PUBLISH is set (the hard kill-switch); shown disabled with a note in that case.
async function wireAutoPublish() {
  let r; try { r = await api('api/flags'); } catch { return; }
  const wrap = document.getElementById('pj-autopub-wrap');
  const box = document.getElementById('pj-autopub');
  const note = document.getElementById('pj-autopub-note');
  if (!wrap || !box) return;
  const paint = (on, locked) => {
    box.checked = on; box.disabled = !!locked; wrap.hidden = false; wrap.classList.toggle('on', on);
    note.textContent = locked ? '(locked by AIOS_AUTO_PUBLISH env)' : (on ? '● ON — approved branches deploy themselves' : '');
  };
  paint(!!(r.flags && r.flags.autoPublish), !!(r.locks && r.locks.autoPublish));
  box.onchange = async () => {
    const want = box.checked;
    try { const rr = await api('api/flags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoPublish: want }) }); paint(!!(rr.flags && rr.flags.autoPublish), !!(rr.locks && rr.locks.autoPublish)); }
    catch { box.checked = !want; }
  };
}

export function teardown() {
  host = null;
}
