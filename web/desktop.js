// Desktop home = the app-shell (web/shell.js) + the Inbox triage in the main column. The shell (left
// sidebar, ⌘K palette, launch modal, toast, live loop) is shared with every other page; this file only
// owns the Inbox. Data: the phone contract's triage endpoint via the shell's load, handed to renderInbox.
import { mountShell, getHome, upsertSession, agentChip, shortTitle, needsYou, openLaunch, toast } from './shell.js';
import { api, escapeHtml as esc, fmtAgo } from './common.js';
import { startVoiceMode } from './voicemode.js';
import { answersPayload, attentionReportKey, ensureOptionQuestions, getOptionQuestions } from './attention-options.js';

const BADGE = { action: ['ACTION', '#f2554d'], decision: ['DECISION', '#e2b23e'], review: ['REVIEW', '#4ecb6c'] };
const $ = (s) => document.querySelector(s);
const STOPPED_SHOWN = 10; // how many stopped sessions to show before the "show all N" toggle
let stoppedExpanded = false; // persists across SSE re-renders so the list doesn't collapse under the user
const choiceSelections = new Map();

// ---- inbox -----------------------------------------------------------------------------------------
function optionsOf(s) {
  const q = String(s.question || s.summary || '');
  const opts = [];
  for (const m of q.matchAll(/(?:^|\n)\s*(\d)[.)]\s*([^\n]{3,60})/g)) opts.push({ key: m[1], label: m[2].trim() });
  if (!opts.length && /\by\/n\b|\byes\/no\b/i.test(q)) opts.push({ key: 'y', label: 'yes' }, { key: 'n', label: 'no' });
  return opts.slice(0, 4);
}

function optionQuestions(s) {
  const structured = getOptionQuestions(s);
  if (structured.length) return structured;
  const fallback = optionsOf(s);
  return fallback.length ? [{ id: `fallback:${s.id}`, header: '', question: String(s.question || s.summary || ''), multiSelect: false, options: fallback }] : [];
}
function selectionsFor(s) {
  const reportKey = attentionReportKey(s);
  let state = choiceSelections.get(s.id);
  if (!state || state.reportKey !== reportKey) {
    state = { reportKey, questions: new Map() };
    choiceSelections.set(s.id, state);
  }
  return state.questions;
}
const choicesComplete = (questions, selections) => questions.length > 0 && questions.every((_, index) => (selections.get(index)?.size || 0) > 0);
function choicesHtml(s, questions) {
  if (!questions.length) return '';
  const selections = selectionsFor(s);
  const hasMulti = questions.some((question) => question.multiSelect);
  return `<div class="dk-card-questions" data-dk-questions>
    ${questions.map((question, questionIndex) => `
      <div class="dk-card-question" data-dk-question="${questionIndex}">
        ${questions.length > 1 || question.header ? `<div class="dk-card-question-head">${question.header ? esc(question.header) : `Question ${questionIndex + 1}`}</div>` : ''}
        ${questions.length > 1 && question.question ? `<div class="dk-card-question-text">${esc(question.question)}</div>` : ''}
        <div class="dk-card-opts">${question.options.map((option, optionIndex) => {
          const selected = selections.get(questionIndex)?.has(optionIndex);
          return `<button class="dk-opt${selected ? ' selected' : ''}" data-dk-choice data-question="${questionIndex}" data-option="${optionIndex}" aria-pressed="${selected ? 'true' : 'false'}"><span>${option.key ? `${esc(option.key)} — ` : ''}${esc(option.label)}</span>${option.description ? `<small>${esc(option.description)}</small>` : ''}</button>`;
        }).join('')}</div>
      </div>`).join('')}
    ${hasMulti ? `<button class="dk-choice-submit" data-dk-choice-submit ${choicesComplete(questions, selections) ? '' : 'disabled'}>Send selected options</button>` : `<span class="dk-choice-hint">${questions.length > 1 ? 'Choose one for each question — sends after the last choice' : 'Choose an option to answer'}</span>`}
  </div>`;
}

function renderInbox(home) {
  const cards = needsYou();
  const nc = $('#dk-needs-count');
  nc.hidden = !cards.length;
  nc.textContent = cards.length;
  $('#dk-cards').innerHTML = cards.map((s) => {
    const [blabel, bcolor] = BADGE[s.category] || BADGE.review;
    const questions = optionQuestions(s);
    return `
    <div class="dk-card" data-dk-card data-sid="${esc(s.id)}" style="--strip:${bcolor}">
      <div class="dk-card-top">
        <span class="dk-chip" style="color:${bcolor};border-color:${bcolor}55">${blabel}</span>
        ${agentChip(s.tool)}
        <a class="dk-card-name" href="session?id=${esc(s.id)}">${esc(shortTitle(s))}</a>
        <span class="dk-card-meta">${esc(s.model || '')} · ${fmtAgo(s.last_activity)} ago</span>
      </div>
      <div class="dk-card-msg">${esc((s.question || s.summary || '').slice(0, 400))}</div>
      ${choicesHtml(s, questions)}
      <div class="dk-card-actions"><button class="dk-reply-btn" data-dk-reply>Reply</button><button class="dk-dismiss-btn" data-dk-dismiss title="Remove this report from Needs you">Dismiss</button></div>
      <div class="dk-reply" hidden><textarea rows="2" placeholder="Reply to the agent…"></textarea><button class="dk-send" data-dk-send>➤</button></div>
    </div>`;
  }).join('') || ((home.sessions || []).length === 0
    ? `<div class="dk-hero" data-dk-allclear><span class="ok">✓ setup complete — this box is yours</span>
       <p>Start your first session: pick a repo — or type a new path and the project is created on the spot — give the agent a task, and walk away.</p>
       <button class="dk-new" id="dk-hero-start">▶ Start first session</button>
       <span class="foot">⌘K jumps anywhere · Settings keeps every setup step</span></div>`
    : '<div class="dk-allclear" data-dk-allclear>All clear — nothing needs you.</div>');
  // Sessions list lives HERE in the page body (not the side rail): live sessions first, then a muted
  // STOPPED section (operator: stopped sessions belong on the page, not crammed into the nav rail).
  const all = home.sessions || [];
  const live = all.filter((s) => s.status === 'working' || s.status === 'waiting');
  const stopped = all.filter((s) => s.status !== 'working' && s.status !== 'waiting');
  const sWord = (st) => (st === 'working' ? 'Working' : st === 'waiting' ? 'Waiting' : 'Stopped');
  const row = (s) => `
    <a class="dk-row" href="session?id=${esc(s.id)}">
      <i class="dk-dot ${s.status === 'working' ? 'ok pulse' : s.status === 'waiting' ? 'warn' : ''}"></i>${agentChip(s.tool)}
      <b class="dk-row-name">${esc(shortTitle(s))}</b>
      <span class="dk-row-task">${esc((s.summary || s.title || '').slice(0, 90))}</span>
      <span class="dk-status ${s.status}">${sWord(s.status)}</span>
      <span class="dk-age">${fmtAgo(s.last_activity)}</span>
    </a>`;
  // Bound the stopped list — showing all N (117, or 1000 later) is unreasonable. Show the most-recent few
  // with a "show all N" toggle (collapsed by default; state kept in the module so SSE re-renders don't reset it).
  const shownStopped = stoppedExpanded ? stopped : stopped.slice(0, STOPPED_SHOWN);
  const stoppedToggle = stopped.length > STOPPED_SHOWN
    ? `<button class="dk-show-more" data-dk-stopped-toggle>${stoppedExpanded ? 'show fewer' : `show all ${stopped.length} stopped`}</button>`
    : '';
  $('#dk-rows').innerHTML = live.map(row).join('')
    + (stopped.length ? `<div class="dk-sec-row dk-sec-row-sub">STOPPED · ${stopped.length}</div>${shownStopped.map(row).join('')}${stoppedToggle}` : '');
  const tog = $('[data-dk-stopped-toggle]');
  if (tog) tog.onclick = () => { stoppedExpanded = !stoppedExpanded; renderInbox(getHome()); };
  wireCards();
  for (const session of cards) ensureOptionQuestions(session, () => renderInbox(getHome()));
}

async function answer(card, text) {
  const sid = card.dataset.sid;
  const reportId = Number(getHome().sessions?.find((s) => s.id === sid)?.last_key?.id) || null;
  try {
    await api(`api/session/${sid}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source: 'text' }) });
    card.style.opacity = '0.55';
    card.querySelector('.dk-card-actions').innerHTML = `<span class="dk-answered">✓ answered "${esc(text.slice(0, 24))}" — session resumed</span>`;
    card.querySelector('.dk-card-opts')?.remove();
    card.querySelector('.dk-reply')?.remove();
    toast('Sent — session resumed');
    api('api/messages/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, ...(reportId ? { through_id: reportId } : {}) }) }).catch(() => {});
  } catch (e) { toast('⚠ ' + (e.message || e)); }
}

async function dismiss(card) {
  const sid = card.dataset.sid;
  const reportId = Number(getHome().sessions?.find((s) => s.id === sid)?.last_key?.id) || null;
  const btn = card.querySelector('[data-dk-dismiss]');
  if (btn) { btn.disabled = true; btn.textContent = 'Dismissing…'; }
  try {
    const result = await api('api/messages/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, ...(reportId ? { through_id: reportId } : {}) }),
    });
    upsertSession({ id: sid, unread: Number(result?.unread) || 0 });
    toast('Dismissed — it will return when there is a new report');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Dismiss'; }
    toast('⚠ ' + (e.message || e));
  }
}

function paintChoices(card, questions, selections) {
  for (const button of card.querySelectorAll('[data-dk-choice]')) {
    const selected = selections.get(Number(button.dataset.question))?.has(Number(button.dataset.option)) || false;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
  const submit = card.querySelector('[data-dk-choice-submit]');
  if (submit) submit.disabled = !choicesComplete(questions, selections);
}

async function submitChoices(card, session, questions) {
  const selections = selectionsFor(session);
  if (!choicesComplete(questions, selections) || card.classList.contains('submitting')) return;
  card.classList.add('submitting');
  for (const button of card.querySelectorAll('button')) button.disabled = true;
  const submit = card.querySelector('[data-dk-choice-submit]');
  if (submit) submit.textContent = 'Sending choices…';
  try {
    await api(`api/session/${session.id}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: answersPayload(questions, selections) }),
    });
    choiceSelections.delete(session.id);
    upsertSession({ id: session.id, status: 'working', question: null, summary: null, category: null, unread: 0 });
    toast('Choices sent — session resumed');
  } catch (e) {
    card.classList.remove('submitting');
    for (const button of card.querySelectorAll('button')) button.disabled = false;
    paintChoices(card, questions, selections);
    if (submit) submit.textContent = 'Send selected options';
    toast('⚠ ' + (e.message || e));
  }
}

function wireCards() {
  const hero = document.getElementById('dk-hero-start');
  if (hero) hero.onclick = () => openLaunch(); // not a direct handler — the click event must not become openLaunch's opts
  for (const card of document.querySelectorAll('[data-dk-card]')) {
    const session = getHome().sessions?.find((s) => s.id === card.dataset.sid);
    const questions = session ? optionQuestions(session) : [];
    const selections = session ? selectionsFor(session) : new Map();
    for (const button of card.querySelectorAll('[data-dk-choice]')) button.onclick = () => {
      const questionIndex = Number(button.dataset.question);
      const optionIndex = Number(button.dataset.option);
      const question = questions[questionIndex];
      if (!question) return;
      let selected = selections.get(questionIndex);
      if (!selected) { selected = new Set(); selections.set(questionIndex, selected); }
      if (question.multiSelect) {
        selected.has(optionIndex) ? selected.delete(optionIndex) : selected.add(optionIndex);
        if (!selected.size) selections.delete(questionIndex);
      } else {
        selections.set(questionIndex, new Set([optionIndex]));
      }
      paintChoices(card, questions, selections);
      if (!questions.some((item) => item.multiSelect) && choicesComplete(questions, selections)) submitChoices(card, session, questions);
    };
    const choiceSubmit = card.querySelector('[data-dk-choice-submit]');
    if (choiceSubmit) choiceSubmit.onclick = () => submitChoices(card, session, questions);
    const dismissBtn = card.querySelector('[data-dk-dismiss]');
    if (dismissBtn) dismissBtn.onclick = () => dismiss(card);
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
