// Desktop shell (design handoff phase 2, slice 1): persistent left sidebar + Inbox triage +
// ⌘K palette. Staged at /desktop until the shell reaches parity, then it becomes the home page.
// Data: the phone contract's triage endpoint (episode-unread semantics) + /api/state SSE channel.
import { api, coalesce, escapeHtml as esc, fmtAgo } from './common.js';

let home = { sessions: [], counts: {} };
const AGENT_COLOR = { claude: '#d9924e', codex: '#9aa7b8', agy: '#79b8ff' };
const BADGE = { action: ['ACTION', '#f2554d'], decision: ['DECISION', '#e2b23e'], review: ['REVIEW', '#4ecb6c'] };

const $ = (s) => document.querySelector(s);

function agentChip(tool) {
  return `<span class="dk-agent" style="color:${AGENT_COLOR[tool] || '#9aa7b8'}">${esc(tool || 'cli')}</span>`;
}

// ---- sidebar ---------------------------------------------------------------------------------------
function renderSide() {
  const c = home.counts || {};
  $('#dk-counters').innerHTML = `
    <span class="dk-cnt"><i class="dk-dot warn"></i>${c.waiting || 0} waiting</span>
    <span class="dk-cnt"><i class="dk-dot ok pulse"></i>${c.working || 0} working</span>
    <span class="dk-cnt muted">${c.live || 0} live</span>`;
  const badge = $('#dk-inbox-badge');
  const needs = needsYou().length;
  badge.hidden = !needs;
  badge.textContent = needs;
  const live = (home.sessions || []).filter((s) => s.status === 'working' || s.status === 'waiting').slice(0, 7);
  $('#dk-sessions').innerHTML = live.map((s) => `
    <a class="dk-sess" href="session?id=${esc(s.id)}" data-dk-sess>
      <span class="dk-sess-l1"><i class="dk-dot ${s.status === 'working' ? 'ok pulse' : 'warn'}"></i><b>${esc(shortTitle(s))}</b>${agentChip(s.tool)}<span class="dk-status">${s.status === 'working' ? 'Working' : 'Waiting'}</span></span>
      <span class="dk-sess-l2">${esc((s.summary || s.title || '').slice(0, 64))}</span>
    </a>`).join('') || '<div class="dk-empty-side">no live sessions</div>';
  $('#dk-foot').innerHTML = `<span>${esc(location.hostname)}</span><i class="dk-dot ok"></i><span id="dk-clock">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
}

function shortTitle(s) {
  return (s.title || s.id).split(/\s+/).slice(0, 3).join(' ').slice(0, 22);
}

function needsYou() {
  return (home.sessions || []).filter((s) => s.status === 'waiting' && s.unread && s.category && s.category !== 'working');
}

// ---- inbox -----------------------------------------------------------------------------------------
function optionsOf(s) {
  // options parsed from the waiting question when the TUI listed keyed choices (1./2. or y/n)
  const q = String(s.question || s.summary || '');
  const opts = [];
  for (const m of q.matchAll(/(?:^|\n)\s*(\d)[.)]\s*([^\n]{3,60})/g)) opts.push({ key: m[1], label: m[2].trim() });
  if (!opts.length && /\by\/n\b|\byes\/no\b/i.test(q)) opts.push({ key: 'y', label: 'yes' }, { key: 'n', label: 'no' });
  return opts.slice(0, 4);
}

function renderInbox() {
  const cards = needsYou();
  const nc = $('#dk-needs-count');
  nc.hidden = !cards.length;
  nc.textContent = cards.length;
  $('#dk-cards').innerHTML = cards.map((s) => {
    const [blabel, bcolor] = BADGE[s.category] || BADGE.review;
    const opts = optionsOf(s);
    return `
    <div class="dk-card" data-dk-card data-sid="${esc(s.id)}" style="--strip:${bcolor}">
      <div class="dk-card-top">
        <span class="dk-chip" style="color:${bcolor};border-color:${bcolor}55">${blabel}</span>
        ${agentChip(s.tool)}
        <a class="dk-card-name" href="session?id=${esc(s.id)}">${esc(shortTitle(s))}</a>
        <span class="dk-card-meta">${esc(s.model || '')} · ${fmtAgo(s.last_activity)} ago</span>
      </div>
      <div class="dk-card-msg">${esc((s.question || s.summary || '').slice(0, 400))}</div>
      ${opts.length ? `<div class="dk-card-opts">${opts.map((o, i) => `<button class="dk-opt${i === 0 ? ' primary' : ''}" data-dk-opt data-key="${esc(o.key)}">${esc(o.key)} — ${esc(o.label)}</button>`).join('')}</div>` : ''}
      <div class="dk-card-actions"><button class="dk-reply-btn" data-dk-reply>Reply</button><span class="dk-hint">${opts.length ? `${esc(opts.map((o) => o.key).join(' / '))} answers this` : ''}</span></div>
      <div class="dk-reply" hidden><textarea rows="2" placeholder="Reply to the agent…"></textarea><button class="dk-send" data-dk-send>➤</button></div>
    </div>`;
  }).join('') || '<div class="dk-allclear" data-dk-allclear>All clear — nothing needs you.</div>';
  const rows = (home.sessions || []).filter((s) => s.status === 'working' || s.status === 'waiting');
  $('#dk-rows').innerHTML = rows.map((s) => `
    <a class="dk-row" href="session?id=${esc(s.id)}">
      <i class="dk-dot ${s.status === 'working' ? 'ok pulse' : 'warn'}"></i>${agentChip(s.tool)}
      <b class="dk-row-name">${esc(shortTitle(s))}</b>
      <span class="dk-row-task">${esc((s.summary || s.title || '').slice(0, 90))}</span>
      <span class="dk-status">${s.status === 'working' ? 'Working' : 'Waiting'}</span>
      <span class="dk-age">${fmtAgo(s.last_activity)}</span>
    </a>`).join('');
  wireCards();
}

async function answer(card, text) {
  const sid = card.dataset.sid;
  try {
    await api(`api/session/${sid}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source: 'text' }) });
    card.style.opacity = '0.55';
    card.querySelector('.dk-card-actions').innerHTML = `<span class="dk-answered">✓ answered "${esc(text.slice(0, 24))}" — session resumed</span>`;
    card.querySelector('.dk-card-opts')?.remove();
    card.querySelector('.dk-reply')?.remove();
    toast('Sent — session resumed');
    api('api/messages/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid }) }).catch(() => {});
  } catch (e) { toast('⚠ ' + (e.message || e)); }
}

function wireCards() {
  for (const card of document.querySelectorAll('[data-dk-card]')) {
    for (const b of card.querySelectorAll('[data-dk-opt]')) b.onclick = () => answer(card, b.dataset.key);
    const replyBtn = card.querySelector('[data-dk-reply]');
    const reply = card.querySelector('.dk-reply');
    if (replyBtn && reply) replyBtn.onclick = () => { reply.hidden = !reply.hidden; reply.querySelector('textarea')?.focus(); };
    const send = card.querySelector('[data-dk-send]');
    if (send) send.onclick = () => { const t = card.querySelector('.dk-reply textarea').value.trim(); if (t) answer(card, t); };
  }
}

// ---- command palette (⌘K) --------------------------------------------------------------------------
const SCREENS = [['Inbox', 'desktop'], ['Projects', '.'], ['Decisions', 'decisions'], ['Records', 'records'], ['Usage', 'usage'], ['Health', 'health'], ['Settings', 'auth']];
function paletteItems(q) {
  const items = [];
  for (const [label, href] of SCREENS) items.push({ kind: 'go', label, run: () => (location.href = href) });
  items.push({ kind: 'action', label: 'New session', run: () => (location.href = './#new') });
  items.push({ kind: 'action', label: 'Re-auth CLIs', run: () => (location.href = 'auth') });
  for (const s of home.sessions || []) {
    if (s.status !== 'working' && s.status !== 'waiting') continue;
    items.push({ kind: 'session', label: shortTitle(s), sub: (s.summary || '').slice(0, 60), run: () => (location.href = `session?id=${s.id}`) });
  }
  const needle = q.trim().toLowerCase();
  return (needle ? items.filter((i) => (i.label + ' ' + (i.sub || '')).toLowerCase().includes(needle)) : items).slice(0, 12);
}
let palSel = 0;
function renderPalette() {
  const q = $('#dk-palette-q').value;
  const items = paletteItems(q);
  palSel = Math.min(palSel, Math.max(0, items.length - 1));
  $('#dk-palette-list').innerHTML = items.map((i, n) => `
    <div class="dk-pal-item${n === palSel ? ' sel' : ''}" data-n="${n}"><span class="dk-pal-kind">${i.kind}</span><b>${esc(i.label)}</b>${i.sub ? `<span class="dk-pal-sub">${esc(i.sub)}</span>` : ''}</div>`).join('');
  for (const el of document.querySelectorAll('.dk-pal-item')) el.onclick = () => { items[Number(el.dataset.n)]?.run(); closePalette(); };
  return items;
}
function openPalette() { $('#dk-palette').hidden = false; $('#dk-palette-q').value = ''; palSel = 0; renderPalette(); $('#dk-palette-q').focus(); }
function closePalette() { $('#dk-palette').hidden = true; }
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#dk-palette').hidden ? openPalette() : closePalette(); }
  if (e.key === 'Escape') closePalette();
  if (!$('#dk-palette').hidden) {
    const items = paletteItems($('#dk-palette-q').value);
    if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, items.length - 1); renderPalette(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); renderPalette(); e.preventDefault(); }
    if (e.key === 'Enter') { items[palSel]?.run(); closePalette(); }
  }
});
$('#dk-palette-q')?.addEventListener('input', renderPalette);
$('#dk-palette')?.addEventListener('click', (e) => { if (e.target === $('#dk-palette')) closePalette(); });
$('#dk-cmdk-row').onclick = openPalette;
$('#dk-counters').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
$('#dk-new').onclick = () => (location.href = './#new'); // existing New-session modal home (merged modal lands with the full flip)

// ---- toast -----------------------------------------------------------------------------------------
let toastT = null;
function toast(msg) {
  const t = $('#dk-toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2400);
}

// ---- data loop -------------------------------------------------------------------------------------
async function load() {
  try {
    const r = await api('api/phone/home');
    home = r || home;
    renderSide();
    renderInbox();
  } catch {}
}
load();
setInterval(() => { const c = $('#dk-clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }, 30_000);
try {
  const events = new EventSource('api/stream');
  events.addEventListener('changed', coalesce(load, 3000));
} catch {}
