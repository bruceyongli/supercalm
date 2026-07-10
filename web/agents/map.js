import { api, $, escapeHtml, fmtAgo } from '../common.js';
import { mountGraph } from './graph.js';
import { mountGraph3d } from './graph3d.js';
import { mountGraph2d } from './graph2d.js';
import { mountTimeline } from './timeline.js';
import { mountIcicle } from './icicle.js';

// Session "Graph" panel — a DETERMINISTIC, auto-built, zero-extra-LLM map of the session, parsed from the
// agent transcript (GET /api/session/:id/space): requests → subtask clusters → tool calls (+ subagents),
// nodes sized by real $/tokens/time, colored by category. One graph, two renderers: 3D (a glowing
// force-directed "galaxy", web/agents/graph3d.js) and 2D (cytoscape, web/agents/graph.js). No "Generate"
// button — it refreshes itself as the session grows.

let P = null;
let host = null;
let graph = null;
let graphView = null; // which view the currently-mounted graph belongs to (so the tree skip-guard is safe)
let space = null;
let builtAt = 0;
let sessionMeta = null;
let projectGraph = null;
let labeling = null; // global cheap-LLM labeling state + running token/$ meter ({enabled,calls,tokens,usd,model})
const mapViewParam = (() => { try { return new URLSearchParams(location.search).get('mapView') || ''; } catch { return ''; } })();
let view = mapViewParam || localStorage.getItem('aios.map.view') || 'timeline';
if (!['timeline', 'cost', 'galaxy', 'code', 'flow', 'tree', '3d', '2d'].includes(view)) view = 'timeline';
// migrate old view ids -> the new tab set (timeline default · galaxy 3D); the force-directed flow/2d hairballs
// are retired from the default tabs (files kept on disk).
if (view === 'flow' || view === 'tree') view = 'timeline';
if (view === '3d' || view === '2d') view = 'galaxy';
// 3D needs WebGL / hardware acceleration. Some browsers/VMs/blocklisted GPUs have it OFF — then the galaxy
// can't create a context, renders NOTHING, and spams the console every frame. Detect it once: never default
// to 3D, fall back to Timeline, and disable the 3D button (so the graph always shows something usable).
const MAP_WEBGL = (() => { try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))); } catch { return false; } })();
if (view === 'galaxy' && !MAP_WEBGL) view = 'timeline';
let metric = localStorage.getItem('aios.map.metric') || 'usd';
let expanded = false;
let flowFocus = null; // Flow view: which request id is expanded (its tool-work shown); null = all collapsed
let treeExpanded = new Set(); // Tree view: node ids drilled open (task -> requests -> clusters)
let treeSig = ''; // structure signature of the last tree render — skip re-render (and the reshuffle/zoom reset) when unchanged
let lastSig = ''; // structure signature of the last RENDER (any view) — skip re-render entirely when unchanged (no flash)
let index = new Map(); // node id -> { node, system } for the detail panel
let infoHidden = false; // local UI preference: close the overlay until a node is selected again
const esc = (s) => escapeHtml(s);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 44) || 'x';
const STATUS_RANK = { blocked: 3, abandoned: 3, partial: 2, done: 1 };
const worstStatus = (list) => { let w = 'done', r = 0; for (const s of list) { const k = STATUS_RANK[s] || 0; if (k > r) { r = k; w = s; } } return r ? w : ''; };

const fmtUsd = (v) => (v >= 100 ? '$' + Math.round(v) : v >= 10 ? '$' + v.toFixed(0) : '$' + (v || 0).toFixed(1));
const fmtTok = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v || 0)));
const fmtDur = (ms) => {
  const m = Math.round((ms || 0) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
};
const metricVal = (n) => (metric === 'usd' ? n.usd || 0 : metric === 'tokens' ? n.tokens || 0 : n.elapsed_ms || 0);
const fmtMetric = (n) => (metric === 'usd' ? fmtUsd(n.usd || 0) : metric === 'tokens' ? fmtTok(n.tokens || 0) + ' tok' : fmtDur(n.elapsed_ms || 0));
const trim = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
// Flow labels live INSIDE a fixed-width node. cytoscape only wraps on whitespace, so CJK (no spaces) and
// long URLs render as one giant line that overflows. Shorten URLs and inject zero-width breaks so they wrap.
function flowLabel(s, max) {
  const ZW = '​'; // zero-width space = a wrap opportunity for cytoscape
  s = String(s || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/https?:\/\/([^\s/]+)\S*/g, (_m, host) => host + '/…'); // long URL -> host/…
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  s = s.replace(/([　-鿿぀-ヿ가-힯])/g, '$1' + ZW); // break between CJK chars
  s = s.replace(/[^\s​]{14,}/g, (run) => run.replace(/(.{12})/g, '$1' + ZW)); // break long tokens/paths
  return s;
}
function sizer(values, minD, maxD) {
  const max = Math.max(1, ...values);
  return (v) => Math.round((minD + (maxD - minD) * Math.sqrt(Math.max(0, v) / max)) * 10) / 10;
}

// Cheap-LLM labels (session_labels.js) overlay the deterministic structure: a system carries an optional
// `llm = {label, result, status, relation}`. Prefer it for display; fall back to the raw first-line label.
const sysLabel = (s) => (s.llm && s.llm.label) || s.label;
const STATUS_COLOR = { done: '#3fb950', partial: '#d29922', blocked: '#f85149', abandoned: '#6e7681' };
const REL_COLOR = { 'follow-up': '#39c5bb', rework: '#ffa657', 'scope-change': '#a371f7', aside: '#58a6ff', new: '#6e7681' };
const REL_LABEL = { 'follow-up': 'follow-up', rework: 'rework', 'scope-change': 'scope change', aside: 'aside', new: 'new' };
const REL_EDGE = { 'follow-up': 'follow-up', rework: 'rework', 'scope-change': 'scope', aside: 'aside', new: '' }; // Flow backbone edge labels ('new' left blank to cut noise)
const badge = (text, color) =>
  `<span style="display:inline-block;padding:1px 6px;border-radius:9px;font-size:9px;letter-spacing:.02em;border:1px solid ${color}66;color:${color};background:${color}14">${esc(text)}</span>`;

export const panel = {
  mount(el, papi) {
    P = papi;
    host = el;
    el.classList.add('map-panel-host'); // lets CSS make the active graph panel fill the whole side aside
    // Graph canvas fills the card (sticky to the bottom edge); controls + info float over the TOP of it.
    // The info area shows the session title/goal/cost when nothing is selected, or the node detail when a
    // node is tapped — it overlays the top half of the map and scrolls if it overflows. No bottom box.
    el.innerHTML = `
      <section class="su-card map-card map-space">
        <div class="map-graph" id="map-graph"></div>
        <div class="map-top">
          <div class="map-controls" id="map-controls"></div>
          <div class="map-info" id="map-info"></div>
        </div>
      </section>`;
    load();
  },
  update() {
    load({ quiet: true });
  },
  unmount() {
    graph?.destroy();
    graph = null;
  },
};

// A signature of the STRUCTURE only (request/cluster ids + status + label length + child counts) — NOT
// timestamps or exact cost. The panel re-renders only when this changes, so idle polls, labeling churn, and
// pure cost ticks never touch the graph. (THE core "no flash" guard.)
function structSig(sp) {
  const sys = sp?.systems || [];
  const parts = [];
  for (const s of sys) {
    parts.push(s.id + '·' + ((s.llm && s.llm.status) || '') + '·' + (((s.llm && s.llm.label) || s.label || '').length) + '·' + (s.children ? s.children.length : 0) + '·' + (s.problems || 0));
    for (const c of s.children || []) parts.push(c.id + '/' + (c.count || 0) + '/' + ((c.children && c.children.length) || 0));
  }
  return parts.join('|');
}
// The detail-panel lookup (id -> {node, system}) for EVERY node, built independently of the renderer so any
// view's onSelect(id) resolves through renderInfo. (Galaxy's walkSpace also fills index with the same objects.)
function buildIndex(sp) {
  index = new Map();
  const t = sp.totals || {};
  index.set('_sun', { node: { kind: 'session', label: sp.llm_headline || sp.headline || 'Session', usd: t.usd, tokens: t.tokens, calls: t.calls, problems: t.problems }, system: null });
  for (const s of sp.systems || []) {
    index.set(s.id, { node: s, system: s });
    for (const c of s.children || []) {
      index.set(c.id, { node: c, system: s });
      for (const tn of c.children || []) index.set(tn.id, { node: tn, system: s });
    }
  }
}

async function load({ quiet = false } = {}) {
  let payload;
  try {
    payload = await api(`api/session/${P.sessionId}/space`);
  } catch (e) {
    if (!quiet) host.querySelector('#map-info').innerHTML = `<span class="muted">Graph unavailable: ${esc(e.message || String(e))}</span>`;
    return;
  }
  const row = payload.space;
  const sp = row && row.space;
  labeling = payload.labeling || null;
  // on first mount, follow the configured default view unless this browser explicitly chose one (seg click)
  // honor a server default only if it names a CURRENT tab; stale ids (3d/2d/flow/tree) fall back to timeline.
  if (!graph && !localStorage.getItem('aios.map.view') && (labeling?.default_view === 'galaxy' || labeling?.default_view === 'timeline')) view = labeling.default_view;
  renderControls(row);
  if (!sp) {
    if (view === 'code') {
      builtAt = 0;
      space = null;
      lastSig = '';
      await renderGraph();
      host.querySelector('#map-info').innerHTML = '';
      return;
    }
    if (!quiet || builtAt) {
      builtAt = 0;
      space = null;
      lastSig = '';
      graph?.destroy();
      graph = null;
      host.querySelector('#map-graph').innerHTML = '';
      host.querySelector('#map-info').innerHTML =
        '<span class="muted">Building the graph from the session log… it appears automatically as the session works. (No transcript yet, or this tool isn’t supported.)</span>';
    }
    return;
  }
  // Re-render ONLY when the structure actually changed (or the view switched) — never on a timestamp bump.
  const sig = structSig(sp);
  if (quiet && sig === lastSig && graph && graphView === view) return; // nothing changed -> no touch, no flash
  builtAt = row.built_at;
  space = sp;
  buildIndex(sp);
  await renderGraph();
  if (view === 'code') host.querySelector('#map-info').innerHTML = '';
  else if (!quiet) renderInfo(null); // a live poll keeps your open detail; only a fresh open resets it
}

// View-switch icons (injected as raw HTML into the seg label). Each carries a <title> for the tooltip.
const ICON_TIMELINE = '<svg class="seg-ico" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><title>Timeline</title><rect x="2" y="3.1" width="11" height="1.8" rx=".9"/><rect x="2" y="7.1" width="8" height="1.8" rx=".9"/><rect x="2" y="11.1" width="5" height="1.8" rx=".9"/></svg>';
const ICON_COST = '<svg class="seg-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><title>Cost</title><circle cx="8" cy="8" r="6.2"/><path d="M8 4.3v7.4M9.9 6C9.5 5.3 8.8 5 8 5c-1 0-1.8.5-1.8 1.4 0 2 3.7 1 3.7 3 0 .9-.8 1.5-1.9 1.5-.9 0-1.7-.4-2-1.1" stroke-linecap="round"/></svg>';
const ICON_3D = '<svg class="seg-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><title>3D galaxy</title><path d="M8 1.7l5.5 3.15v6.3L8 14.3 2.5 11.15v-6.3z"/><path d="M8 8.05v6.25M8 8.05l5.5-3.2M8 8.05L2.5 4.85"/></svg>';
const ICON_CODE = '<svg class="seg-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><title>Code impact</title><path d="M6 4L2.5 8 6 12M10 4l3.5 4L10 12"/><path d="M8.8 3.2L7.2 12.8"/></svg>';

// ---- controls: 3D/2D + metric toggle + tidy/fullscreen (NO generate) ----
function renderControls(row) {
  const box = host.querySelector('#map-controls');
  if (!box) return;
  const seg = (id, cur, opts) =>
    `<span class="map-seg" id="${id}">${opts.map(([v, l]) => `<button class="map-seg-btn ${v === cur ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</span>`;
  const has = row && row.space;
  const codeMode = view === 'code';
  const graphTools = has && !codeMode;
  // global AI-labeling switch + spend meter: turn naming on/off, see tokens/$ spent across all sessions
  const lab = labeling || {};
  const labOn = !!lab.enabled;
  const labSpend = lab.calls ? `${fmtUsd(lab.usd || 0)} · ${fmtTok(lab.tokens || 0)} tok · ${lab.calls} call${lab.calls > 1 ? 's' : ''}` : 'nothing yet';
  const labChip = labOn ? '' : ' off'; // lifetime spend lives in the ⚙ footer — toolbar stays quiet
  const labTitle = `AI labels ${labOn ? 'ON' : 'OFF'} — a cheap model (${esc(lab.model || 'llm')}) names each request & the session goal. Spent ${labSpend} across all sessions. Click to turn ${labOn ? 'off' : 'on'}.`;
  box.innerHTML =
    seg('map-view', view, [['timeline', ICON_TIMELINE], ['cost', ICON_COST], ['galaxy', ICON_3D], ['code', ICON_CODE]]) +
    (codeMode ? '' : seg('map-metric', metric, [['usd', '$'], ['tokens', 'tok'], ['time', 'time']])) +
    `<button class="btn ghost sm map-lbl-toggle ${labOn ? 'on' : 'off'}" id="map-label" title="${esc(labTitle)}">🏷${esc(labChip)}</button>` +
    `<button class="btn ghost sm" id="map-config" title="Graph settings — default view, labeling model &amp; prompt">⚙</button>` +
    (graphTools ? `<button class="btn ghost sm" id="map-tidy" title="Tidy layout &amp; reset the view">⛶</button>` : '') +
    (has ? `<button class="btn ghost sm" id="map-fit" title="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '⤡' : '⤢'}</button>` : '') +
    (row?.built_at ? `<span class="map-when muted">auto · ${esc(fmtAgo(row.built_at))} ago</span>` : '');
  if (!MAP_WEBGL) { const g = box.querySelector('#map-view button[data-v="galaxy"]'); if (g) { g.classList.add('seg-off'); g.title = '3D needs WebGL — turn on hardware acceleration in your browser settings'; } }
  box.querySelector('#map-view').onclick = (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v; // closest: clicks land on the inner <svg>, not the button
    if (!v || v === view) return;
    if (v === 'galaxy' && !MAP_WEBGL) return; // 3D needs WebGL (off in this browser) — stay on the current view
    view = v;
    localStorage.setItem('aios.map.view', v);
    renderControls(row);
    renderGraph();
  };
  const metricBox = box.querySelector('#map-metric');
  if (metricBox) metricBox.onclick = (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v || v === metric) return;
    metric = v;
    localStorage.setItem('aios.map.metric', v);
    renderControls(row);
    renderGraph();
  };
  box.querySelector('#map-label')?.addEventListener('click', async () => {
    const next = !labOn;
    try {
      const r = await api('api/space/labeling', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
      labeling = r.labeling || labeling;
    } catch {}
    renderControls(row);
    if (next) setTimeout(() => load({ quiet: true }), 1800); // labels begin arriving on the next sweep -> pick them up
  });
  box.querySelector('#map-config')?.addEventListener('click', () => openConfig(row));
  box.querySelector('#map-tidy')?.addEventListener('click', (e) => {
    // one "fix my view" action: re-layout where supported, then camera home. Brief pressed-state
    // feedback so an already-tidy view never reads as a dead button (the old ◎ looked broken).
    try { graph?.relayout?.(); } catch {}
    try { graph?.resetView ? graph.resetView() : graph?.fit?.(); } catch {}
    const b = e.currentTarget;
    b.classList.add('on');
    setTimeout(() => b.classList.remove('on'), 350);
  });
  box.querySelector('#map-fit')?.addEventListener('click', toggleExpand);
}

// ---- graph-agent config popover (⚙): default view, labeling model, extra prompt, enable ----
function closeConfig() { host?.querySelector('#map-config-pop')?.remove(); }
// Build the labeling-model <select> from the LIVE fleet catalog so you can switch among ALL chat models
// by condition (e.g. local qwen normally; a cloud model when spark is busy). Grouped by provider; the local
// spark group is floated to the top (free + fastest). A custom/current id not in the catalog is preserved.
function modelSelectHtml(models, current, modelDefault) {
  const groups = new Map();
  for (const m of models || []) { const k = m.provider || 'Other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const order = [...groups.keys()].sort((a, b) => (/spark|local/i.test(b) ? 1 : 0) - (/spark|local/i.test(a) ? 1 : 0));
  const known = new Set((models || []).map((m) => m.id));
  let opts = `<option value="" ${!current ? 'selected' : ''}>Default · ${esc(modelDefault || 'gemini-3.1-flash-lite')}</option>`;
  if (current && !known.has(current)) opts += `<option value="${esc(current)}" selected>${esc(current)} · custom</option>`;
  for (const prov of order) {
    opts += `<optgroup label="${esc(prov)}">` + groups.get(prov).map((m) => {
      const short = String(m.label || m.id).split(' / ').slice(1).join(' / ') || m.id;
      return `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(short)}</option>`;
    }).join('') + `</optgroup>`;
  }
  return `<select id="cfg-model">${opts}</select>`;
}
async function openConfig(row) {
  const card = host?.querySelector('.map-space');
  if (!card) return;
  if (card.querySelector('#map-config-pop')) return closeConfig(); // toggle
  // fetch the live config + full model menu; fall back to the cached labeling values if it fails
  let c = labeling || {};
  let models = [];
  try {
    const r = await api('api/space/config');
    c = r.config || c;
    models = r.models || [];
    labeling = c;
  } catch {}
  if (card.querySelector('#map-config-pop')) return; // a second click raced us
  const pop = document.createElement('div');
  pop.className = 'map-config-pop';
  pop.id = 'map-config-pop';
  pop.innerHTML = `
    <div class="map-config-h">Graph settings</div>
    <label class="map-config-row"><span>Default view</span>
      <select id="cfg-view">${[['timeline', 'Timeline'], ['galaxy', '3D galaxy']].map(([v, l]) => { const cur = c.default_view === '3d' || c.default_view === '2d' ? 'galaxy' : c.default_view === 'flow' || c.default_view === 'tree' || !c.default_view ? 'timeline' : c.default_view; return `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`; }).join('')}</select>
    </label>
    <label class="map-config-row"><span>AI labels</span>
      <input type="checkbox" id="cfg-enabled" ${c.enabled ? 'checked' : ''}>
    </label>
    <label class="map-config-row"><span>Labeling model</span>
      ${modelSelectHtml(models, c.model || '', c.model_default)}
    </label>
    <div class="map-config-note muted">Switch any time — pick a NON-Claude model to keep labeling off your Claude rate limits; local spark models (qwen…) are free &amp; fastest.</div>
    <label class="map-config-col"><span>Extra labeling instructions <em class="muted">(optional)</em></span>
      <textarea id="cfg-prompt" rows="3" placeholder="e.g. prefer terse labels; keep status strict; note perf wins">${esc(c.prompt_extra || '')}</textarea>
    </label>
    <div class="map-config-foot">
      <span class="muted">${c.calls || 0} calls · ${esc(fmtUsd(c.usd || 0))} · uses ${esc(c.model_active || c.model_default || 'llm')}</span>
      <span class="map-config-btns"><button class="btn ghost sm" id="cfg-cancel">Close</button><button class="btn sm" id="cfg-save">Save</button></span>
    </div>`;
  card.appendChild(pop);
  pop.querySelector('#cfg-cancel').onclick = closeConfig;
  pop.querySelector('#cfg-save').onclick = async () => {
    const body = {
      default_view: pop.querySelector('#cfg-view').value,
      enabled: pop.querySelector('#cfg-enabled').checked,
      model: pop.querySelector('#cfg-model').value.trim(),
      prompt_extra: pop.querySelector('#cfg-prompt').value,
    };
    try {
      const r = await api('api/space/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      labeling = r.config || labeling;
    } catch (e) {
      pop.querySelector('.map-config-foot .muted').textContent = 'Save failed: ' + (e.message || e);
      return;
    }
    // apply the new default view live: clear this browser's override so it follows the default
    if (body.default_view && body.default_view !== view) {
      localStorage.removeItem('aios.map.view');
      view = body.default_view;
      renderControls(row);
      renderGraph();
    } else {
      renderControls(row);
    }
    closeConfig();
    if (body.enabled) setTimeout(() => load({ quiet: true }), 1800); // pick up labels if just enabled
  };
}

function toggleExpand() {
  expanded = !expanded;
  host.querySelector('.map-card')?.classList.toggle('map-expanded', expanded);
  document.body.classList.toggle('map-expanded-open', expanded);
  if (expanded) window.addEventListener('keydown', onExpandKey);
  else window.removeEventListener('keydown', onExpandKey);
  renderControls(space ? { built_at: builtAt, space } : null);
  setTimeout(() => graph?.resize?.(), 120);
}
function onExpandKey(e) {
  if (e.key === 'Escape') toggleExpand();
}

// session title + goal + cost — shown in the floating info area when no node is selected. No state badge:
// the session header bar already shows working/waiting, so repeating it here was redundant.
function summaryHtml() {
  const t = space.totals || {};
  const headline = space.llm_headline || space.headline; // cheap-LLM session summary, else the title first-line
  const goal = space.llm_goal || space.goal;
  return `
    <div class="map-triage">
      ${headline ? `<div class="map-headline">${esc(headline)}</div>` : ''}
      ${goal ? `<div class="map-goal"><span class="map-lbl">Goal</span> ${esc(goal)}</div>` : ''}
      <div class="map-trust"><span class="map-lbl">Cost</span> ${t.requests || 0} requests · ${esc(fmtUsd(t.usd || 0))} · ${esc(fmtTok(t.tokens || 0))} tok · ${t.calls || 0} tool calls${t.problems ? ` · <span class="sup-err">${t.problems} problem${t.problems > 1 ? 's' : ''}</span>` : ''}</div>
      <div class="map-hint muted">Tap a node for its cost &amp; what it did · drag to ${view === '3d' ? 'rotate' : view === '2d' ? 'explore' : 'pan'} · scroll to zoom · size = ${metric === 'usd' ? 'spend' : metric === 'tokens' ? 'tokens' : 'time'}</div>
    </div>`;
}

// walk the shared structure into a flat node/edge list + the detail index. `worldScale` switches between
// 3D world-unit sizes (glow diameters) and 2D pixel sizes (cytoscape diam).
function walkSpace(worldScale) {
  const systems = space.systems || [];
  index = new Map();
  const clusters = [];
  const turns = [];
  for (const s of systems) for (const c of s.children || []) { clusters.push(c); for (const tn of c.children || []) turns.push(tn); }
  // 3D galaxy sizes (worldScale): smaller hubs, even smaller children, with MORE scale separation between
  // levels (request ≫ cluster ≫ turn) for a clearer hierarchical overview. 2D/flow (unused) kept as-is.
  const R = worldScale ? { sys: [16, 46], cl: [6, 18], tn: [2, 6] } : { sys: [92, 168], cl: [22, 66], tn: [10, 30] };
  const sysSize = sizer(systems.map(metricVal), ...R.sys);
  const clSize = sizer(clusters.map(metricVal), ...R.cl);
  const tnSize = sizer(turns.map(metricVal), ...R.tn);
  const nodes = [];
  const edges = [];
  const fileTouch = new Map(); // file basename -> [turn ids] (to weave shared-file interconnections)
  const parentOf = new Map(); // child id -> parent id (to glow only the ACTIVE branch)
  let prev = null;
  let budget = worldScale ? 460 : 300;
  // A session "core" every request connects to, so there are NO disconnected orphan islands — including the
  // conversation-only requests ("continue", error pastes) that have no tool-work satellites and would
  // otherwise float alone. Galaxy pins it bright at center; Flow leaves it free so fcose packs the ONE
  // connected web around it (instead of packComponents tiling each request into a separate island).
  {
    const t = space.totals || {};
    const sun = space.llm_headline || space.headline || 'Session';
    index.set('_sun', { node: { kind: 'session', label: sun, usd: t.usd, tokens: t.tokens, calls: t.calls, problems: t.problems }, system: null });
    const sd = R.sys[1] * (worldScale ? 1.05 : 1.0);
    const core = { id: '_sun', kind: 'system', level: 1, category: 'ask', hub: true, color: '#a9b8d6', size: sd, diam: sd, tmw: Math.round(sd * 0.86), short: trim(sun, 26), label: worldScale ? trim(sun, 36) : flowLabel(sun, 56) };
    if (worldScale) core.pin = true;
    nodes.push(core);
  }
  for (const s of systems) {
    index.set(s.id, { node: s, system: s });
    const sd = sysSize(metricVal(s));
    const sl = sysLabel(s);
    nodes.push({ id: s.id, kind: 'system', level: 1, category: 'ask', hub: true, problem: s.problems ? '1' : '', size: sd, diam: sd, tmw: Math.round(sd * 0.84), short: trim(sl, 30), label: `${worldScale ? trim(sl, 38) : flowLabel(sl, 100)}\n${fmtMetric(s)}` });
    budget--;
    edges.push({ from: '_sun', to: s.id, core: true }); // connect EVERY request to the core -> no orphan islands
    prev = s.id;
    for (const c of s.children || []) {
      if (budget <= 0) break;
      index.set(c.id, { node: c, system: s });
      const cd = clSize(metricVal(c));
      nodes.push({ id: c.id, kind: 'cluster', level: 2, category: c.category, hub: true, problem: c.problems ? '1' : '', size: cd, diam: cd, tmw: Math.round(cd * 0.86), short: trim(c.label, 20), label: worldScale ? trim(c.label, 24) : flowLabel(c.label, 28) });
      edges.push({ from: s.id, to: c.id, hier: '1' });
      parentOf.set(c.id, s.id);
      budget--;
      for (const tn of c.children || []) {
        if (budget <= 0) break;
        index.set(tn.id, { node: tn, system: s });
        nodes.push({ id: tn.id, kind: 'turn', level: 3, category: tn.category, hub: false, problem: tn.problem ? '1' : '', size: tnSize(metricVal(tn)), diam: tnSize(metricVal(tn)), ts: tn.ts, short: trim(tn.label, 16), label: trim(tn.label, 16) });
        edges.push({ from: c.id, to: tn.id, hier: '1' });
        parentOf.set(tn.id, c.id);
        if (worldScale && tn.file) { if (!fileTouch.has(tn.file)) fileTouch.set(tn.file, []); fileTouch.get(tn.file).push(tn.id); }
        budget--;
      }
    }
  }
  // shared files become connecting hubs (like Obsidian "notes"): requests that touch the same file weave
  // together into ONE interconnected web instead of isolated dandelions (the key difference vs the refs).
  if (worldScale) {
    let fbudget = 90;
    for (const [fname, ids] of [...fileTouch].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length)) {
      if (fbudget-- <= 0) break;
      const fid = 'file:' + fname;
      index.set(fid, { node: { kind: 'file', label: fname + '  (' + ids.length + ' touches)' }, system: null });
      nodes.push({ id: fid, kind: 'file', category: 'file', hub: ids.length >= 5, problem: '', size: 7 + 3 * Math.sqrt(ids.length), short: fname, label: fname });
      for (const tid of ids) edges.push({ from: fid, to: tid, cross: true });
    }
  }
  // mark the 5 most-recent tool calls so the renderer can blink them (rank 0 = newest = fastest)
  nodes.filter((n) => n.kind === 'turn' && n.ts).sort((a, b) => b.ts - a.ts).slice(0, 5).forEach((n, i) => { n.blink = i; });
  // ONLY the active branch glows: the parents (cluster + request) of the recent actions + the active node —
  // NOT every hub. So one task lights up while it's worked on, instead of the whole map glowing.
  const glowSet = new Set();
  const climb = (id) => { let p = parentOf.get(id); while (p) { glowSet.add(p); p = parentOf.get(p); } };
  nodes.forEach((n) => { if (n.blink != null) climb(n.id); });
  if (space.active_id) { glowSet.add(space.active_id); climb(space.active_id); }
  nodes.forEach((n) => { if (glowSet.has(n.id)) n.glow = true; });
  return { nodes, edges, layout: 'fcose', spine: systems.map((s) => s.id), activeId: space.active_id || null, alwaysShow: nodes.filter((n) => n.kind === 'cluster').map((n) => n.id) };
}

// Build the STABLE SEMANTIC TREE: session theme (root) → feature → task (rounds merged) → [expand] requests
// → clusters. Deterministic order (first-occurrence) so a deterministic layout renders identical positions
// every time. Tasks aggregate cost + files (grounding) + worst status across their rounds.
function walkTree() {
  const systems = space.systems || [];
  index = new Map();
  const nodes = [];
  const edges = [];
  const rootLabel = space.llm_headline || space.headline || 'Session';
  const tot = space.totals || {};
  // group feature → task → [systems] (insertion order = first occurrence = stable)
  const feats = new Map();
  for (const s of systems) {
    const f = (s.llm && s.llm.feature) || 'Unsorted';
    const tk = (s.llm && s.llm.task) || sysLabel(s) || 'Task';
    if (!feats.has(f)) feats.set(f, new Map());
    const tasks = feats.get(f);
    if (!tasks.has(tk)) tasks.set(tk, []);
    tasks.get(tk).push(s);
  }
  // per-kind metric values for sizing
  const featVals = [], taskVals = [], reqVals = [], clVals = [];
  for (const tasks of feats.values()) {
    let fv = 0;
    for (const [tk, list] of tasks) {
      const tv = list.reduce((a, x) => a + metricVal(x), 0);
      taskVals.push(tv); fv += tv;
      const tid = 'task:' + slug([...feats.keys()].find((k) => feats.get(k) === tasks)) + '/' + slug(tk);
      if (treeExpanded.has(tid)) for (const s of list) { reqVals.push(metricVal(s)); for (const c of s.children || []) clVals.push(metricVal(c)); }
    }
    featVals.push(fv);
  }
  const fSize = sizer(featVals, 64, 116), tSize = sizer(taskVals, 34, 80), rSize = sizer(reqVals, 22, 44), cSize = sizer(clVals, 15, 30);
  const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);

  index.set('_root', { node: { kind: 'session', label: rootLabel, usd: tot.usd, tokens: tot.tokens, calls: tot.calls, problems: tot.problems }, system: null });
  nodes.push({ id: '_root', kind: 'root', level: 0, category: 'ask', hub: true, size: 132, diam: 132, tmw: 150, short: trim(rootLabel, 30), label: flowLabel(rootLabel, 64) });

  for (const [f, tasks] of feats) {
    const fid = 'feat:' + slug(f);
    const fsys = [...tasks.values()].flat();
    const fd = fSize(sum(fsys, metricVal));
    index.set(fid, { node: { kind: 'feature', label: f, requests: fsys.length, usd: sum(fsys, (x) => x.usd), tokens: sum(fsys, (x) => x.tokens), elapsed_ms: sum(fsys, (x) => x.elapsed_ms) }, system: null });
    nodes.push({ id: fid, kind: 'feature', level: 1, category: 'ask', hub: true, problem: fsys.some((s) => s.problems) ? '1' : '', size: fd, diam: fd, tmw: Math.round(fd * 1.05), short: trim(f, 22), label: flowLabel(f, 34) });
    edges.push({ from: '_root', to: fid, tree: '1' });
    for (const [tk, list] of tasks) {
      const tid = 'task:' + slug(f) + '/' + slug(tk);
      const td = tSize(sum(list, metricVal));
      const rounds = list.length;
      const files = [...new Set(list.flatMap((s) => s.outcomes || []))];
      const status = worstStatus(list.map((s) => s.llm && s.llm.status));
      const probs = sum(list, (s) => s.problems);
      index.set(tid, { node: { kind: 'task', label: tk, rounds, files, status, problems: probs, usd: sum(list, (s) => s.usd), tokens: sum(list, (s) => s.tokens), elapsed_ms: sum(list, (s) => s.elapsed_ms), systems: list }, system: list[0] });
      nodes.push({ id: tid, kind: 'task', level: 2, category: 'ask', hub: true, problem: probs ? '1' : '', status, size: td, diam: td, tmw: Math.round(td * 0.92), short: trim(tk, 22), label: flowLabel(trim(tk, 30) + (rounds > 1 ? `  ×${rounds}` : ''), 30), expanded: treeExpanded.has(tid) ? '1' : '' });
      edges.push({ from: fid, to: tid, tree: '1' });
      if (!treeExpanded.has(tid)) continue;
      for (const s of list) { // expand a task → its requests → their clusters
        index.set(s.id, { node: s, system: s });
        const rd = rSize(metricVal(s));
        nodes.push({ id: s.id, kind: 'request', level: 3, category: 'ask', problem: s.problems ? '1' : '', status: s.llm && s.llm.status, size: rd, diam: rd, tmw: Math.round(rd * 0.9), short: trim(sysLabel(s), 20), label: flowLabel(trim(sysLabel(s), 28), 24), expanded: treeExpanded.has(s.id) ? '1' : '' });
        edges.push({ from: tid, to: s.id, tree: '1' });
        if (!treeExpanded.has(s.id)) continue;
        for (const c of s.children || []) {
          index.set(c.id, { node: c, system: s });
          const cd = cSize(metricVal(c));
          nodes.push({ id: c.id, kind: 'cluster', level: 4, category: c.category, problem: c.problems ? '1' : '', size: cd, diam: cd, tmw: Math.round(cd * 0.9), short: trim(c.label, 16), label: flowLabel(trim(c.label, 18), 18) });
          edges.push({ from: s.id, to: c.id, tree: '1' });
        }
      }
    }
  }
  return { nodes, edges, layout: 'breadthfirst', tree: true };
}
// a cheap signature of the tree STRUCTURE (feature/task buckets + expand state) — re-render only when it
// changes, so an active session's poll updates don't reshuffle the layout or reset your pan/zoom.
function treeSigOf() {
  const sys = space?.systems || [];
  return sys.map((s) => `${(s.llm && s.llm.feature) || '?'}|${(s.llm && s.llm.task) || s.label || '?'}`).join(';') + '#' + [...treeExpanded].sort().join(',');
}
// Tree click: drill open/closed (task → requests → clusters) and show the node's detail.
function onTreeSelect(d) {
  if (!d) { renderInfo(null); return; }
  renderInfo(d.id);
  if (d.kind === 'task' || d.kind === 'request') {
    if (treeExpanded.has(d.id)) treeExpanded.delete(d.id); else treeExpanded.add(d.id);
    treeSig = ''; // force the rebuild
    setTimeout(renderGraph, 0);
  }
}

function sessionProject(s) {
  s = s?.session || s || {};
  return s.project || (s.project_id ? { id: s.project_id, name: '' } : null);
}

async function ensureSessionMeta(force = false) {
  if (sessionMeta && !force) return sessionMeta;
  const r = await api(`api/session/${P.sessionId}`);
  sessionMeta = r?.session || r || {};
  return sessionMeta;
}

async function loadProjectGraph({ force = false, forceSession = false } = {}) {
  const s = await ensureSessionMeta(forceSession);
  const project = sessionProject(s);
  if (!project?.id) {
    projectGraph = { projectId: null, projectName: '', error: 'This session is not attached to a project.' };
    return projectGraph;
  }
  if (!force && projectGraph?.projectId === project.id) return projectGraph;
  try {
    const r = await api(`api/project/${encodeURIComponent(project.id)}/graph/impact`);
    projectGraph = {
      projectId: project.id,
      projectName: project.name || '',
      impact: r.impact || null,
      fetchedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    projectGraph = { projectId: project.id, projectName: project.name || '', error: e.message || String(e), fetchedAt: Date.now() };
  }
  return projectGraph;
}

function countPills(counts) {
  const order = ['file', 'route', 'agent', 'mcp_tool', 'manifest'];
  const rows = order.filter((k) => counts?.[k]).map((k) => [k, counts[k]]);
  for (const [k, v] of Object.entries(counts || {})) if (!order.includes(k) && v) rows.push([k, v]);
  return rows.length
    ? `<div class="pg-counts">${rows.map(([k, v]) => `<span><b>${esc(v)}</b> ${esc(k.replace('_', ' '))}</span>`).join('')}</div>`
    : '';
}

function changedFilesHtml(files) {
  if (!files?.length) return '<div class="pg-empty">No working-tree changes detected.</div>';
  return `<ul class="pg-file-list">${files.slice(0, 40).map((f) => `<li><span class="pg-file-status">${esc(f.status || '?')}</span><code>${esc(f.path)}</code></li>`).join('')}${files.length > 40 ? `<li class="pg-empty">+${files.length - 40} more</li>` : ''}</ul>`;
}

function affectedGroupsHtml(affected) {
  if (!affected?.length) return '<div class="pg-empty">No affected routes, agents, MCP tools, or manifests found for the current changes.</div>';
  const groups = new Map();
  for (const s of affected) {
    const key = s.type || 'surface';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const order = ['route', 'agent', 'mcp_tool', 'manifest'];
  const keys = [...order.filter((k) => groups.has(k)), ...[...groups.keys()].filter((k) => !order.includes(k)).sort()];
  return keys.map((k) => {
    const rows = groups.get(k) || [];
    return `<section class="pg-group">
      <div class="pg-group-head"><span>${esc(k.replace('_', ' '))}</span><b>${rows.length}</b></div>
      <ul class="pg-surface-list">${rows.map((s) => `<li class="pg-surface">
        <span class="pg-conf pg-conf-${esc(s.confidence || 'unknown')}">${esc(s.confidence || 'unknown')}</span>
        <div class="pg-surface-main">
          <div class="pg-surface-title">${esc(s.label || s.id || '')}</div>
          <div class="pg-surface-meta">${s.path ? `<code>${esc(s.path)}</code>` : ''}${s.reason ? `<span>${esc(s.reason)}</span>` : ''}</div>
        </div>
      </li>`).join('')}</ul>
    </section>`;
  }).join('');
}

function projectGraphHtml(state, { busy = '', note = '' } = {}) {
  if (!state) return '<div class="pg-wrap"><div class="pg-empty">Loading project graph...</div></div>';
  const disabled = busy ? 'disabled' : '';
  const toolbar = `<div class="pg-actions">
    <button class="btn sm" data-pg="rebuild" ${disabled}>${busy === 'rebuild' ? 'Rebuilding...' : 'Rebuild index'}</button>
    <button class="btn ghost sm" data-pg="refresh" ${disabled}>Refresh</button>
  </div>`;
  if (state.error) {
    return `<div class="pg-wrap">
      <div class="pg-head"><div><div class="pg-title">Project graph</div><div class="pg-sub">${esc(state.projectName || state.projectId || 'No project')}</div></div>${toolbar}</div>
      <div class="pg-alert">${esc(state.error)}</div>
      ${note ? `<div class="pg-note">${esc(note)}</div>` : ''}
    </div>`;
  }
  const impact = state.impact || {};
  const summary = impact.summary || {};
  const meta = summary.meta || {};
  const counts = summary.counts || {};
  const stale = impact.staleness || summary.staleness || {};
  const reasons = stale.reasons || [];
  const status = !impact.ok ? (impact.reason || 'not indexed') : impact.stale ? 'stale' : 'ready';
  const statusClass = !impact.ok ? 'missing' : impact.stale ? 'stale' : 'ready';
  const indexed = meta.indexed_at ? `indexed ${fmtAgo(meta.indexed_at)} ago` : 'not indexed';
  const changed = impact.changed_files || [];
  const affected = impact.affected || [];
  return `<div class="pg-wrap">
    <div class="pg-head">
      <div class="pg-head-main">
        <div class="pg-title">Project graph <span class="pg-state pg-state-${statusClass}">${esc(status)}</span></div>
        <div class="pg-sub">${esc(state.projectName || state.projectId || 'Project')} · ${esc(indexed)}${state.fetchedAt ? ` · refreshed ${esc(fmtAgo(state.fetchedAt))} ago` : ''}</div>
      </div>
      ${toolbar}
    </div>
    ${note ? `<div class="pg-note">${esc(note)}</div>` : ''}
    ${reasons.length ? `<div class="pg-warn">Stale: ${reasons.map(esc).join(', ')}</div>` : ''}
    ${countPills(counts)}
    ${!impact.ok ? `<div class="pg-empty">No index exists yet. Rebuild to create the deterministic structural index.</div>` : `
      <div class="pg-grid">
        <section class="pg-panel">
          <div class="pg-sec-head">Changed files <b>${changed.length}</b></div>
          ${changedFilesHtml(changed)}
        </section>
        <section class="pg-panel">
          <div class="pg-sec-head">Affected surfaces <b>${affected.length}</b></div>
          <div class="pg-note">${esc(impact.note || 'Direct definitions plus reverse static-import dependents.')}</div>
          ${affectedGroupsHtml(affected)}
        </section>
      </div>`}
  </div>`;
}

async function mountProjectGraph(el) {
  el.classList.add('map-graph-code');
  el.innerHTML = '<div class="pg-scroll" id="pg-scroll"></div>';
  const scroll = el.querySelector('#pg-scroll');
  const topBar = el.closest('.map-space')?.querySelector('.map-top');
  const padTop = () => { if (topBar) scroll.style.paddingTop = topBar.offsetHeight + 10 + 'px'; };
  const ro = topBar && window.ResizeObserver ? new ResizeObserver(padTop) : null;
  let busy = '';
  let note = '';
  ro?.observe(topBar);
  const draw = () => {
    scroll.innerHTML = projectGraphHtml(projectGraph, { busy, note });
    padTop();
  };
  const reload = async (opts = {}) => {
    busy = opts.busy || 'load';
    note = '';
    draw();
    await loadProjectGraph({ force: !!opts.force, forceSession: !!opts.forceSession });
    busy = '';
    draw();
  };
  scroll.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-pg]')?.dataset.pg;
    if (!act || busy) return;
    if (act === 'refresh') {
      await reload({ force: true, forceSession: true, busy: 'refresh' });
    } else if (act === 'rebuild') {
      const pid = projectGraph?.projectId || sessionProject(await ensureSessionMeta(true))?.id;
      if (!pid) { note = 'No project is attached to this session.'; draw(); return; }
      busy = 'rebuild';
      note = '';
      draw();
      try {
        await api(`api/project/${encodeURIComponent(pid)}/graph/rebuild`, { method: 'POST' });
        note = 'Index rebuilt.';
      } catch (err) {
        note = 'Rebuild failed: ' + (err.message || err);
      }
      await loadProjectGraph({ force: true, forceSession: true });
      busy = '';
      draw();
    }
  });
  await reload({ force: !projectGraph, busy: 'load' });
  return {
    resize() { padTop(); },
    update() { return false; },
    destroy() { ro?.disconnect(); el.classList.remove('map-graph-code'); el.innerHTML = ''; },
  };
}

async function renderGraph() {
  const el = host?.querySelector('#map-graph');
  if (!el || (!space && view !== 'code')) return;
  if (view === 'galaxy' && !MAP_WEBGL) { view = 'timeline'; localStorage.setItem('aios.map.view', 'timeline'); } // 3D unsupported here -> never mount the galaxy
  const dbg = (() => { try { return new URLSearchParams(location.search).has('mapdebug'); } catch { return false; } })();
  // Already mounted on this view and it supports incremental update -> grow in place (no destroy, no flash,
  // no reposition, no camera reset). This is the path the live poll takes once the graph is up.
  if (graph && graphView === view && graph.update) {
    try {
      const data = view === 'galaxy' ? walkSpace(true) : space; // galaxy consumes the walked node/edge list
      const ok = graph.update(data, { metric }) !== false; // galaxy returns false to request a clean remount
      if (ok) { lastSig = structSig(space); if (dbg) window.__mapRenders = (window.__mapRenders || 0) + 1; return; }
    } catch (e) { /* fall through to remount */ }
    try { graph.destroy(); } catch {} graph = null;
  }
  graph?.destroy();
  graph = null;
  el.classList.toggle('map-graph-3d', view === 'galaxy'); // the galaxy renderer paints its own dark canvas
  try {
    if (view === 'code') {
      el.classList.remove('map-graph-3d', 'map-graph-cost', 'map-graph-timeline');
      host.querySelector('#map-info').innerHTML = '';
      graph = await mountProjectGraph(el);
      if (dbg) { window.__mapGraph = graph; window.__projectGraph = projectGraph; }
    } else if (view === 'galaxy') {
      const wd = walkSpace(true);
      graph = await mountGraph3d(el, wd, { onSelect: (d) => renderInfo(d?.id || null) });
      if (dbg) { window.__mapGraph = graph; window.__mapNodes = wd.nodes; window.__mapInfo = renderInfo; }
      setTimeout(() => { try { graph?.resize?.(); } catch {} }, 200); // container may have sized after mount
    } else if (view === 'cost') {
      // Cost icicle: deterministic HTML bands sized by $/tokens/time share — "where did the money go".
      graph = mountIcicle(el, space, { onSelect: (d) => renderInfo(d?.id || null), metric });
      if (dbg) { window.__mapGraph = graph; window.__mapInfo = renderInfo; }
    } else {
      // Timeline (default): deterministic, append-only HTML rows — never flashes, existing rows never move.
      graph = mountTimeline(el, space, { onSelect: (d) => renderInfo(d?.id || null) });
      if (dbg) { window.__mapGraph = graph; window.__mapInfo = renderInfo; }
    }
    graphView = view;
    lastSig = structSig(space);
    if (dbg) window.__mapRenders = (window.__mapRenders || 0) + 1;
  } catch (e) {
    // A failed mount (esp. the galaxy) must NOT poison the next render: tear down any partial graph and reset
    // state so switching back to timeline/cost re-mounts cleanly into a fresh container.
    try { graph?.destroy?.(); } catch {}
    graph = null;
    graphView = '';
    el.classList.remove('map-graph-3d');
    el.innerHTML = `<span class="sup-err">Graph failed: ${esc(e.message || String(e))}</span>`;
  }
}

// Flow click: show the node's detail, and on a REQUEST node expand its tool-work (collapse any other);
// a background click collapses everything. Rebuild is deferred so we don't tear down cytoscape mid-tap.
function onFlowSelect(d) {
  if (!d) {
    renderInfo(null);
    if (flowFocus) { flowFocus = null; setTimeout(renderGraph, 0); }
    return;
  }
  renderInfo(d.id);
  if (d.kind === 'system') {
    flowFocus = flowFocus === d.id ? null : d.id; // toggle this request's expansion
    setTimeout(renderGraph, 0);
  }
}

// ---- floating info area: session summary when nothing is selected, node detail when a node is tapped ----
function infoChrome(body) {
  return `<button class="map-info-close" id="map-info-close" title="Hide info panel" aria-label="Hide info panel">&times;</button>${body}`;
}
function setInfoHtml(box, body) {
  box.innerHTML = infoChrome(body);
  box.querySelector('#map-info-close')?.addEventListener('click', () => {
    infoHidden = true;
    box.innerHTML = '';
  });
}
function renderInfo(id) {
  const box = host?.querySelector('#map-info');
  if (!box || !space) return;
  if (view === 'code') {
    box.innerHTML = '';
    return;
  }
  if (id) infoHidden = false; // selecting a node re-opens details after the panel was closed
  if (infoHidden && !id) {
    box.innerHTML = '';
    return;
  }
  const entry = id ? index.get(id) : null;
  if (!entry) {
    setInfoHtml(box, summaryHtml()); // title / goal / cost
    return;
  }
  const n = entry.node;
  const bits = [];
  if (n.usd != null) bits.push(fmtUsd(n.usd));
  if (n.tokens) bits.push(fmtTok(n.tokens) + ' tok');
  if (n.elapsed_ms) bits.push(fmtDur(n.elapsed_ms));
  if (n.calls) bits.push(n.calls + ' call' + (n.calls > 1 ? 's' : ''));
  const cost = bits.length ? `<div class="map-ask-result"><span class="map-cost">${esc(bits.join(' · '))}</span></div>` : '';
  const files = (n.outcomes || []).length ? `<div class="map-ctx-h">Files changed</div><ul class="map-ctx">${n.outcomes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '';
  const src = n.source ? `<button class="btn ghost sm" id="map-src">View transcript slice</button><pre class="map-src-pre" id="map-src-pre" hidden></pre>` : '';

  if (n.kind === 'task') {
    // a feature's task: the merged rounds, status, file-grounding (which code it touched), cost
    const st = n.status ? badge(n.status, STATUS_COLOR[n.status] || '#6e7681') : '';
    const fileList = (n.files || []).length ? `<div class="map-ctx-h">Touched files</div><ul class="map-ctx">${n.files.slice(0, 12).map((f) => `<li>${esc(f)}</li>`).join('')}${n.files.length > 12 ? `<li class="muted">+${n.files.length - 12} more</li>` : ''}</ul>` : '';
    const rounds = (n.systems || []).map((s) => `<li>${s.llm && s.llm.relation && s.llm.relation !== 'new' ? `<span class="map-rel">${esc(s.llm.relation)}</span> ` : ''}${esc(sysLabel(s))}${s.llm && s.llm.status ? ` <span class="muted">· ${esc(s.llm.status)}</span>` : ''}</li>`).join('');
    setInfoHtml(box, `
      <div class="map-node-detail">
        <div class="map-node-head"><span class="map-node-kind kind-ask">task</span>${n.problem ? '<span class="map-needs-badge">problem</span>' : ''}${st}${n.rounds > 1 ? badge(n.rounds + ' rounds', '#7c8bff') : ''}</div>
        <p class="map-sys-title">${esc(n.label || '')}</p>
        ${cost}${fileList}
        <div class="map-ctx-h">Rounds (${n.rounds})</div><ul class="map-ctx">${rounds}</ul>
      </div>`);
  } else if (n.kind === 'feature') {
    setInfoHtml(box, `
      <div class="map-node-detail">
        <div class="map-node-head"><span class="map-node-kind kind-ask">feature</span>${n.problem ? '<span class="map-needs-badge">problem</span>' : ''}</div>
        <p class="map-sys-title">${esc(n.label || '')}</p>
        <div class="map-sys-result">${n.requests || 0} request${n.requests > 1 ? 's' : ''} · click to expand its tasks</div>
        ${cost}
      </div>`);
  } else if (n.kind === 'session') {
    setInfoHtml(box, summaryHtml());
  } else if (n.kind === 'system') {
    // a user request: show the cheap-LLM summary (label + outcome) and how it relates to the prior request,
    // with the verbatim ask underneath. Falls back to the raw first-line when not yet labeled.
    const llm = n.llm || null;
    const badges = [];
    if (llm?.status) badges.push(badge(llm.status, STATUS_COLOR[llm.status] || '#6e7681'));
    if (llm?.relation && llm.relation !== 'new') badges.push(badge(REL_LABEL[llm.relation] || llm.relation, REL_COLOR[llm.relation] || '#6e7681'));
    setInfoHtml(box, `
      <div class="map-node-detail">
        <div class="map-node-head">
          <span class="map-node-kind kind-ask">request</span>
          ${n.problem ? '<span class="map-needs-badge">problem</span>' : ''}
          ${badges.join(' ')}
        </div>
        <p class="map-sys-title">${esc((llm && llm.label) || n.label || '')}</p>
        ${llm?.result ? `<div class="map-sys-result">${esc(llm.result)}</div>` : ''}
        ${n.detail ? `<div class="map-ctx-h">Asked</div><p class="map-sys-ask">${esc(trim(n.detail, 280))}</p>` : ''}
        ${cost}${files}${src}
      </div>`);
  } else {
    setInfoHtml(box, `
      <div class="map-node-detail">
        <div class="map-node-head">
          <span class="map-node-kind kind-${esc(n.category || n.kind || '')}">${esc(n.category || n.kind || 'node')}</span>
          ${n.problem ? '<span class="map-needs-badge">problem</span>' : ''}
          ${n.evidence ? `<span class="map-ev map-ev-${esc(n.evidence)}">${n.evidence === 'verified' ? '✓ verified' : '⚠ claimed'}</span>` : ''}
        </div>
        <p>${esc(n.label || '')}</p>
        ${cost}${files}${src}
      </div>`);
  }
  const srcBtn = box.querySelector('#map-src');
  if (srcBtn) srcBtn.onclick = () => showSource(id);
}

async function showSource(id) {
  const pre = host.querySelector('#map-src-pre');
  if (!pre) return;
  pre.hidden = false;
  pre.textContent = 'Loading…';
  try {
    const r = await api(`api/session/${P.sessionId}/space/source/${encodeURIComponent(id)}`);
    pre.textContent = r.slice?.text || '(no source for this node)';
  } catch (e) {
    pre.textContent = 'Failed: ' + (e.message || e);
  }
}
