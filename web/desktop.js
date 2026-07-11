// Desktop home = the app-shell (web/shell.js) + the Inbox triage in the main column. The shell (left
// sidebar, ⌘K palette, launch modal, toast, live loop) is shared with every other page; this file only
// owns the Inbox. Data: the phone contract's triage endpoint via the shell's load, handed to renderInbox.
import { mountShell, getHome, agentChip, shortTitle, needsYou, openLaunch, toast } from './shell.js';
import { api, escapeHtml as esc, fmtAgo } from './common.js';
import { startVoiceMode } from './voicemode.js';

const BADGE = { action: ['ACTION', '#f2554d'], decision: ['DECISION', '#e2b23e'], review: ['REVIEW', '#4ecb6c'] };
const $ = (s) => document.querySelector(s);

// ---- inbox -----------------------------------------------------------------------------------------
function optionsOf(s) {
  const q = String(s.question || s.summary || '');
  const opts = [];
  for (const m of q.matchAll(/(?:^|\n)\s*(\d)[.)]\s*([^\n]{3,60})/g)) opts.push({ key: m[1], label: m[2].trim() });
  if (!opts.length && /\by\/n\b|\byes\/no\b/i.test(q)) opts.push({ key: 'y', label: 'yes' }, { key: 'n', label: 'no' });
  return opts.slice(0, 4);
}

// R2 S8: recommended/affirmative option is primary; else the first (matches the story view).
function primaryOpt(opts) {
  let i = opts.findIndex((o) => /recommend/i.test(o.label || ''));
  if (i < 0) i = opts.findIndex((o) => /^y(es)?$/i.test(String(o.key || '')) || /^yes\b/i.test(String(o.label || '')));
  return i < 0 ? 0 : i;
}

function renderInbox(home) {
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
      ${opts.length ? `<div class="dk-card-opts">${(() => { const pi = primaryOpt(opts); return opts.map((o, i) => `<button class="dk-opt${i === pi ? ' primary' : ''}" data-dk-opt data-key="${esc(o.key)}">${esc(o.key)} — ${esc(o.label)}</button>`).join(''); })()}</div>` : ''}
      <div class="dk-card-actions"><button class="dk-reply-btn" data-dk-reply>Reply</button><span class="dk-hint">${opts.length ? `${esc(opts.map((o) => o.key).join(' / '))} answers this` : ''}</span></div>
      <div class="dk-reply" hidden><textarea rows="2" placeholder="Reply to the agent…"></textarea><button class="dk-send" data-dk-send>➤</button></div>
    </div>`;
  }).join('') || ((home.sessions || []).length === 0
    ? `<div class="dk-hero" data-dk-allclear><span class="ok">✓ setup complete — this box is yours</span>
       <p>Start your first session: pick a repo — or type a new path and the project is created on the spot — give the agent a task, and walk away.</p>
       <button class="dk-new" id="dk-hero-start">▶ Start first session</button>
       <span class="foot">⌘K jumps anywhere · Settings keeps every setup step</span></div>`
    : '<div class="dk-allclear" data-dk-allclear>All clear — nothing needs you.</div>');
  const rows = (home.sessions || []).filter((s) => s.status === 'working' || s.status === 'waiting');
  $('#dk-rows').innerHTML = rows.map((s) => `
    <a class="dk-row" href="session?id=${esc(s.id)}">
      <i class="dk-dot ${s.status === 'working' ? 'ok pulse' : 'warn'}"></i>${agentChip(s.tool)}
      <b class="dk-row-name">${esc(shortTitle(s))}</b>
      <span class="dk-row-task">${esc((s.summary || s.title || '').slice(0, 90))}</span>
      <span class="dk-status ${s.status}">${s.status === 'working' ? 'Working' : 'Waiting'}</span>
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
  const hero = document.getElementById('dk-hero-start');
  if (hero) hero.onclick = openLaunch;
  for (const card of document.querySelectorAll('[data-dk-card]')) {
    for (const b of card.querySelectorAll('[data-dk-opt]')) b.onclick = () => answer(card, b.dataset.key);
    const replyBtn = card.querySelector('[data-dk-reply]');
    const reply = card.querySelector('.dk-reply');
    if (replyBtn && reply) replyBtn.onclick = () => { reply.hidden = !reply.hidden; reply.querySelector('textarea')?.focus(); };
    const send = card.querySelector('[data-dk-send]');
    if (send) send.onclick = () => { const t = card.querySelector('.dk-reply textarea').value.trim(); if (t) answer(card, t); };
  }
}

mountShell({ onData: renderInbox, activeNav: 'inbox' });
// Voice button on the Inbox header (design parity — the prototype's hands-free triage entry point;
// dropped in the home-flip to this shell). Reuses the existing voice concierge.
const voiceBtn = document.getElementById('dk-voice');
if (voiceBtn) voiceBtn.onclick = () => startVoiceMode();
