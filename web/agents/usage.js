// Usage panel module — the module form of the session Usage panel for hosts that don't wire the
// desktop "legacy" loader (the phone panels sheet mounts agents by module id; `usage` had no module
// file, so the tab hard-failed with a raw import error). Read-only: quota windows, this session's
// totals, and per-model history from GET api/session/:id/usage — same endpoint and the same
// su-card/quota/model-usage classes as the desktop panel (styles.css), so it renders native anywhere.
// The desktop session view keeps its richer legacy panel (adds the editable stop-limits form).

let P = null;
let host = null;
let timer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtTokens(v) {
  const n = Number(v || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 10e9 ? 1 : 2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 10e6 ? 1 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 10e3 ? 1 : 2) + 'K';
  return String(Math.round(n));
}
const money = (v) => '$' + Number(v || 0).toFixed(Number(v || 0) >= 10 ? 2 : 4);
const percent = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(Number(v) >= 10 ? 0 : 1) + '%' : 'n/a');
function resetIn(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Number(ts) - Date.now()) / 1000));
  if (s < 60) return 'resets <1m';
  if (s < 3600) return `resets ${Math.round(s / 60)}m`;
  if (s < 86400) return `resets ${Math.round(s / 3600)}h`;
  return `resets ${Math.round(s / 86400)}d`;
}
function quotaBar(w) {
  const used = Math.max(0, Math.min(100, Number(w.usedPercent || 0)));
  const cls = used >= 90 ? 'hot' : used >= 70 ? 'warn' : '';
  return `
    <div class="quota-row">
      <div class="q-name">${esc(w.name)}</div>
      <div class="qbar ${cls}" title="${percent(used)} used"><span style="width:${used}%"></span></div>
      <div class="q-meta">${percent(used)} ${esc(resetIn(w.resetAt))}</div>
    </div>`;
}

async function load() {
  if (!P || !host) return;
  let d = null;
  try { d = await P.api(`api/session/${P.sessionId}/usage`); } catch { /* keep the last render */ }
  if (!d || !host) return;
  const usage = d.usage || {};
  const totals = usage.totals || {};
  const quota = d.quota || {};
  const windows = quota.windows || [];
  const primary = windows.filter((w) => w.name === '5h' || w.name === 'weekly');
  const quotaRows = (primary.length ? primary : windows.slice(0, 3)).map(quotaBar).join('')
    || '<div class="muted">No live quota feed for this tool.</div>';
  const currentModel = d.session?.model || usage.model || '';
  const models = (usage.byModel || []).filter((r) => r && r.name);
  const modelRows = models.map((r) => `
    <div class="model-usage-row ${currentModel && r.name === currentModel ? 'current' : ''}">
      <div class="model-usage-title"><span>${esc(r.name)}</span>${currentModel && r.name === currentModel ? '<b>current</b>' : ''}</div>
      <div class="model-usage-meta">
        <span>${fmtTokens(r.token_traffic_tokens || r.total_tokens)} traffic</span>
        <span>${fmtTokens(r.total_tokens)} reported</span>
        <span>${Number(r.events || 0)} events</span>
        <span>${money(r.estimated_cost_usd)}</span>
      </div>
    </div>`).join('') || '<div class="muted">No model-level usage recorded yet.</div>';
  const limit = d.limit || {};
  const limitNote = limit.triggered_at
    ? `Stopped: ${esc(limit.triggered_reason || 'limit reached')}`
    : limit.enabled ? 'Stop limits are active for this session.' : '';

  host.innerHTML = `
    <section class="su-card">
      <h2><span>Quota</span><span>${esc([quota.label || quota.provider || quota.tool || '', quota.modelLabel].filter(Boolean).join(' / '))}</span></h2>
      <div class="quota-list">${quotaRows}</div>
    </section>
    <section class="su-card">
      <h2><span>Current Session</span><span>${esc(d.session?.modelLabel || currentModel || '')}</span></h2>
      <div class="su-kpis">
        <div class="su-kpi"><b>${fmtTokens(totals.token_traffic_tokens)}</b><span>traffic</span></div>
        <div class="su-kpi"><b>${fmtTokens(totals.total_tokens)}</b><span>reported</span></div>
        <div class="su-kpi"><b>${fmtTokens(totals.cached_input_tokens)}</b><span>cached</span></div>
        <div class="su-kpi"><b>${money(totals.estimated_cost_usd)}</b><span>api equiv</span></div>
      </div>
      <div class="limit-note">${Number(totals.priced_events || 0)} priced · ${Number((totals.events || 0) - (totals.priced_events || 0))} inferred · ${Number(totals.unpriced_events || 0)} unpriced${limitNote ? ' · ' + limitNote : ''}</div>
    </section>
    <section class="su-card">
      <h2><span>Model History</span><span>${models.length} models</span></h2>
      <div class="model-usage-list">${modelRows}</div>
    </section>`;
}

export const panel = {
  async mount(el, papi) {
    P = papi; host = el;
    el.innerHTML = '<section class="su-card"><span class="muted">Loading usage…</span></section>';
    await load();
    timer = setInterval(load, 30_000); // usage moves slowly; SSE 'changed' also triggers update()
  },
  update() { load(); },
  unmount() { clearInterval(timer); timer = null; host = null; P = null; },
};
