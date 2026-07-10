// Story view (design handoff phase 1) — plain-language rendering of the session log, toggled
// against the raw terminal. DOM contract + exact tokens from the handoff's spec.tokens.json;
// verify_story_view.mjs asserts them. Events come from GET api/session/:id/story (src/story.js).
import { api } from './common.js';

const GLYPH = { you: '❯', sys: '○', work: '⌕', plan: '☑', note: '·', sub: '⑂', edit: '✎', fail: '✗', check: '✓', ship: '⬆', web: '⌾', report: '≡', ask: '?', stop: '⏹' };
const COLOR = { you: '#58a6ff', sys: '#3a4453', work: '#8a95a5', plan: '#79b8ff', note: '#5c6675', sub: '#9aa7b8', edit: '#d9924e', fail: '#f2554d', check: '#4ecb6c', ship: '#2fd6be', report: '#b9c4d4', ask: '#e2b23e', stop: '#e2b23e' };

let sid = null;
let panelEl = null;
let events = [];
let lastCount = -1;
let openSteps = new Set(); // indices with the steps expander open

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Header rollup: active duration · files touched · worst check · unanswered asks (per README).
function rollup(evs) {
  const first = evs.find((e) => e.ts)?.ts, last = [...evs].reverse().find((e) => e.ts)?.ts;
  const mins = first && last ? Math.max(1, Math.round((last - first) / 60000)) : 0;
  const files = new Set();
  for (const e of evs) if (e.kind === 'edit') for (const c of e.chips || []) files.add(String(c).split(' ')[0]);
  const checks = evs.filter((e) => e.kind === 'check');
  const fails = evs.filter((e) => e.kind === 'fail' && !/recovered/.test(e.meta || ''));
  const asks = evs.filter((e) => e.kind === 'ask' && !e.answered);
  const parts = [];
  if (mins) parts.push(mins >= 60 ? `${Math.round(mins / 6) / 10} hr active` : `${mins} min active`);
  if (files.size) parts.push(`${files.size} file${files.size > 1 ? 's' : ''} touched`);
  if (checks.length) parts.push(fails.length ? `${fails.length} unresolved fail${fails.length > 1 ? 's' : ''}` : 'tests green');
  if (asks.length) parts.push(`${asks.length} question${asks.length > 1 ? 's' : ''} for you`);
  return parts.join(' · ') || 'session log';
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
    <div class="story-steps-toggle" data-story-steps-toggle data-i="${i}">${open ? '▾' : '▸'} ${steps.length} step${steps.length > 1 ? 's' : ''}</div>
    ${open ? stepsBodyHtml(steps) : ''}`;
}

function askHtml(ev) {
  const opts = ev.options || [];
  if (ev.answered) return `<div class="story-answered">✓ answered${ev.answeredWith ? ` "${esc(ev.answeredWith)}"` : ''} — session resumed</div>`;
  if (!opts.length) return '';
  return `<div class="story-ask-opts">${opts.map((o, j) => `
    <button class="story-ask-opt${j === 0 ? ' primary' : ''}" data-story-ask-opt data-key="${esc(o.key ?? o.label ?? '')}">${esc(o.key ? o.key + ' — ' : '')}${esc(o.label || o.spoken || '')}</button>`).join('')}</div>`;
}

function eventHtml(ev, i) {
  if (ev.kind === 'gap') {
    return `<div class="story-gap" data-story-ev data-kind="gap"><span>${esc(ev.title || 'quiet stretch')}</span></div>`;
  }
  const color = COLOR[ev.kind] || '#8a95a5';
  const isAsk = ev.kind === 'ask';
  const body = ev.body ? `<div class="story-body">${esc(ev.body)}</div>` : '';
  const inner = `
    <div class="story-title">${esc(ev.title || ev.kind)}</div>
    ${body}
    ${(ev.chips || []).length ? `<div class="story-chips">${ev.chips.map((c) => `<span class="story-chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${ev.shot ? `<img class="story-shot" data-story-shot src="${esc(ev.shot)}" alt="screenshot" loading="lazy" />` : ''}
    ${stepsHtml(ev, i)}
    ${isAsk ? askHtml(ev) : ''}
    ${ev.meta ? `<div class="story-meta${/recovered/.test(ev.meta) ? ' ok' : ''}">${esc(ev.meta)}</div>` : ''}`;
  return `
    <div class="story-ev${ev.indent ? ' sub-indent' : ''}" data-story-ev="${ev.kind}" data-kind="${ev.kind}">
      <div class="story-icon" style="color:${color};border-color:${color}55">${GLYPH[ev.kind] || '·'}</div>
      <div class="story-main">
        ${isAsk ? `<div class="story-card">${inner}</div>` : inner}
        <div class="story-ts">${fmtClock(ev.ts)}</div>
      </div>
    </div>`;
}

let seededOpen = false;
function render() {
  if (!panelEl) return;
  // First render: open the first steps-bearing cluster so the peek layer is visible (and style-
  // verifiable) without a click; later renders respect the user's own open/close choices.
  if (!seededOpen) {
    seededOpen = true;
    const i = events.findIndex((e) => (e.steps || []).length);
    if (i >= 0) openSteps.add(i);
  }
  panelEl.innerHTML = `
    <div class="story-head">
      <span class="story-head-title">What happened, in plain language</span>
      <span class="story-rollup" data-story-rollup>${esc(rollup(events))}</span>
    </div>
    <div class="story-feed">${events.map(eventHtml).join('') || '<div class="story-empty">Nothing to tell yet — the story appears as the agent works.</div>'}</div>`;
  wire();
  const feed = panelEl.querySelector('.story-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function wire() {
  for (const t of panelEl.querySelectorAll('[data-story-steps-toggle]')) {
    t.onclick = () => {
      // toggle IN PLACE — a full re-render would detach the element mid-interaction (verifier
      // holds the handle across open/close, and a user double-click would misfire too)
      const i = Number(t.dataset.i);
      const open = openSteps.has(i);
      if (open) { openSteps.delete(i); t.nextElementSibling?.matches('[data-story-steps]') && t.nextElementSibling.remove(); }
      else { openSteps.add(i); t.insertAdjacentHTML('afterend', stepsBodyHtml(events[i]?.steps || [])); }
      t.firstChild && (t.textContent = `${open ? '▸' : '▾'} ${t.textContent.replace(/^[▸▾]\s*/, '')}`);
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
    img.onclick = () => window.open(img.src, '_blank');
  }
}

export async function refreshStory({ quiet = true } = {}) {
  try {
    const r = await api(`api/session/${sid}/story`);
    events = r.events || [];
    if (events.length !== lastCount) { lastCount = events.length; render(); }
  } catch (e) {
    if (!quiet && panelEl) panelEl.innerHTML = `<div class="story-empty">story unavailable: ${esc(e.message || e)}</div>`;
  }
}

export function initStoryView({ sessionId, panel }) {
  sid = sessionId;
  panelEl = panel;
  refreshStory({ quiet: false });
}
