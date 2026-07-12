// Story view (design handoff phase 1) — plain-language rendering of the session log, toggled
// against the raw terminal. DOM contract + exact tokens from the handoff's spec.tokens.json;
// verify_story_view.mjs asserts them. Events come from GET api/session/:id/story (src/story.js).
import { api } from './common.js';

const GLYPH = { you: '❯', sys: '○', work: '⌕', plan: '☑', note: '·', sub: '⑂', edit: '✎', fail: '✗', check: '✓', ship: '⬆', web: '⌾', report: '≡', ask: '?', stop: '⏹' };
const COLOR = { you: '#58a6ff', sys: '#3a4453', work: '#8a95a5', plan: '#79b8ff', note: '#5c6675', sub: '#9aa7b8', edit: '#d9924e', fail: '#f2554d', check: '#4ecb6c', ship: '#2fd6be', report: '#b9c4d4', ask: '#e2b23e', stop: '#e2b23e' };

let sid = null;
let panelEl = null;
let events = [];
let lastSig = '';
let showFull = false; // instant load shows recent rounds; user can expand to the full story
let trimmed = false;
let working = false; // live session status — drives the calming "working" animation at the foot
let liveStatus = null; // the CLI's OWN status line while working: {verb, detail, bg} (e.g. Roosting… · 1m 57s · ↓ 6.8k tokens)
let openSteps = new Set(); // indices with the steps expander open

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Header rollup: active duration · files touched · worst check · unanswered asks (per README).
function rollup(evs) {
  // r4: "active" = sum of ≤10-min gaps between events (wall-clock age is not activity);
  // snags/checks count only since the operator's last message (this round, not all history).
  let active = 0, prev = 0;
  for (const e of evs) {
    if (!e.ts) continue;
    if (prev && e.ts > prev && e.ts - prev <= 600000) active += e.ts - prev;
    prev = e.ts;
  }
  const mins = Math.round(active / 60000);
  const lastYou = evs.map((e) => e.kind).lastIndexOf('you');
  const recent = evs.slice(lastYou + 1);
  const files = new Set();
  for (const e of recent) if (e.kind === 'edit') for (const c of e.chips || []) files.add(String(c).split(' ')[0]);
  const fails = recent.filter((e) => e.kind === 'fail').length;
  const checks = recent.filter((e) => e.kind === 'check').length;
  const asks = evs.filter((e) => e.kind === 'ask' && !e.answered);
  const parts = [];
  if (mins) parts.push(mins >= 90 ? `${Math.round(mins / 6) / 10} hr active` : `${mins} min active`);
  if (files.size) parts.push(`${files.size} file${files.size > 1 ? 's' : ''} touched this round`);
  if (fails) parts.push(`${fails} snag${fails > 1 ? 's' : ''} this round`);
  else if (checks) parts.push('checks green');
  if (asks.length) parts.push(`${asks.length} question${asks.length > 1 ? 's' : ''} for you`);
  return parts.join(' · ') || (mins ? `${mins} min active · working` : 'session starting');
}

function stepsBodyHtml(steps) {
  return `<div class="story-steps" data-story-steps>${steps.map((st) => `
      <div class="story-step">${esc(st.human || '')}</div>
      ${st.cmd ? `<div class="story-cmd">$ ${esc(String(st.cmd).slice(0, 200))}</div>` : ''}`).join('')}</div>`;
}
function stepsHtml(ev, i) {
  const steps = ev.steps || [];
  if (!steps.length) return '';
  const open = openSteps.has(i);
  return `
    <div class="story-steps-toggle${open ? ' open' : ''}" data-story-steps-toggle data-i="${i}">${open ? '▾' : '▸'} ${steps.length > 1 ? steps.length + ' steps' : 'show the command'}</div>
    ${open ? stepsBodyHtml(steps) : ''}`;
}

// S8: the agent-recommended / affirmative option is primary; else the first.
export function primaryIndex(opts) {
  let i = opts.findIndex((o) => /recommend/i.test(`${o.label || ''} ${o.spoken || ''}`));
  if (i < 0) i = opts.findIndex((o) => /^y(es)?$/i.test(String(o.key || '')) || /^yes\b/i.test(String(o.label || '')));
  return i < 0 ? 0 : i;
}

function askHtml(ev) {
  const opts = ev.options || [];
  if (ev.answered) return `<div class="story-answered">✓ answered${ev.answeredWith ? ` "${esc(ev.answeredWith)}"` : ''} — session resumed</div>`;
  if (!opts.length) return '';
  const pi = primaryIndex(opts);
  return `<div class="story-ask-opts">${opts.map((o, j) => `
    <button class="story-ask-opt${j === pi ? ' primary' : ''}" data-story-ask-opt data-key="${esc(o.key ?? o.label ?? '')}">${esc(o.key ? o.key + ' — ' : '')}${esc(o.label || o.spoken || '')}</button>`).join('')}</div>`;
}

function eventHtml(ev, i) {
  if (ev.kind === 'gap') {
    const mins = Math.max(1, Math.round((ev.durationMs || 0) / 60000));
    const fallback = ev.durationMs ? `quiet for ${mins >= 60 ? Math.round(mins / 6) / 10 + ' hr' : mins + ' min'}` : 'quiet stretch';
    return `<div class="story-gap" data-story-ev data-kind="gap"><span>${esc(ev.title || fallback)}</span></div>`;
  }
  const color = COLOR[ev.kind] || '#8a95a5';
  const isAsk = ev.kind === 'ask';
  const untitled = ['you', 'sys', 'note'].includes(ev.kind);
  const metaCls = /recovered/.test(ev.meta || '') ? ' ok' : (isAsk && !ev.answered ? ' warn' : '');
  // ev.text is the fallback-story field (aios event log: "Session launched", "operator message · N chars…")
  // — render it as the body too, else untitled you/sys fallback events showed as bare icon+timestamp rows.
  const bodyText = ev.body || ev.text || '';
  const body = bodyText ? `<div class="story-body">${esc(bodyText)}</div>` : '';
  // S3: one baseline row — title · meta · time (time right-aligned); untitled events keep the
  // time in the block's top-right corner instead.
  const head = untitled
    ? `<span class="story-ts corner">${fmtClock(ev.ts)}</span>`
    : `<div class="story-title-row" data-story-title-row>
        <span class="story-title">${esc(ev.title || ev.kind)}</span>
        ${ev.meta ? `<span class="story-meta${metaCls}">${esc(ev.meta)}</span>` : ''}
        <span class="story-ts">${fmtClock(ev.ts)}</span>
      </div>`;
  const inner = `
    ${head}
    ${body}
    ${(ev.chips || []).length ? `<div class="story-chips">${ev.chips.map((c) => `<span class="story-chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${ev.shot ? `<div class="story-shot-wrap"><img class="story-shot" data-story-shot src="${esc(ev.shot)}" alt="screenshot" loading="lazy" /><span class="story-shot-cap">screenshot.png · click to enlarge</span></div>` : ''}
    ${stepsHtml(ev, i)}
    ${isAsk ? askHtml(ev) : ''}`;
  return `
    <div class="story-ev${ev.indent ? ' sub-indent' : ''}" data-story-ev="${ev.kind}" data-kind="${ev.kind}">
      <div class="story-icon" style="color:${color};border-color:${color}44;background:${color}14">${GLYPH[ev.kind] || '·'}</div>
      <div class="story-main">
        ${isAsk ? `<div class="story-card">${inner}</div>` : inner}
      </div>
    </div>`;
}

// The calming foot-of-story working indicator. When the CLI exposes its own live status line (claude
// "Roosting… (1m 57s · ↓ 6.8k tokens)", codex "Working (10s) · 5 background terminals running") show THAT,
// styled to the story: gerund in sans, the elapsed/tokens detail as a mono chip, background count as a chip.
function renderWorking() {
  if (!working) return '';
  const dots = '<span class="story-working-dots"><i></i><i></i><i></i></span>';
  const ls = liveStatus;
  if (!ls) return `<div class="story-working" data-story-working>${dots}<span class="story-working-verb">the agent is working…</span></div>`;
  const detail = ls.detail ? `<span class="story-working-detail">${esc(ls.detail)}</span>` : '';
  const bg = ls.bg ? `<span class="story-working-bg">${esc(ls.bg)}</span>` : '';
  return `<div class="story-working" data-story-working>${dots}<span class="story-working-verb">${esc(ls.verb)}</span>${detail}${bg}</div>`;
}

function render() {
  if (!panelEl) return;
  panelEl.innerHTML = `
    <div class="story-head">
      <span class="story-head-title">What happened, in plain language</span>
      <span class="story-rollup" data-story-rollup>${esc(rollup(events))}</span>
    </div>
    <div class="story-feed">${trimmed && !showFull ? '<button class="story-earlier" data-story-earlier>↑ show the full story</button>' : ''}${events.map(eventHtml).join('') || '<div class="story-empty">Nothing to tell yet — the story appears as the agent works.</div>'}</div>
    ${renderWorking()}`;
  wire();
  const feed = panelEl.querySelector('.story-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function wire() {
  const earlier = panelEl.querySelector('[data-story-earlier]');
  if (earlier) earlier.onclick = () => { showFull = true; lastSig = ''; refreshStory({ quiet: false }); };
  for (const t of panelEl.querySelectorAll('[data-story-steps-toggle]')) {
    t.onclick = () => {
      // toggle IN PLACE — a full re-render would detach the element mid-interaction (verifier
      // holds the handle across open/close, and a user double-click would misfire too)
      // per-block, independent (spec): toggle ONLY this cluster, in place
      const i = Number(t.dataset.i);
      const open = openSteps.has(i);
      if (open) {
        openSteps.delete(i);
        if (t.nextElementSibling?.matches('[data-story-steps]')) t.nextElementSibling.remove();
        t.classList.remove('open');
        t.textContent = `▸ ${t.textContent.replace(/^[▸▾]\s*/, '')}`;
      } else {
        openSteps.add(i);
        t.insertAdjacentHTML('afterend', stepsBodyHtml(events[i]?.steps || []));
        t.classList.add('open');
        t.textContent = `▾ ${t.textContent.replace(/^[▸▾]\s*/, '')}`;
      }
    };
  }
  for (const b of panelEl.querySelectorAll('[data-story-ask-opt]')) {
    b.onclick = async () => {
      const key = b.dataset.key || b.textContent.trim();
      try {
        await api(`api/session/${sid}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: key, source: 'text' }) });
        b.closest('.story-ask-opts')?.replaceWith(Object.assign(document.createElement('div'), { className: 'story-answered', textContent: `✓ answered "${key}" — session resumed` }));
      } catch (e) { b.textContent = '⚠ ' + (e.message || e); }
    };
  }
  for (const img of panelEl.querySelectorAll('[data-story-shot]')) {
    img.onclick = () => {
      const lb = document.createElement('div');
      lb.className = 'story-lightbox';
      lb.innerHTML = `<img src="${img.src}" alt="screenshot" />`;
      lb.onclick = () => lb.remove();
      const esc2 = (e) => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc2); } };
      document.addEventListener('keydown', esc2);
      document.body.appendChild(lb);
    };
  }
}

export async function refreshStory({ quiet = true } = {}) {
  try {
    const r = await api(`api/session/${sid}/story${showFull ? '?full=1' : ''}`);
    events = r.events || [];
    trimmed = !!(r.meta && r.meta.trimmed) && !showFull;
    working = r.status === 'working';
    liveStatus = r.liveStatus || null;
    // re-render when anything user-visible changes: count, answers landing, a cluster/fail meta update
    // on the last events (count alone left stale ✓/recovered states), or the live status line changing.
    const lsSig = working ? (liveStatus ? `${liveStatus.verb}|${liveStatus.detail}|${liveStatus.bg || ''}` : 'w') : '';
    const sig = events.length + ':' + events.reduce((a, e) => a + (e.answered ? 1 : 0), 0)
      + ':' + events.slice(-3).map((e) => e.meta || '').join('|') + ':' + lsSig;
    if (sig !== lastSig) { lastSig = sig; render(); }
  } catch (e) {
    if (!quiet && panelEl) panelEl.innerHTML = `<div class="story-empty">story unavailable: ${esc(e.message || e)}</div>`;
  }
}

export function initStoryView({ sessionId, panel }) {
  sid = sessionId;
  panelEl = panel;
  refreshStory({ quiet: false });
}
