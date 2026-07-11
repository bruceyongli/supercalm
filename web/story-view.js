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
    <div class="story-steps-toggle" data-story-steps-toggle data-i="${i}">${open ? '▾' : '▸'} ${steps.length} step${steps.length > 1 ? 's' : ''}</div>
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
    return `<div class="story-gap" data-story-ev data-kind="gap"><span>${esc(ev.title || 'quiet stretch')}</span></div>`;
  }
  const color = COLOR[ev.kind] || '#8a95a5';
  const isAsk = ev.kind === 'ask';
  const untitled = ['you', 'sys', 'note'].includes(ev.kind);
  const metaCls = /recovered/.test(ev.meta || '') ? ' ok' : (isAsk && !ev.answered ? ' warn' : '');
  const body = ev.body ? `<div class="story-body">${esc(ev.body)}</div>` : '';
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

function render() {
  if (!panelEl) return;
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
      // per-block, independent (spec): toggle ONLY this cluster, in place
      const i = Number(t.dataset.i);
      const open = openSteps.has(i);
      if (open) {
        openSteps.delete(i);
        if (t.nextElementSibling?.matches('[data-story-steps]')) t.nextElementSibling.remove();
        t.textContent = `▸ ${t.textContent.replace(/^[▸▾]\s*/, '')}`;
      } else {
        openSteps.add(i);
        t.insertAdjacentHTML('afterend', stepsBodyHtml(events[i]?.steps || []));
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
