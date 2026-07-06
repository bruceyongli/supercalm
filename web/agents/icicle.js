// Cost view for the session Graph panel — the "Cost" tab. A ranked bar breakdown that answers "where did
// the money / time go" at a glance, and stays readable no matter how the spend is distributed (a width-tiled
// icicle becomes an unreadable barcode when 80+ requests each cost about the same): a "by work type" section
// (category totals) + a "top requests" section (biggest spenders, the long tail folded). Deterministic HTML,
// so it never flashes; click a request bar → onSelect({id}) → the panel's detail drawer.
//
// API mirrors the other renderers: mountIcicle(el, space, {onSelect, metric}) -> { update, destroy, resize, select }.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtUsd = (v) => (v >= 100 ? '$' + Math.round(v) : v >= 10 ? '$' + v.toFixed(0) : '$' + (v || 0).toFixed(1));
const fmtTok = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v || 0)));
const fmtDur = (ms) => { const m = Math.round((ms || 0) / 60000); if (m < 1) return '<1m'; if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); };
const trim = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const sysLabel = (s) => (s.llm && s.llm.label) || s.label || 'Request';

const CAT = { explore: '#3d7ab0', research: '#39c5bb', edit: '#3fb950', exec: '#d2a022', subagent: '#a371f7', decision: '#ffa657', plan: '#6e7aff', reason: '#586273', respond: '#4a525e', other: '#4a525e' };
const catColor = (c) => CAT[c] || CAT.other;
const STATUS_BAR = { done: '#2ea043', partial: '#d29922', blocked: '#f85149', abandoned: '#555c66' };
const mv = (n, metric) => (metric === 'tokens' ? n.tokens || 0 : metric === 'time' ? n.elapsed_ms || 0 : n.usd || 0);

function bar({ color, label, valStr, widthPct, id, selId, problem, sub }) {
  return `<div class="cost-row${id ? ' cost-click' : ''}${id && id === selId ? ' sel' : ''}${problem ? ' has-problem' : ''}"${id ? ` data-id="${esc(id)}"` : ''}>
    <div class="cost-lbl" title="${esc(label)}">${esc(label)}${sub ? `<span class="cost-sub">${esc(sub)}</span>` : ''}</div>
    <div class="cost-track"><div class="cost-fill" style="width:${Math.max(1.5, widthPct).toFixed(1)}%;background:${color}"></div></div>
    <div class="cost-val">${esc(valStr)}</div>
  </div>`;
}

function costHtml(space, metric, selId) {
  const systems = space.systems || [];
  const fmtM = (v) => (metric === 'tokens' ? fmtTok(v) + ' tok' : metric === 'time' ? fmtDur(v) : fmtUsd(v));
  const total = systems.reduce((a, s) => a + mv(s, metric), 0) || 1;
  const pct = (v) => Math.round((v / total) * 100) + '%';

  // --- by work type: sum the metric over every cluster, grouped by category ---
  const cat = new Map();
  for (const s of systems) for (const c of s.children || []) { const m = mv(c, metric); if (m <= 0) continue; const k = c.category || 'other'; cat.set(k, (cat.get(k) || 0) + m); }
  const catRows = [...cat.entries()].sort((a, b) => b[1] - a[1]);
  const catMax = catRows[0] ? catRows[0][1] : 1;
  const catBars = catRows.length
    ? catRows.map(([k, v]) => bar({ color: catColor(k), label: k, valStr: `${fmtM(v)} · ${pct(v)}`, widthPct: (v / catMax) * 100 })).join('')
    : '<div class="cost-empty">No tool spend yet.</div>';

  // --- top requests: biggest spenders, the long tail folded into one row ---
  const reqRows = systems.filter((s) => mv(s, metric) > 0).sort((a, b) => mv(b, metric) - mv(a, metric));
  const top = reqRows.slice(0, 18);
  const rest = reqRows.slice(18);
  const restSum = rest.reduce((a, s) => a + mv(s, metric), 0);
  const reqMax = top[0] ? mv(top[0], metric) : 1;
  const st = (s) => (s.problems ? 'blocked' : (s.llm && s.llm.status)) || '';
  const reqBars = top.map((s) => bar({
    color: STATUS_BAR[st(s)] || '#3b69a8', label: trim(sysLabel(s), 64), valStr: fmtM(mv(s, metric)),
    widthPct: (mv(s, metric) / reqMax) * 100, id: s.id, selId, problem: !!s.problems,
    sub: (s.llm && s.llm.status) ? s.llm.status : '',
  })).join('') + (rest.length ? bar({ color: '#30363d', label: `+${rest.length} smaller requests`, valStr: fmtM(restSum), widthPct: (restSum / reqMax) * 100 }) : '');

  return `<div class="cost-wrap">
    <div class="cost-sec">Where it went — by work type</div>
    <div class="cost-group">${catBars}</div>
    <div class="cost-sec">Top requests by ${metric === 'time' ? 'time' : metric === 'tokens' ? 'tokens' : 'spend'}</div>
    <div class="cost-group">${reqBars}</div>
  </div>`;
}

export function mountIcicle(el, space, { onSelect, metric = 'usd' } = {}) {
  el.innerHTML = '<div class="cost-scroll" id="cost-scroll"></div>';
  el.classList.add('map-graph-cost');
  const scroll = el.querySelector('#cost-scroll');
  let selId = null;
  let cur = metric;
  const topBar = el.closest('.map-space')?.querySelector('.map-top');
  const padTop = () => { if (topBar) scroll.style.paddingTop = topBar.offsetHeight + 10 + 'px'; };
  const ro = topBar && window.ResizeObserver ? new ResizeObserver(padTop) : null;
  ro?.observe(topBar);

  const draw = () => { const t = scroll.scrollTop; scroll.innerHTML = costHtml(space, cur, selId); scroll.scrollTop = t; };
  scroll.addEventListener('click', (e) => { const row = e.target.closest('.cost-click'); if (row) select(row.dataset.id); });

  function select(id) {
    selId = id || null;
    scroll.querySelectorAll('.cost-row.sel').forEach((n) => n.classList.remove('sel'));
    if (selId) scroll.querySelector(`.cost-row[data-id="${CSS.escape(selId)}"]`)?.classList.add('sel');
    onSelect?.(selId ? { id: selId } : null);
  }

  draw();
  padTop();
  return {
    update(next, opts = {}) { space = next || space; if (opts.metric) cur = opts.metric; draw(); },
    destroy() { ro?.disconnect(); el.classList.remove('map-graph-cost'); el.innerHTML = ''; },
    resize() { padTop(); },
    fit() {},
    select,
  };
}
