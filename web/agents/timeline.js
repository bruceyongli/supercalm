// Timeline (Gantt) renderer for the session Graph panel — the DEFAULT view. Deterministic, append-only,
// HTML/CSS (no canvas, no force layout) so it never flashes and existing rows never move: rows = requests
// in chronological order, segments = work clusters colored by category and sized by time, right-side
// badges = $/time/status. A childless request shows a labeled chip ("respond-only" / "no tool activity")
// instead of a mystery dot. Click a row/segment → onSelect({id}) → the panel's detail drawer.
//
// API mirrors the graph renderers: mountTimeline(el, space, {onSelect, metric}) -> { update, destroy, resize, select }.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtUsd = (v) => (v >= 100 ? '$' + Math.round(v) : v >= 10 ? '$' + v.toFixed(0) : '$' + (v || 0).toFixed(1));
const fmtTok = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v || 0)));
const fmtDur = (ms) => { const m = Math.round((ms || 0) / 60000); if (m < 1) return '<1m'; if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); };
const trim = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const sysLabel = (s) => (s.llm && s.llm.label) || s.label || 'Request';

// category -> {color, short} — matches the palette used elsewhere in the map
const CAT = {
  explore: ['#3d7ab0', 'explore'], research: ['#39c5bb', 'research'], edit: ['#3fb950', 'edit'],
  exec: ['#d2a022', 'exec'], subagent: ['#a371f7', 'subagent'], decision: ['#ffa657', 'decision'],
  plan: ['#6e7aff', 'plan'], reason: ['#586273', 'reason'], respond: ['#4a525e', 'respond'], other: ['#4a525e', 'work'],
};
const catColor = (c) => (CAT[c] || CAT.other)[0];
const STATUS_ACCENT = { done: '#3fb950', partial: '#d29922', blocked: '#f85149', abandoned: '#555c66' };
const REL_GLYPH = { 'follow-up': '↪', rework: '⟲', 'scope-change': '⑂', aside: '·' };
const REL_TITLE = { 'follow-up': 'follow-up', rework: 'rework', 'scope-change': 'scope change', aside: 'aside' };

// Build the row model from the shared space structure. Pure data -> deterministic.
function model(space) {
  const systems = space.systems || [];
  const rows = systems.map((s) => {
    const clusters = s.children || [];
    const segs = clusters.map((c) => ({
      id: c.id, cat: c.category || 'other', count: c.count || (c.children || []).length || 1,
      weight: (c.elapsed_ms || 0), label: c.label || (CAT[c.category] || CAT.other)[1], problem: !!c.problems,
      usd: c.usd || 0, elapsed_ms: c.elapsed_ms || 0,
    }));
    // childless request (conversation-only / subagent rolled / truncated): a labeled chip, not a dot
    let emptyKind = '';
    if (!segs.length) emptyKind = s.subagent_only ? 'subagent' : (s.calls ? 'work' : 'respond-only');
    return {
      id: s.id, label: sysLabel(s), status: (s.llm && s.llm.status) || '', relation: (s.llm && s.llm.relation) || '',
      problem: !!s.problems, usd: s.usd || 0, tokens: s.tokens || 0, elapsed_ms: s.elapsed_ms || 0, calls: s.calls || 0,
      segs, emptyKind,
    };
  });
  // ABSOLUTE width (px) per segment = active tool-time + a little per call, so a bar's length is STABLE — it
  // never rescales when a new (longer) request appears later. Long bars clip at the track edge (badge has the
  // exact figure); instantaneous single-turn clusters still get a visible minimum.
  for (const r of rows) for (const s of r.segs) s.px = Math.min(560, Math.round(6 + s.weight / 3500 + s.count * 3));
  return rows;
}

function rowHtml(r, selId) {
  const accent = STATUS_ACCENT[r.status] || '#2b313b';
  const rel = r.relation && REL_GLYPH[r.relation] ? `<span class="tl-rel" title="${esc(REL_TITLE[r.relation] || r.relation)}">${REL_GLYPH[r.relation]}</span>` : '';
  const segs = r.segs.length
    ? r.segs.map((s) => `<span class="tl-seg${s.problem ? ' tl-seg-problem' : ''}" data-id="${esc(s.id)}" style="flex-basis:${s.px}px;background:${catColor(s.cat)}" title="${esc(s.label)}${s.elapsed_ms ? ' · ' + fmtDur(s.elapsed_ms) : ''}${s.usd ? ' · ' + fmtUsd(s.usd) : ''}${s.problem ? ' · error' : ''}"></span>`).join('')
    : `<span class="tl-empty">${r.emptyKind === 'respond-only' ? 'respond-only' : r.emptyKind === 'subagent' ? 'subagent work' : 'no tool activity'}</span>`;
  const badges = `<span class="tl-cost">${esc(fmtUsd(r.usd))}</span><span class="tl-time">${esc(fmtDur(r.elapsed_ms))}</span>`;
  const cls = ['tl-row', r.status ? 'st-' + r.status : '', r.problem ? 'has-problem' : '', r.id === selId ? 'sel' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}" data-id="${esc(r.id)}" style="--accent:${accent}">
    <div class="tl-label">${rel}<span class="tl-txt" title="${esc(r.label)}">${esc(trim(r.label, 90))}</span></div>
    <div class="tl-track">${segs}</div>
    <div class="tl-badges">${badges}${r.problem ? '<span class="tl-prob" title="a tool error occurred">⚠</span>' : ''}</div>
  </div>`;
}

// compact category legend so the colors are decodable at a glance
function legendHtml(rows) {
  const seen = new Set();
  for (const r of rows) for (const s of r.segs) seen.add(s.cat);
  const order = ['explore', 'research', 'edit', 'exec', 'subagent', 'decision', 'plan', 'reason', 'respond'];
  const items = order.filter((c) => seen.has(c)).map((c) => `<span class="tl-leg-item"><i style="background:${catColor(c)}"></i>${esc((CAT[c] || CAT.other)[1])}</span>`).join('');
  return items ? `<div class="tl-legend">${items}</div>` : '';
}

export function mountTimeline(el, space, { onSelect } = {}) {
  el.innerHTML = '<div class="tl-scroll" id="tl-scroll"></div>';
  el.classList.add('map-graph-timeline');
  const scroll = el.querySelector('#tl-scroll');
  let selId = null;
  // pad the scroll below the floating controls+summary so the first rows aren't hidden under them
  const topBar = el.closest('.map-space')?.querySelector('.map-top');
  const padTop = () => { if (topBar) scroll.style.paddingTop = topBar.offsetHeight + 10 + 'px'; };
  const ro = topBar && window.ResizeObserver ? new ResizeObserver(padTop) : null;
  ro?.observe(topBar);

  const draw = () => {
    const rows = model(space);
    const prevTop = scroll.scrollTop;
    scroll.innerHTML = legendHtml(rows) + `<div class="tl-rows">${rows.map((r) => rowHtml(r, selId)).join('')}</div>`;
    scroll.scrollTop = prevTop; // re-render must not jump the scroll position
  };
  // event delegation survives re-renders (handlers bound to the stable container, not per-row)
  scroll.addEventListener('click', (e) => {
    const seg = e.target.closest('.tl-seg');
    const row = e.target.closest('.tl-row');
    if (seg) { select(seg.dataset.id); return; }
    if (row) { select(row.dataset.id); return; }
  });

  function select(id) {
    selId = id || null;
    scroll.querySelectorAll('.tl-row.sel').forEach((n) => n.classList.remove('sel'));
    if (selId) scroll.querySelector(`.tl-row[data-id="${CSS.escape(selId)}"]`)?.classList.add('sel');
    onSelect?.(selId ? { id: selId } : null);
  }

  draw();
  padTop();
  return {
    update(next) { space = next || space; draw(); },
    destroy() { ro?.disconnect(); el.classList.remove('map-graph-timeline'); el.innerHTML = ''; },
    resize() { padTop(); },
    fit() { scroll.scrollTop = scroll.scrollHeight; }, // jump to the latest (newest) request
    select,
  };
}
