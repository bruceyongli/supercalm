// SPA dashboard view (the "Needs you" inbox + sessions list). Mounts into #view; subscribes to the shared
// home-data loop; tears the subscription down on leave. Logic mirrors the legacy desktop.js (which the
// server cutover will retire). View contract: export init(host, params) + teardown().
import { getHome, subscribeHome, agentChip, shortTitle, needsYou, openLaunch, toast } from '../shell.js';
// cards/rows show the full first line (the rail keeps shortTitle); CSS ellipsizes/clamps per width
const fullTitle = (s) => (String(s.title || '').trim() || s.project || s.id || '').split('\n')[0].slice(0, 160);
import { api, escapeHtml as esc, fmtAgo, setupVerdict, isInteracting, setDashboardBrowserIdentity } from '../common.js';
import { startVoiceMode } from '../voicemode.js';

// The empty-inbox hero's setup line is HONEST: "setup complete" only when the onboarding gates
// (a CLI installed + a credential) actually pass; otherwise it points at the wizard. Checked once
// per mount (three tiny GETs), painted in place — the hero renders instantly either way.
let setupLine = null; // null = unknown yet; {ok, missing}
async function checkSetup() {
  if (setupLine) return;
  try {
    const [tv, auth, prov] = await Promise.all([
      api('api/tools/versions').catch(() => ({})),
      api('api/auth/status').catch(() => ({})),
      api('api/models/providers').catch(() => ({})),
    ]);
    setupLine = setupVerdict({ tools: tv.tools || [], auth, providers: prov.providers || [] });
  } catch { setupLine = null; return; }
  const el = host?.querySelector('[data-dk-setupline]');
  if (el) paintSetupLine(el);
}
function paintSetupLine(el) {
  if (!setupLine) return;
  if (setupLine.ok) { el.innerHTML = '<span class="ok">✓ setup complete — this box is yours</span>'; return; }
  const what = setupLine.missing === 'agents' ? 'no coding agent CLI found on this machine' : 'no sign-in yet — agents cannot run';
  el.innerHTML = `<span class="warn" style="color:#e2b23e">◌ setup isn't finished — ${esc(what)}</span> <a class="dk-reply-btn" href="onboarding">Finish setup ▸</a>`;
}

const BADGE = { action: ['ACTION', '#f2554d'], decision: ['DECISION', '#e2b23e'], review: ['REVIEW', '#4ecb6c'] };
const STOPPED_SHOWN = 10;
let stoppedExpanded = false;
let unsub = null;
let host = null;

const $ = (s) => host?.querySelector(s);

function optionsOf(s) {
  const q = String(s.question || s.summary || '');
  const opts = [];
  for (const m of q.matchAll(/(?:^|\n)\s*(\d)[.)]\s*([^\n]{3,60})/g)) opts.push({ key: m[1], label: m[2].trim() });
  if (!opts.length && /\by\/n\b|\byes\/no\b/i.test(q)) opts.push({ key: 'y', label: 'yes' }, { key: 'n', label: 'no' });
  return opts.slice(0, 4);
}
function primaryOpt(opts) {
  let i = opts.findIndex((o) => /recommend/i.test(o.label || ''));
  if (i < 0) i = opts.findIndex((o) => /^y(es)?$/i.test(String(o.key || '')) || /^yes\b/i.test(String(o.label || '')));
  return i < 0 ? 0 : i;
}

function keyedNode(html, key) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const node = t.content.firstElementChild;
  node.dataset.key = key;
  node.dataset.render = html;
  return node;
}
function reconcile(container, specs) {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const wanted = new Set(specs.map((s) => s.key));
  for (const [key, el] of existing) if (!wanted.has(key)) el.remove();
  specs.forEach((spec, i) => {
    let el = existing.get(spec.key);
    if (!el || (el.dataset.render !== spec.html && !isInteracting(el))) {
      const fresh = keyedNode(spec.html, spec.key);
      if (el) el.replaceWith(fresh);
      el = fresh;
    }
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
}

function renderInbox(home) {
  if (!host) return;
  setDashboardBrowserIdentity(home);
  const cards = needsYou();
  const nc = $('#dk-needs-count');
  if (nc) { nc.hidden = !cards.length; nc.textContent = cards.length; }
  const cardsEl = $('#dk-cards');
  const cardSpecs = cards.map((s) => {
    const [blabel, bcolor] = BADGE[s.category] || BADGE.review;
    const opts = optionsOf(s);
    return { key: `card:${s.id}`, html: `
    <div class="dk-card" data-dk-card data-sid="${esc(s.id)}" style="--strip:${bcolor}">
      <div class="dk-card-top">
        <span class="dk-chip" style="color:${bcolor};border-color:${bcolor}55">${blabel}</span>
        ${agentChip(s.tool)}
        <a class="dk-card-name" href="session?id=${esc(s.id)}">${esc(fullTitle(s))}</a>
        <span class="dk-card-meta">${esc(s.model || '')} · ${fmtAgo(s.last_activity)} ago</span>
      </div>
      <div class="dk-card-msg">${esc((s.question || s.summary || '').slice(0, 400))}</div>
      ${opts.length ? `<div class="dk-card-opts">${(() => { const pi = primaryOpt(opts); return opts.map((o, i) => `<button class="dk-opt${i === pi ? ' primary' : ''}" data-dk-opt data-key="${esc(o.key)}">${esc(o.key)} — ${esc(o.label)}</button>`).join(''); })()}</div>` : ''}
      <div class="dk-card-actions"><button class="dk-reply-btn" data-dk-reply>Reply</button><span class="dk-hint">${opts.length ? `${esc(opts.map((o) => o.key).join(' / '))} answers this` : ''}</span></div>
      <div class="dk-reply" hidden><textarea rows="2" placeholder="Reply to the agent…"></textarea><button class="dk-send" data-dk-send>➤</button></div>
    </div>` };
  });
  if (!cardSpecs.length) cardSpecs.push((home.sessions || []).length === 0
    ? { key: 'empty:first', html: `<div class="dk-hero" data-dk-allclear><span data-dk-setupline><span class="ok">✓ this box is yours</span></span><p>Start your first session: pick a repo — or type a new path and the project is created on the spot — give the agent a task, and walk away.</p><button class="dk-new" id="dk-hero-start">▶ Start first session</button></div>` }
    : { key: 'empty:clear', html: '<div class="dk-allclear" data-dk-allclear>All clear — nothing needs you.</div>' });
  if (cardsEl) reconcile(cardsEl, cardSpecs);
  const all = home.sessions || [];
  const live = all.filter((s) => ['starting', 'working', 'waiting'].includes(s.status));
  const stopped = all.filter((s) => !['starting', 'working', 'waiting'].includes(s.status));
  const sWord = (st) => (st === 'working' ? 'Working' : st === 'waiting' ? 'Waiting' : st === 'starting' ? 'Starting' : st === 'error' ? 'Failed' : 'Stopped');
  const row = (s) => `
    <a class="dk-row" href="session?id=${esc(s.id)}" data-dk-row data-sid="${esc(s.id)}">
      <i class="dk-dot ${s.status === 'working' ? 'ok pulse' : s.status === 'waiting' ? 'warn' : ''}"></i>${agentChip(s.tool)}
      <b class="dk-row-name">${esc(fullTitle(s))}</b>
      <span class="dk-row-task">${esc((s.summary || s.title || '').slice(0, 90))}</span>
      <span class="dk-status ${s.status}">${sWord(s.status)}</span>
      <span class="dk-age">${fmtAgo(s.last_activity)}</span>
    </a>`;
  const shownStopped = stoppedExpanded ? stopped : stopped.slice(0, STOPPED_SHOWN);
  const stoppedToggle = stopped.length > STOPPED_SHOWN
    ? `<button class="dk-show-more" data-dk-stopped-toggle>${stoppedExpanded ? 'show fewer' : `show all ${stopped.length} stopped`}</button>` : '';
  const rowsEl = $('#dk-rows');
  const rowSpecs = live.map((s) => ({ key: `row:${s.id}`, html: row(s) }));
  if (stopped.length) {
    rowSpecs.push({ key: 'stopped:header', html: `<div class="dk-sec-row dk-sec-row-sub">STOPPED · ${stopped.length}</div>` });
    rowSpecs.push(...shownStopped.map((s) => ({ key: `row:${s.id}`, html: row(s) })));
    if (stoppedToggle) rowSpecs.push({ key: 'stopped:toggle', html: stoppedToggle });
  }
  if (rowsEl) reconcile(rowsEl, rowSpecs);
  const tog = $('[data-dk-stopped-toggle]');
  if (tog) tog.onclick = () => { stoppedExpanded = !stoppedExpanded; renderInbox(getHome()); };
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
  const hero = $('#dk-hero-start');
  if (hero) hero.onclick = () => openLaunch();
  const setupEl = host.querySelector('[data-dk-setupline]');
  if (setupEl) { paintSetupLine(setupEl); checkSetup(); }
  for (const card of host.querySelectorAll('[data-dk-card]')) {
    for (const b of card.querySelectorAll('[data-dk-opt]')) b.onclick = () => answer(card, b.dataset.key);
    const replyBtn = card.querySelector('[data-dk-reply]');
    const reply = card.querySelector('.dk-reply');
    if (replyBtn && reply) replyBtn.onclick = () => { reply.hidden = !reply.hidden; reply.querySelector('textarea')?.focus(); };
    const send = card.querySelector('[data-dk-send]');
    if (send) send.onclick = () => { const t = card.querySelector('.dk-reply textarea').value.trim(); if (t) answer(card, t); };
  }
}

export function init(el) {
  host = el;
  stoppedExpanded = false;
  host.innerHTML = `
    <div class="dk-main">
      <section id="dk-inbox" data-dk-inbox>
        <div class="dk-page-head">
          <h1>Needs you <span class="dk-badge warn" id="dk-needs-count" hidden></span></h1>
          <button class="dk-voice" id="dk-voice" title="Hands-free pass over the needs-you queue">● Voice</button>
        </div>
        <div id="dk-cards" data-dk-cards></div>
        <div class="dk-sec-row">SESSIONS</div>
        <div id="dk-rows"></div>
      </section>
    </div>`;
  const voice = $('#dk-voice');
  if (voice) voice.onclick = () => startVoiceMode();
  unsub = subscribeHome(renderInbox); // fires immediately with current home, then on every poll
}

export function teardown() {
  try { unsub?.(); } catch {}
  unsub = null; host = null;
}
