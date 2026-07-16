// Projects page (design handoff): header + Add project, explainer, rows with mono name +
// live-session count, path, graph chip, freshness, counts, index + new-session actions.
// Data: /api/product/health (per-project graph status) + /api/phone/home (live counts).
import { api, escapeHtml as esc, fmtAgo } from './common.js';
import { openLaunch } from './shell.js';
const $ = (s) => document.querySelector(s);

// The header "+ Add project" opens the launch modal IN PLACE on the new-project fields. It used to
// navigate to the legacy desktop page (`href="desktop"`), whose hash it relied on was never handled —
// a first-time user's only visible add-project affordance was a dead end.
const addBtn = document.querySelector('[data-pj-add]');
if (addBtn) addBtn.onclick = (e) => { e.preventDefault(); openLaunch({ newProject: true }); };

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
      </div>
      <button class="dk-reply-btn" data-pj-index="${esc(p.project_id)}">${ready ? (p.stale ? 're-index' : 'index ✓') : 'index'}</button>
      <button class="dk-new sm" data-pj-launch="${esc(p.project_id)}">+ session</button>
    </div>`;
  }).join('');
  $('#pj-list').innerHTML = rows || '<div class="dk-allclear">No projects yet — start a session and type a new path; the project is created on the spot.</div>';
  for (const b of document.querySelectorAll('[data-pj-index]')) b.onclick = async () => {
    b.textContent = 'indexing…';
    try { await api(`api/project/${b.dataset.pjIndex}/graph?rebuild=1`); b.textContent = 'indexed ✓'; setTimeout(load, 800); }
    catch (e) { b.textContent = '⚠ ' + (e.message || e).slice(0, 30); }
  };
  // "+ session" on a row opens the launch modal here with THAT project preselected (it used to
  // navigate to the legacy desktop page with a #launch= hash nothing ever read).
  for (const b of document.querySelectorAll('[data-pj-launch]')) b.onclick = () => openLaunch({ projectId: b.dataset.pjLaunch });
}
load();
