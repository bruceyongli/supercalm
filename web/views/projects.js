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
    .pj-rel { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px; font-size: 11.5px; }
    .pj-rel input { background: #0d1219; border: 1px solid #22303f; border-radius: 6px; color: #c9d4e0; padding: 3px 7px; font-size: 11px; font-family: 'JetBrains Mono', monospace; }
    .pj-rel .pj-rel-url { flex: 1; min-width: 150px; }
    .pj-rel .pj-rel-exp { width: 180px; }
    .pj-rel-status { font-weight: 600; color: #5c6675; }
    .pj-rel-btn { background: #16202c; border: 1px solid #2a3a4c; border-radius: 6px; color: #9fb0c0; padding: 3px 9px; cursor: pointer; font-size: 11px; }
    .pj-rel-btn:hover { border-color: #2fd6be; color: #d7e2ee; }
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
        <div class="pj-rel" data-pj-rel="${esc(p.project_id)}" title="Release check: AIOS periodically fetches this live URL and verifies the marker is present, alerting you if the live product goes stale/wrong after a deploy (the '3-days-serving-the-old-UI' class). Prefer the DIRECT deployment URL over a CDN-cached custom domain.">
          <span class="pj-rel-status" data-rel-status="${esc(p.project_id)}">○ release check</span>
          <input class="pj-rel-url" data-rel-url="${esc(p.project_id)}" placeholder="live URL to verify" spellcheck="false" autocomplete="off">
          <input class="pj-rel-exp" data-rel-exp="${esc(p.project_id)}" placeholder="expected marker (build id / component / version)" spellcheck="false" autocomplete="off">
          <button class="pj-rel-btn" data-rel-check="${esc(p.project_id)}">check now</button>
        </div>
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
  // Release-check config: reflect status, save on change, check-now button, load state after paint.
  const relStatus = (pid, t) => {
    const el = document.querySelector(`[data-rel-status="${pid}"]`);
    if (!el) return;
    const s = t?.last_status && t?.live_url ? t.last_status : (t?.live_url ? 'unknown' : 'off');
    const map = { ok: ['#2fd6be', '● current'], stale: ['#e2b23e', '⚠ stale/wrong'], down: ['#e5484d', '✕ unreachable'], unknown: ['#8a95a5', '○ not checked yet'], off: ['#5c6675', '○ release check'] };
    const [c, label] = map[s] || map.off;
    el.style.color = c;
    el.textContent = label + (t?.last_detail && (s === 'stale' || s === 'down') ? ` — ${String(t.last_detail).slice(0, 60)}` : '');
    el.title = t?.last_checked ? `checked ${fmtAgo(t.last_checked)} ago` : '';
  };
  const saveRel = (pid) => {
    const url = document.querySelector(`[data-rel-url="${pid}"]`)?.value.trim() || '';
    const expect = document.querySelector(`[data-rel-exp="${pid}"]`)?.value || '';
    return api(`api/project/${pid}/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ live_url: url, expect }) });
  };
  for (const i of document.querySelectorAll('[data-rel-url],[data-rel-exp]')) i.onchange = async () => {
    const pid = i.dataset.relUrl || i.dataset.relExp;
    try { const r = await saveRel(pid); relStatus(pid, r?.target); } catch (e) { const el = document.querySelector(`[data-rel-status="${pid}"]`); if (el) { el.style.color = '#e5484d'; el.textContent = '✕ ' + String(e.message || 'save failed').slice(0, 40); } }
  };
  for (const b of document.querySelectorAll('[data-rel-check]')) b.onclick = async () => {
    const pid = b.dataset.relCheck, prev = b.textContent;
    b.textContent = 'checking…'; b.disabled = true;
    try { await saveRel(pid); const r = await api(`api/project/${pid}/release/check`, { method: 'POST' }); relStatus(pid, r?.target); }
    catch (e) { const el = document.querySelector(`[data-rel-status="${pid}"]`); if (el) { el.style.color = '#e5484d'; el.textContent = '✕ ' + String(e.message || 'check failed').slice(0, 40); } }
    finally { b.textContent = prev; b.disabled = false; }
  };
  for (const p of health.graphs || []) {
    api(`api/project/${p.project_id}/release`).then((r) => {
      const t = r?.target; if (!t) return;
      const u = document.querySelector(`[data-rel-url="${p.project_id}"]`); if (u && t.live_url) u.value = t.live_url;
      const ex = document.querySelector(`[data-rel-exp="${p.project_id}"]`); if (ex && t.expect) ex.value = t.expect;
      relStatus(p.project_id, t);
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
