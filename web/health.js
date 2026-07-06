import { api, escapeHtml } from './common.js';

const root = document.getElementById('health-root');
const pill = document.getElementById('health-pill');
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

function renderIssues(issues = []) {
  if (!issues.length) return '<div class="health-row"><span class="health-ok">No current issues</span></div>';
  return issues.map((i) => `<div class="health-row"><span class="health-${esc(i.severity)}">${esc(i.area)}</span><span>${esc(i.message)}</span></div>`).join('');
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
    <section class="health-section"><h2>Issues</h2>${renderIssues(h.issues || [])}</section>
    <section class="health-section"><h2>Auth</h2>${renderAuth(h.auth, h.auth_error)}</section>
    <section class="health-section"><h2>Project Graphs</h2>${renderGraphs(h.graphs || [])}</section>
  `;
}

async function load() {
  try {
    render(await api('api/product/health'));
  } catch (e) {
    pill.textContent = 'Error';
    pill.className = 'pill out';
    root.innerHTML = `<div class="empty">Health failed: ${esc(e.message)}</div>`;
  }
}

load();
setInterval(load, 30000);
