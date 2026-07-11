// Usage page — matched to the design prototype (Supercalm Desktop.dc.html): a simple page of
// 3 overview cards (cost / quota / top project) + 4 metric tiles + a BY MODEL table + a recent-log
// disclosure. The earlier filter bar, Summary/Detailed toggle, and extra breakdowns were removed on the
// operator's "make it exactly the same as the design" decision. Reuses the same /api/usage data.
import { $, api, escapeHtml } from './common.js';

const fullFmt = new Intl.NumberFormat();
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const el = {
  range: $('#f-range'),
  summary: $('#summary'),
  scanMsg: $('#scan-msg'),
  costCard: $('#cost-card'),
  quotaCard: $('#quota-card'),
  projectCard: $('#project-card'),
  cards: $('#cards'),
  byModel: $('#by-model'),
  recentLabel: $('#recent-label'),
  recentToggle: $('#recent-toggle'),
  recent: $('#recent'),
  rescan: $('#rescan'),
};

let loading = false;

// --- formatters (unchanged from the prior page) -----------------------------
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const fmt = (v) => fullFmt.format(Math.round(n(v)));
const short = (v) => compactFmt.format(n(v));
function money(v) {
  const x = n(v);
  if (x >= 1000) return '$' + compactFmt.format(x);
  if (x >= 10) return '$' + x.toFixed(0);
  if (x > 0) return '$' + x.toFixed(2);
  return '$0';
}
const pct = (v) => `${Math.round(Math.max(0, Math.min(100, n(v))))}%`;
const part = (v, total) => (total > 0 ? pct((n(v) / total) * 100) : '0%');
const fmtTime = (ts) => (ts ? dtf.format(new Date(n(ts))) : '');
function fmtReset(ts) {
  const ms = n(ts) - Date.now();
  if (ms <= 0) return 'soon';
  const h = Math.floor(ms / 3.6e6);
  const m = Math.floor((ms % 3.6e6) / 6e4);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const query = () => new URLSearchParams({ range: el.range.value || '30d' }).toString();

// --- 3 overview cards -------------------------------------------------------
function renderOverview(data) {
  const t = data.totals || {};
  const cost = n(t.estimated_cost_usd);
  const topProject = data.byProject?.[0];
  el.costCard.innerHTML = `
    <div class="k">Estimated API-equivalent cost</div>
    <div class="v">${escapeHtml(money(cost))}</div>
    <div class="subtext">${escapeHtml(short(t.total_tokens))} tokens · ${escapeHtml(short(t.cached_input_tokens))} cached · subscription quota may differ</div>`;
  el.projectCard.innerHTML = `
    <div class="k">Top project</div>
    <div class="v">${escapeHtml(topProject?.name || 'none')}</div>
    <div class="subtext">${escapeHtml(topProject ? `${part(topProject.estimated_cost_usd, cost)} of spend · ${money(topProject.estimated_cost_usd)}` : 'No usage for this range')}</div>`;
  if (el.summary) el.summary.textContent = `${money(cost)} est`;
}

// --- 4 metric tiles ---------------------------------------------------------
const metric = (k, v) => `<div class="metric mini"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
function renderTiles(data) {
  const t = data.totals || {};
  const sessions = data.bySession?.length ?? n(t.sessions);
  el.cards.innerHTML = [
    metric('Inferred tokens', short(t.total_tokens)),
    metric('Cache read', short(t.cached_input_tokens)),
    metric('Output', short(t.output_tokens)),
    metric(`Events · ${fmt(sessions)} sessions`, short(t.events)),
  ].join('');
}

// --- BY MODEL table ---------------------------------------------------------
function renderByModel(rows = []) {
  if (!rows.length) { el.byModel.innerHTML = '<div class="empty">No usage yet for this range.</div>'; return; }
  const body = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.name || '(unknown)')}</td>
      <td>${escapeHtml(money(r.estimated_cost_usd))}</td>
      <td>${fmt(r.total_tokens)}</td>
      <td>${fmt(r.cached_input_tokens)}</td>
      <td>${fmt(r.output_tokens)}</td>
    </tr>`).join('');
  el.byModel.innerHTML = `<div class="table-wrap"><table class="ut"><thead><tr><th>Model</th><th>Cost</th><th>Tokens</th><th>Cached</th><th>Output</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// --- recent raw log (disclosure) --------------------------------------------
function eventHtml(r) {
  const bits = [fmtTime(r.ts), r.source, [r.tool, r.model].filter(Boolean).join(' / '), r.project].filter(Boolean);
  return `<div class="event ${escapeHtml(r.event_type || '')}"><div class="eh">${bits.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>${r.message ? `<div class="msg">${escapeHtml(r.message)}</div>` : ''}</div>`;
}
function renderRecent(data) {
  const rows = data.recent || [];
  if (el.recentLabel) el.recentLabel.textContent = `Recent log — ${fmt(data.totals?.events)} raw pricing events`;
  el.recent.innerHTML = rows.length ? rows.map(eventHtml).join('') : '<div class="empty">No events yet.</div>';
}

// --- quota card (from subscription windows) ---------------------------------
function renderQuota(data = {}) {
  const subs = data.subscriptions || [];
  let worst = null;
  for (const s of subs) for (const w of s.windows || []) {
    const used = w.usedPercent != null ? n(w.usedPercent) : 100 - n(w.remainingPercent);
    if (!worst || used > worst.used) worst = { used, w, s };
  }
  if (worst) {
    const cls = worst.used >= 90 ? 'bad' : worst.used >= 70 ? 'warn' : 'good';
    const reset = worst.w.resetAt ? ` · reset ${fmtReset(worst.w.resetAt)}` : '';
    el.quotaCard.innerHTML = `
      <div class="k">Quota status</div>
      <div class="v">${escapeHtml(pct(worst.used))} <span class="qused">used</span></div>
      <div class="bar ${cls}"><i style="width:${pct(worst.used)}"></i></div>
      <div class="subtext">${escapeHtml((worst.s.label || worst.s.id || 'provider') + ' · ' + (worst.w.name || 'window') + reset)}</div>`;
  } else {
    el.quotaCard.innerHTML = `<div class="k">Quota status</div><div class="v">—</div><div class="subtext">No percentage window exposed.</div>`;
  }
}

async function load() {
  if (loading) return;
  loading = true;
  if (el.scanMsg) el.scanMsg.textContent = 'loading…';
  el.costCard.innerHTML = metric('Estimated API-equivalent cost', 'loading');
  el.quotaCard.innerHTML = metric('Quota status', 'loading');
  el.projectCard.innerHTML = metric('Top project', 'loading');
  try {
    const data = await api(`api/usage?${query()}`);
    renderOverview(data);
    renderTiles(data);
    renderByModel(data.byModel);
    renderRecent(data);
    if (el.scanMsg) el.scanMsg.textContent = `updated ${fmtTime(Date.now())}`;
  } catch (e) {
    if (el.scanMsg) el.scanMsg.textContent = `usage failed: ${e.message}`;
  } finally {
    loading = false;
  }
  try { renderQuota(await api('api/usage/subscriptions')); }
  catch { el.quotaCard.innerHTML = `<div class="k">Quota status</div><div class="v">—</div><div class="subtext">Subscription windows not reachable.</div>`; }
}

async function rescan() {
  if (!el.rescan) return;
  const label = el.rescan.textContent;
  el.rescan.textContent = 'rescanning…';
  try {
    const r = await api('api/usage/rescan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxFiles: 2000 }) });
    el.rescan.textContent = `rescanned ${fmt(r.recorded)} rows`;
    await load();
    setTimeout(() => { el.rescan.textContent = label; }, 4000);
  } catch { el.rescan.textContent = 'rescan failed'; }
}

el.range.addEventListener('change', load);
if (el.recentToggle) el.recentToggle.addEventListener('click', (e) => {
  e.preventDefault();
  const open = el.recent.hidden;
  el.recent.hidden = !open;
  el.recentToggle.textContent = open ? 'close ▾' : 'open ›';
});
if (el.rescan) el.rescan.addEventListener('click', (e) => { e.preventDefault(); rescan(); });

load();
