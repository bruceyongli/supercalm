// SPA health view. Mounts into #view; renders the system-health dashboard from /api/product/health and
// re-polls every 30s. Faithful port of the standalone health.js — the module-top `root`/`pill` binds are
// moved into init() so they resolve against the freshly-rendered markup, and the 30s setInterval is
// captured in a module var and cleared in teardown() so leaving the view leaks no timer.
// View contract: export init(host, params) + teardown().
import { api, escapeHtml } from '../common.js';

const HEALTH_CSS = `
      /* width:100% — the generic \`main { margin: 0 auto }\` disables flex-stretch sizing inside the SPA
         #view (auto cross-axis margins), so without it the wrap sizes to its widest table's max-content
         and the whole page clips at a phone's right edge. */
      .health-wrap { width: 100%; max-width: 1180px; margin: 0 auto; padding: 14px; }
      .health-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 14px 0; }
      .health-card { border: 1px solid #232c38; border-radius: 8px; padding: 13px; background: #10151d; min-height: 92px; }
      .health-card h2 { margin: 0 0 10px; font-size: 12px; color: #8a95a5; text-transform: uppercase; letter-spacing: 0.08em; }
      .health-num { font-size: 30px; font-weight: 800; color: #e2e8f1; line-height: 1; }
      .health-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid #202a35; }
      .health-row:first-child { border-top: 0; }
      .health-meta { color: #8a95a5; font-size: 12px; }
      .health-ok { color: #4ecb6c; }
      .health-warn { color: #f2554d; }
      .health-info { color: #e2b23e; }
      .health-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .health-table th, .health-table td { border-top: 1px solid #202a35; text-align: left; padding: 8px 6px; vertical-align: top; }
      .health-table th { color: #8a95a5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
      .health-section { border: 1px solid #232c38; border-radius: 8px; background: #10151d; padding: 13px; margin: 10px 0; }
      .health-section h2 { margin: 0 0 8px; font-size: 14px; }
      /* design's notice bar (replaces the "Issues" section): a subtle bordered callout with an area
         chip + message + optional re-index action, shown only when there are live issues. */
      .health-notice { display: flex; align-items: center; gap: 12px; border: 1px solid #3c3620; background: #14130d; border-radius: 8px; padding: 11px 13px; margin: 10px 0; }
      .health-notice.warn { border-color: #4a2622; background: #171010; }
      .health-notice .n-chip { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #e2b23e; border: 1px solid #4a3f22; background: #221d10; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
      .health-notice.warn .n-chip { color: #f2554d; border-color: #4a2622; background: #221110; }
      .health-notice .n-msg { flex: 1; min-width: 0; color: #e2e8f1; font-size: 13px; }
      .health-notice button { background: #10151d; border: 1px solid #232c38; color: #e2e8f1; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
      .health-notice button:hover { border-color: #58a6ff; }
      .health-notice button:disabled { opacity: 0.6; cursor: default; }
      @media (max-width: 800px) {
        .health-grid { grid-template-columns: 1fr; }
        /* phones: wide tables scroll inside their section; the notice's re-index action wraps under
           the message instead of running off-screen */
        .health-section { overflow-x: auto; }
        .health-notice { flex-wrap: wrap; }
        .health-row { flex-wrap: wrap; }
      }
`;

let host = null;
let root = null;
let pill = null;
let timer = null;

const esc = (s) => escapeHtml(String(s ?? ''));

function fmtAge(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function statusText(h) {
  if (!h.auth) return { cls: 'health-warn', text: 'Auth unavailable' };
  if (h.issues?.some((i) => i.severity === 'warn')) return { cls: 'health-warn', text: 'Needs attention' };
  if (h.issues?.length) return { cls: 'health-info', text: 'Notice' };
  return { cls: 'health-ok', text: 'Healthy' };
}

// Design's notice bars (yellow/red callout with an area chip + message + optional re-index),
// shown only when there are live issues — replaces the old always-present "Issues" section.
function renderNotices(issues = [], graphs = []) {
  if (!issues.length) return '';
  const canReindex = graphs.some((g) => g.stale && g.project_id);
  return issues.map((i) => `
    <div class="health-notice${i.severity === 'warn' ? ' warn' : ''}">
      <span class="n-chip">${esc(i.area)}</span>
      <span class="n-msg">${esc(i.message)}</span>
      ${i.area === 'graph' && canReindex ? '<button data-reindex>re-index</button>' : ''}
    </div>`).join('');
}

function renderAuth(auth, error) {
  if (!auth) return `<div class="health-row"><span class="health-warn">auth</span><span>${esc(error || 'unavailable')}</span></div>`;
  return [
    `<div class="health-row"><span>Mode</span><b>${esc(auth.mode)}${auth.proxyUp ? ' · proxy up' : ''}</b></div>`,
    ...(auth.providers || []).map((p) => {
      const ok = p.loggedIn || (p.id === 'antigravity' && (p.proxyLoggedIn || p.cliLoggedIn));
      return `<div class="health-row"><span>${esc(p.label || p.id)}</span><span class="${ok ? 'health-ok' : 'health-warn'}">${ok ? 'logged in' : 'missing'}${p.expiresInSec ? ` · ${Math.round(p.expiresInSec / 3600)}h` : ''}</span></div>`;
    }),
  ].join('');
}

function renderGraphs(graphs = []) {
  const rows = graphs.slice(0, 12).map((g) => `
    <tr>
      <td><b>${esc(g.name)}</b><div class="health-meta">${esc(g.path)}</div></td>
      <td class="${g.ok ? 'health-ok' : 'health-warn'}">${esc(g.status)}</td>
      <td>${g.stale ? `<span class="health-info">${esc((g.stale_reasons || []).join(', ') || 'stale')}</span>` : '<span class="health-ok">fresh</span>'}</td>
      <td>${fmtAge(g.indexed_at)}</td>
      <td>${Object.entries(g.counts || {}).slice(0, 5).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' · ') || '—'}</td>
    </tr>`).join('');
  return `<table class="health-table"><thead><tr><th>Project</th><th>Status</th><th>Freshness</th><th>Indexed</th><th>Counts</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function render(h) {
  if (!root || !pill) return;
  const st = statusText(h);
  pill.textContent = st.text;
  pill.className = 'pill ' + (st.cls === 'health-ok' ? 'go' : st.cls === 'health-warn' ? 'warn' : '');
  const s = h.sessions || {};
  root.innerHTML = `
    <section class="health-grid">
      <div class="health-card"><h2>Version</h2><div class="health-num">${esc(h.version)}</div><div class="health-meta">uptime ${esc(h.uptime_sec)}s</div></div>
      <div class="health-card"><h2>Live Sessions</h2><div class="health-num">${esc(s.live || 0)}</div><div class="health-meta">${esc(s.waiting || 0)} waiting · ${esc(s.working || 0)} working · ${esc(s.exited || 0)} exited</div></div>
      <div class="health-card"><h2>Projects</h2><div class="health-num">${esc(h.projects?.total || 0)}</div><div class="health-meta">${esc((h.graphs || []).filter((g) => g.ok).length)} graph indexes ready</div></div>
    </section>
    ${renderNotices(h.issues || [], h.graphs || [])}
    <section class="health-section"><h2>Auth</h2>${renderAuth(h.auth, h.auth_error)}</section>
    <section class="health-section"><h2>Project Graphs</h2>${renderGraphs(h.graphs || [])}</section>
  `;
  // Wire the design's re-index action: rebuild every stale project graph, then refresh.
  root.querySelectorAll('[data-reindex]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 're-indexing…';
    const stale = (h.graphs || []).filter((g) => g.stale && g.project_id);
    await Promise.all(stale.map((g) => api(`api/project/${g.project_id}/graph/rebuild`, { method: 'POST' }).catch(() => {})));
    load(true);
  }));
}

async function load(force = false) {
  if (!root || !pill) return;
  try {
    const data = await api(`api/product/health${force ? '?fresh=1' : ''}`);
    if (!root || !pill) return; // torn down mid-fetch → sentinels nulled by teardown()
    render(data);
  } catch (e) {
    if (!root || !pill) return;
    pill.textContent = 'Error';
    pill.className = 'pill out';
    root.innerHTML = `<div class="empty">Health failed: ${esc(e.message)}</div>`;
  }
}

export function init(el) {
  host = el;
  if (!document.getElementById('view-health-css')) {
    const st = document.createElement('style');
    st.id = 'view-health-css';
    st.textContent = HEALTH_CSS;
    document.head.appendChild(st);
  }
  host.innerHTML = `
    <header>
      <div class="brand"><a href=".">←</a> <h1>Health</h1></div>
      <div class="spacer"></div>
      <span class="pill" id="health-pill">…</span>
    </header>
    <main class="health-wrap" id="health-root">
      <div class="empty">Loading health…</div>
    </main>`;
  root = host.querySelector('#health-root');
  pill = host.querySelector('#health-pill');
  load();
  timer = setInterval(load, 30000);
}

export function teardown() {
  if (timer) clearInterval(timer);
  timer = null;
  host = null;
  root = null;
  pill = null;
}
