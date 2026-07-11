import { $, api, escapeHtml } from './common.js';

const fullFmt = new Intl.NumberFormat();
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const el = {
  range: $('#f-range'),
  tool: $('#f-tool'),
  source: $('#f-source'),
  model: $('#f-model'),
  project: $('#f-project'),
  q: $('#f-q'),
  summary: $('#summary'),
  scanMsg: $('#scan-msg'),
  subsMsg: $('#subs-msg'),
  refresh: $('#refresh'),
  rescan: $('#rescan'),
  subs: $('#subs'),
  agyNative: $('#agy-native'),
  cards: $('#cards'),
  costCard: $('#cost-card'),
  quotaCard: $('#quota-card'),
  burnCard: $('#burn-card'),
  topProjects: $('#top-projects'),
  topModels: $('#top-models'),
  quotaImpact: $('#quota-impact'),
  bySession: $('#by-session'),
  byTool: $('#by-tool'),
  bySource: $('#by-source'),
  byModel: $('#by-model'),
  summaries: $('#summaries'),
  recent: $('#recent'),
  priceNote: $('#price-note'),
  sumChart: $('#sum-chart'),
  sumTable: $('#sum-table'),
};

let loading = false;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function fmt(v) {
  return fullFmt.format(Math.round(n(v)));
}

function short(v) {
  return compactFmt.format(n(v));
}

function money(v) {
  const x = n(v);
  if (x >= 1000000) return '$' + compactFmt.format(x);
  if (x >= 1000) return '$' + compactFmt.format(x);
  if (x >= 10) return '$' + x.toFixed(0);
  if (x > 0) return '$' + x.toFixed(2);
  return '$0';
}

function pct(v) {
  const x = Math.max(0, Math.min(100, n(v)));
  return `${Math.round(x)}%`;
}

function part(v, total) {
  return total > 0 ? pct((n(v) / total) * 100) : '0%';
}

function fmtTime(ts) {
  return ts ? dtf.format(new Date(n(ts))) : '';
}

function fmtReset(ts) {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((n(ts) - Date.now()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function query() {
  const p = new URLSearchParams();
  p.set('range', el.range.value || '7d');
  if (el.tool.value) p.set('tool', el.tool.value);
  if (el.source.value) p.set('source', el.source.value);
  if (el.model.value) p.set('model', el.model.value);
  if (el.project.value) p.set('project', el.project.value);
  if (el.q.value.trim()) p.set('q', el.q.value.trim());
  p.set('limit', '100');
  return p;
}

function optionLabel(o) {
  return o.label || o.value || o.name || '';
}

function fillOptions(select, items = []) {
  const prev = select.value;
  const rows = items
    .map((o) => ({ value: String(o.value || o.name || ''), label: String(optionLabel(o)) }))
    .filter((o) => o.value);
  select.innerHTML = '<option value="">all</option>' + rows.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  select.value = rows.some((o) => o.value === prev) ? prev : '';
}

function metric(k, v, sub = '', cls = '') {
  return `<div class="metric mini ${cls}"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>${sub ? `<div class="subtext">${escapeHtml(sub)}</div>` : ''}</div>`;
}

function renderCards(t = {}, impact = {}) {
  const priced = `${fmt(t.priced_events)} priced / ${fmt(t.unpriced_events)} unpriced`;
  el.cards.innerHTML = [
    metric('Reported total', short(t.total_tokens), `${fmt(t.total_tokens)} exact`),
    metric('Cached input', short(t.cached_input_tokens), `${part(t.cached_input_tokens, t.cached_input_tokens + t.input_tokens)} of input traffic`),
    metric('Output', short(t.output_tokens), `${short(t.reasoning_tokens)} reasoning`),
    metric('Input', short(t.input_tokens), `${fmt(t.input_tokens)} exact`),
    metric('Events', short(t.events), priced),
    metric('Agent calls', short(impact.agent_calls), `${fmt(impact.limit_events)} limit hits`),
    metric('Unpriced tokens', short(t.unpriced_tokens), 'model aliases without official rate'),
  ].join('');
  el.summary.textContent = `${money(t.estimated_cost_usd)} est`;
}

function renderOverview(data = {}) {
  const t = data.totals || {};
  const topProject = data.byProject?.[0];
  const topModel = data.byModel?.[0];
  const topImpact = data.quotaImpact?.byModel?.[0];
  const cost = n(t.estimated_cost_usd);
  const unpriced = n(t.unpriced_tokens);
  el.costCard.innerHTML = `
    <div class="k">Estimated API-equivalent cost</div>
    <div class="v">${escapeHtml(money(cost))}</div>
    <div class="subtext">${escapeHtml(short(t.total_tokens))} total / ${escapeHtml(short(t.cached_input_tokens))} cached. Subscription quota may differ.</div>
  `;
  el.quotaCard.innerHTML = `
    <div class="k">Quota status</div>
    <div class="v">loading</div>
    <div class="subtext">Checking local subscription windows.</div>
  `;
  const mini = document.getElementById('mini-stats');
  if (mini) mini.innerHTML = [
    ['total tokens', short(t.total_tokens)],
    ['cached', t.total_tokens ? Math.round(100 * n(t.cached_input_tokens) / (n(t.total_tokens) + n(t.cached_input_tokens))) + '%' : '—'],
    ['priced events', fmt(t.priced_events)],
    ['unpriced tokens', short(unpriced)],
  ].map(([k, v]) => `<div class="mini-stat"><div class="k">${k}</div><div class="v">${escapeHtml(String(v))}</div></div>`).join('');
  el.burnCard.innerHTML = `
    <div class="k">Top burner</div>
    <div class="v">${escapeHtml(topProject?.name || 'none')}</div>
    <div class="subtext">${escapeHtml(topProject ? `${money(topProject.estimated_cost_usd)} / ${part(topProject.estimated_cost_usd, cost)} cost` : 'No usage for this filter')}${topModel ? ` / ${escapeHtml(topModel.name)} top model` : ''}${topImpact ? ` / quota: ${escapeHtml(topImpact.name)} ${fmt(topImpact.agent_calls)} calls` : ''}${unpriced ? ` / ${escapeHtml(short(unpriced))} unpriced` : ''}</div>
  `;
}

function table(rows = [], { session = false } = {}) {
  if (!rows.length) return '<div class="empty">No usage yet for this filter.</div>';
  const head = session
    ? '<tr><th>Session</th><th>Cost</th><th>Model</th><th>Total</th><th>Cached</th><th>Output</th><th>Events</th></tr>'
    : '<tr><th>Name</th><th>Cost</th><th>Total</th><th>Cached</th><th>Output</th><th>Events</th></tr>';
  const body = rows
    .map((r) => {
      const name = session ? `${r.project || '(unknown)'} / ${String(r.id || '').slice(0, 8)}` : r.name || '(unknown)';
      const model = session ? `<td>${escapeHtml(r.model || '(unknown)')}</td>` : '';
      return `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(money(r.estimated_cost_usd))}</td>
          ${model}
          <td>${fmt(r.total_tokens)}</td>
          <td>${fmt(r.cached_input_tokens)}</td>
          <td>${fmt(r.output_tokens)}</td>
          <td>${fmt(r.events)}</td>
        </tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table class="ut"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function rankList(rows = [], { maxRows = 7, mode = 'cost' } = {}) {
  const sorted = rows.slice().sort((a, b) => {
    const ac = n(a.estimated_cost_usd);
    const bc = n(b.estimated_cost_usd);
    if (mode === 'cost' && ac !== bc) return bc - ac;
    return n(b.total_tokens) + n(b.cached_input_tokens) - (n(a.total_tokens) + n(a.cached_input_tokens));
  });
  const visible = sorted.slice(0, maxRows);
  if (!visible.length) return '<div class="empty">No usage yet for this filter.</div>';
  const useCostBars = mode === 'cost' && visible.some((r) => n(r.estimated_cost_usd) > 0);
  const valueOf = (r) => (useCostBars ? n(r.estimated_cost_usd) : n(r.total_tokens) + n(r.cached_input_tokens));
  const max = Math.max(...visible.map(valueOf), 1);
  return visible
    .map((r) => {
      const cost = n(r.estimated_cost_usd);
      const value = valueOf(r);
      const width = value > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
      const price = cost > 0 ? money(cost) : n(r.unpriced_tokens) > 0 ? 'unpriced' : '$0';
      const basis = useCostBars ? 'relative cost' : 'relative token volume';
      const meta = `${short(r.total_tokens)} total / ${short(r.cached_input_tokens)} cached / ${fmt(r.events)} events / ${basis}`;
      return `
        <div class="rank">
          <div class="rank-top"><div class="rank-name">${escapeHtml(r.name || '(unknown)')}</div><div class="rank-cost">${escapeHtml(price)}</div></div>
          <div class="rank-meta">${escapeHtml(meta)}</div>
          <div class="bar"><i style="width:${width.toFixed(1)}%"></i></div>
        </div>`;
    })
    .join('');
}

function impactList(rows = [], { maxRows = 8 } = {}) {
  const visible = rows
    .slice()
    .sort((a, b) => n(b.agent_calls) - n(a.agent_calls) || n(b.limit_events) - n(a.limit_events) || n(b.last_ts) - n(a.last_ts))
    .slice(0, maxRows);
  if (!visible.length) return '<div class="empty">No agent-call quota signals for this filter.</div>';
  const max = Math.max(...visible.map((r) => n(r.agent_calls)), 1);
  return visible
    .map((r) => {
      const calls = n(r.agent_calls);
      const limits = n(r.limit_events);
      const width = calls > 0 ? Math.max(2, Math.min(100, (calls / max) * 100)) : 0;
      const meta = `${fmt(calls)} agent calls / ${fmt(limits)} limit hits / last ${fmtTime(r.last_ts) || 'n/a'}`;
      return `
        <div class="rank">
          <div class="rank-top"><div class="rank-name">${escapeHtml(r.name || '(unknown)')}</div><div class="rank-cost">${escapeHtml(short(calls))}</div></div>
          <div class="rank-meta">${escapeHtml(meta)}</div>
          ${r.last_limit ? `<div class="rank-meta">${escapeHtml(r.last_limit)}</div>` : ''}
          <div class="bar ${limits ? 'bad' : ''}"><i style="width:${width.toFixed(1)}%"></i></div>
        </div>`;
    })
    .join('');
}

function windowMeter(w) {
  const used = w.usedPercent != null ? n(w.usedPercent) : 100 - n(w.remainingPercent);
  const cls = used >= 90 ? 'bad' : used >= 70 ? 'warn' : 'good';
  const reset = w.resetAt ? ` / reset ${fmtReset(w.resetAt)}` : '';
  const detail = w.usedPercent != null ? `${pct(used)} used` : `${pct(w.remainingPercent)} left`;
  return `
    <div class="meter">
      <div class="mh"><span>${escapeHtml(w.name || 'window')}</span><span>${escapeHtml(detail + reset)}</span></div>
      <div class="bar ${cls}"><i style="width:${pct(used)}"></i></div>
    </div>`;
}

function renderAgyNative(subs = []) {
  if (!el.agyNative) return;
  const agy = subs.find((s) => s.id === 'agy');
  if (!agy) {
    el.agyNative.innerHTML = '<div class="empty">No native AGY statusline snapshot yet. Start or resume an Antigravity session to capture account, model, and context telemetry.</div>';
    return;
  }
  const raw = agy.raw || {};
  const ctx = raw.context_window || {};
  const model = raw.model?.display_name || raw.model?.id || 'model not reported';
  const plan = agy.plan || 'plan not reported by agy';
  const acct = agy.account || 'account not reported';
  const ts = raw.ts ? `last ${fmtTime(raw.ts)}` : 'latest snapshot';
  const context = ctx.used_percentage != null ? windowMeter({ name: 'context window', usedPercent: ctx.used_percentage }) : '';
  const tokens = [
    ctx.total_input_tokens != null ? `${short(ctx.total_input_tokens)} input` : '',
    ctx.total_output_tokens != null ? `${short(ctx.total_output_tokens)} output` : '',
    ctx.context_window_size ? `${short(ctx.context_window_size)} window` : '',
  ].filter(Boolean).join(' / ');
  el.agyNative.innerHTML = `
    <div class="native-card">
      <div class="native-top">
        <div class="native-title">${escapeHtml(model)}</div>
        <div class="native-chip">${escapeHtml(plan)}</div>
      </div>
      <div class="native-meta">${escapeHtml([acct, raw.agent_state, ts].filter(Boolean).join(' / '))}</div>
      ${context}
      ${tokens ? `<div class="native-meta">${escapeHtml(tokens)}</div>` : ''}
      <div class="native-meta">Native AGY statusline telemetry. This is context-window usage, not exact subscription quota.</div>
    </div>`;
}

function shortProviderLabel(s) {
  const id = String(s.id || '').toLowerCase();
  if (id === 'antigravity') return 'Antigravity Proxy';
  if (id === 'gemini') return 'Gemini';
  if (id === 'aliyun') return 'Aliyun Token Plan';
  if (id === 'spark') return 'Spark local';
  return s.label || s.id || 'Provider';
}

function planLabel(s) {
  if (s.plan) return s.plan;
  if (s.quotaKind) return s.quotaKind;
  return s.ok ? 'live' : 'offline';
}

function subscriptionCard(s) {
  const windows = s.windows || [];
  const manual = s.manualUsage;
  const ctx = s.raw?.context_window;
  const contextMeter = ctx && ctx.used_percentage != null ? windowMeter({ name: 'context', usedPercent: ctx.used_percentage }) : '';
  const body = windows.length
    ? windows.map(windowMeter).join('')
    : manual
      ? windowMeter({ name: s.quotaKind || 'quota', remainingPercent: manual.percentLeft, resetAt: manual.resetsAt ? Date.parse(manual.resetsAt) : null })
      : contextMeter || '<div class="hint">No live quota window reported.</div>';
  const note = contextMeter && !windows.length && !manual ? '<div class="hint">Context telemetry, not subscription quota.</div>' : '';
  const acct = s.account ? `<div class="hint">${escapeHtml(s.account)}</div>` : '';
  return `
    <div class="sub">
      <div class="head">
        <div class="title">${escapeHtml(shortProviderLabel(s))}</div>
        <div class="plan" title="${escapeHtml(planLabel(s))}">${escapeHtml(planLabel(s))}</div>
      </div>
      ${acct}
      ${body}
      ${note}
    </div>`;
}

function worstWindow(subs = []) {
  let worst = null;
  for (const s of subs) {
    for (const w of s.windows || []) {
      const used = w.usedPercent != null ? n(w.usedPercent) : 100 - n(w.remainingPercent);
      if (!worst || used > worst.used) worst = { sub: s, window: w, used };
    }
  }
  return worst;
}

function renderSubs(data = {}) {
  const subs = data.subscriptions || [];
  const errors = data.errors || [];
  el.subsMsg.textContent = errors.length ? errors.map((e) => `${e.id}: ${e.error}`).join(' | ') : `${subs.length} provider windows`;
  renderAgyNative(subs);
  el.subs.innerHTML = subs.length ? subs.map(subscriptionCard).join('') : '<div class="empty">No subscription endpoints are reachable.</div>';

  const worst = worstWindow(subs);
  if (worst) {
    const reset = worst.window.resetAt ? `Reset in ${fmtReset(worst.window.resetAt)}.` : '';
    el.quotaCard.innerHTML = `
      <div class="k">Quota status</div>
      <div class="v">${escapeHtml(`${pct(worst.used)} used`)}</div>
      <div class="subtext">${escapeHtml(shortProviderLabel(worst.sub))} / ${escapeHtml(worst.window.name || 'window')}. ${escapeHtml(reset)}</div>
    `;
  } else {
    el.quotaCard.innerHTML = `
      <div class="k">Quota status</div>
      <div class="v">no windows</div>
      <div class="subtext">Providers are reachable, but no percentage window is exposed.</div>
    `;
  }
}

function tokenLine(r) {
  const cost = n(r.estimated_cost_usd) ? `${money(r.estimated_cost_usd)} / ` : '';
  if (r.event_type === 'usage') return `${cost}${short(r.total_tokens)} total`;
  if (r.total_tokens || r.cached_input_tokens || r.output_tokens) return `${cost}${short(r.total_tokens)} total`;
  return r.event_type || 'event';
}

function eventHtml(r) {
  const bits = [fmtTime(r.ts), r.source, [r.tool, r.model].filter(Boolean).join(' / '), r.project, tokenLine(r)].filter(Boolean);
  const session = r.session_id ? `<a class="rlink" href="session.html?id=${encodeURIComponent(r.session_id)}">session</a>` : '';
  const msg = r.message || r.cwd || r.request_id || '';
  return `
    <div class="event ${escapeHtml(r.event_type || '')}">
      <div class="eh">${bits.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}${session ? `<span>${session}</span>` : ''}</div>
      ${msg ? `<div class="msg">${escapeHtml(msg)}</div>` : ''}
    </div>`;
}

function renderEvents(target, rows = [], empty = 'No events yet for this filter.') {
  target.innerHTML = rows.length ? rows.map(eventHtml).join('') : `<div class="empty">${escapeHtml(empty)}</div>`;
}

function priceNote(pricing) {
  const sources = pricing?.sources || [];
  if (!sources.length) return '';
  return sources.map((s) => `<a class="rlink" href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.label)}</a>`).join(' / ');
}

// Condensed Summary view: a spend-by-model bar chart + a readable at-a-glance table. Reuses the same
// data as the detailed view; it's a curated, low-noise subset (the operator found the full page hard to read).
function renderSummary(data = {}) {
  const t = data.totals || {};
  if (el.sumChart) el.sumChart.innerHTML = rankList(data.byModel, { maxRows: 6 });
  const topModel = (data.byModel || []).slice().sort((a, b) => n(b.estimated_cost_usd) - n(a.estimated_cost_usd))[0];
  const topProject = data.byProject?.[0];
  const cachedPct = t.total_tokens ? Math.round((100 * n(t.cached_input_tokens)) / (n(t.total_tokens) + n(t.cached_input_tokens))) : 0;
  const rows = [
    ['Estimated cost', money(t.estimated_cost_usd)],
    ['Total tokens', short(t.total_tokens)],
    ['Output tokens', short(t.output_tokens)],
    ['Cached input', `${cachedPct}%`],
    ['Events', fmt(t.events)],
    ['Agent calls', short(data.quotaImpact?.totals?.agent_calls)],
    ['Top model', topModel ? `${topModel.name} · ${money(topModel.estimated_cost_usd)}` : '—'],
    ['Top project', topProject ? `${topProject.name} · ${money(topProject.estimated_cost_usd)}` : '—'],
  ];
  if (el.sumTable) el.sumTable.innerHTML = `<div class="sum-glance">${rows.map(([k, v]) => `<div class="sum-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join('')}</div>`;
}

function renderUsage(data) {
  renderSummary(data);
  fillOptions(el.tool, data.options?.tools);
  fillOptions(el.source, data.options?.sources);
  fillOptions(el.model, data.options?.models);
  fillOptions(el.project, data.options?.projects);
  renderOverview(data);
  renderCards(data.totals || {}, data.quotaImpact?.totals || {});
  el.topProjects.innerHTML = rankList(data.byProject);
  el.topModels.innerHTML = rankList(data.byModel);
  el.quotaImpact.innerHTML = impactList(data.quotaImpact?.byModel);
  el.bySession.innerHTML = table(data.bySession?.slice(0, 12), { session: true });
  el.byTool.innerHTML = table(data.byTool);
  el.bySource.innerHTML = table(data.bySource);
  el.byModel.innerHTML = table(data.byModel);
  renderEvents(el.summaries, data.summaries, 'No terminal Token usage summaries found.');
  renderEvents(el.recent, data.recent);
  el.priceNote.innerHTML = priceNote(data.pricing);
}

function renderLoading() {
  el.summary.textContent = 'loading';
  el.costCard.innerHTML = metric('Estimated API-equivalent cost', 'loading', 'Reading usage events.');
  el.quotaCard.innerHTML = metric('Quota status', 'loading', 'Checking subscription windows.');
  el.burnCard.innerHTML = metric('Top burner', 'loading', 'Ranking projects and models.');
  el.cards.innerHTML = ['Reported total', 'Cached input', 'Output', 'Input'].map((k) => metric(k, 'loading')).join('');
  if (el.sumChart) el.sumChart.innerHTML = '<div class="empty">Loading spend by model...</div>';
  if (el.sumTable) el.sumTable.innerHTML = '<div class="empty">Loading summary...</div>';
  el.topProjects.innerHTML = '<div class="empty">Loading project ranking...</div>';
  el.topModels.innerHTML = '<div class="empty">Loading model ranking...</div>';
  el.quotaImpact.innerHTML = '<div class="empty">Loading quota impact...</div>';
  el.agyNative.innerHTML = '<div class="empty">Loading native AGY status...</div>';
  el.subs.innerHTML = '<div class="empty">Loading subscription windows...</div>';
}

async function load() {
  if (loading) return;
  loading = true;
  el.scanMsg.textContent = 'loading...';
  renderLoading();
  const usagePromise = api(`api/usage?${query()}`);
  const subsPromise = api('api/usage/subscriptions');

  try {
    const data = await usagePromise;
    renderUsage(data);
    el.scanMsg.textContent = `updated ${fmtTime(Date.now())}`;
  } catch (e) {
    el.scanMsg.textContent = `usage failed: ${e.message}`;
  } finally {
    loading = false;
  }

  try {
    renderSubs(await subsPromise);
  } catch (e) {
    el.subsMsg.textContent = `quota failed: ${e.message}`;
    el.subs.innerHTML = '<div class="empty">Subscription windows are not reachable.</div>';
  }
}

async function rescan() {
  el.rescan.disabled = true;
  el.scanMsg.textContent = 'rescanning local logs...';
  try {
    const r = await api('api/usage/rescan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxFiles: 2000 }),
    });
    el.scanMsg.textContent = `rescan: ${fmt(r.recorded)} rows touched from ${fmt(r.files)} files`;
    await load();
  } catch (e) {
    el.scanMsg.textContent = `rescan failed: ${e.message}`;
  } finally {
    el.rescan.disabled = false;
  }
}

for (const node of [el.range, el.tool, el.source, el.model, el.project]) node.addEventListener('change', load);
el.q.addEventListener('input', () => {
  clearTimeout(el.q._t);
  el.q._t = setTimeout(load, 250);
});
el.refresh.addEventListener('click', load);
el.rescan.addEventListener('click', rescan);

// Summary (default) / Detailed view toggle — persisted. Summary shows the condensed chart + at-a-glance
// table; Detailed reveals the full breakdown (#usage-detail). The operator found the full page overloaded.
const VIEW_KEY = 'aios.usage.view';
function applyView(v) {
  document.body.classList.toggle('u-detailed', v === 'detailed');
  for (const b of document.querySelectorAll('[data-u-viewtoggle] button')) b.classList.toggle('on', b.dataset.view === v);
}
for (const b of document.querySelectorAll('[data-u-viewtoggle] button')) b.addEventListener('click', () => {
  applyView(b.dataset.view);
  try { localStorage.setItem(VIEW_KEY, b.dataset.view); } catch {}
});
let startView = 'summary';
try { if (localStorage.getItem(VIEW_KEY) === 'detailed') startView = 'detailed'; } catch {}
applyView(startView);

load();
