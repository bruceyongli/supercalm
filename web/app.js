import { $, $$, api, coalesce, fmtAgo, escapeHtml, wireMic, registerSW, enablePush, pushStatus, isInteracting, setDashboardBrowserIdentity } from './common.js';
import { startVoiceMode } from './voicemode.js';

let STATE = { sessions: [], projects: [], queue: [], tools: [], counts: {} };

async function refresh() {
  try {
    STATE = await api('api/state');
    render();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

function render() {
  setDashboardBrowserIdentity(STATE);
  renderCounts();
  renderQueue();
  renderSessions();
  renderProjects();
}

function renderCounts() {
  const c = STATE.counts || {};
  $('#counts').innerHTML =
    `<span class="pill warn"><b>${c.waiting || 0}</b> waiting</span>` +
    `<span class="pill go"><b>${c.working || 0}</b> working</span>` +
    `<span class="pill"><b>${c.live || 0}</b> live</span>`;
}

function badge(s) {
  return `<span class="badge" style="border-color:${s.toolColor}99;color:${s.toolColor}">${s.toolLabel}</span>`;
}
function where(s) {
  return s.project ? s.project.name : '(adhoc)';
}
function meta(s) {
  const bits = [s.modelLabel, s.fastMode ? 'fast' : null, s.effort, s.autonomy, s.orchestration && s.orchestration !== 'off' ? '⚡' + s.orchestration : null].filter(Boolean);
  return bits.length ? `<span class="tags">${bits.join(' · ')}</span>` : '';
}

const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const CAT_PRIO = { action: 0, decision: 1, review: 2 };
const catOf = (s) => (CAT_PRIO[s.category] != null ? s.category : 'pending');

// Reconciling render: update existing cards in place so the composer (textarea text,
// focus, mic state) is NEVER destroyed by a live refresh. Only add/remove/reorder.
const qcards = new Map();
function renderQueue() {
  if (isInteracting($('#queue'))) return; // don't wipe a reply you're typing / a card you're reading
  const q = (STATE.queue || []).slice().sort((a, b) => (CAT_PRIO[a.category] ?? 1.5) - (CAT_PRIO[b.category] ?? 1.5));
  $('#needs-count').textContent = q.length;
  $('#needs').classList.toggle('has', q.length > 0);
  const box = $('#queue');
  const ids = new Set(q.map((s) => s.id));
  for (const [id, e] of qcards) if (!ids.has(id)) { e.card.remove(); qcards.delete(id); }
  let emptyEl = $('#queue-empty');
  if (!q.length) {
    if (!emptyEl) box.innerHTML = '<div class="empty" id="queue-empty">Nothing needs you. Sessions are working or idle.</div>';
    return;
  }
  if (emptyEl) emptyEl.remove();
  q.forEach((s, i) => {
    let e = qcards.get(s.id);
    if (!e) {
      e = createCard(s);
      qcards.set(s.id, e);
    }
    updateCard(e, s);
    if (box.children[i] !== e.card) box.insertBefore(e.card, box.children[i] || null);
  });
}

function createCard(s) {
  const card = document.createElement('div');
  card.className = 'qcard';
  const top = document.createElement('div');
  top.className = 'top';
  const catEl = document.createElement('span');
  catEl.className = 'cat-badge';
  const badgeEl = document.createElement('span');
  const metaEl = document.createElement('span');
  metaEl.className = 'qmeta';
  const spacer = document.createElement('span');
  spacer.className = 'qcard-spacer';
  const expand = document.createElement('button');
  expand.className = 'iconbtn';
  expand.title = 'Show full context';
  expand.innerHTML = EXPAND_ICON;
  const open = document.createElement('a');
  open.className = 'qcard-open';
  open.textContent = 'open ↗';
  open.href = 'session?id=' + s.id;
  const reply = document.createElement('button');
  reply.className = 'btn ghost sm reply-btn';
  reply.textContent = 'Reply';
  const actions = document.createElement('span');
  actions.className = 'qcard-actions';
  actions.append(reply, expand, open);
  top.append(catEl, badgeEl, metaEl, spacer, actions);
  const summaryEl = document.createElement('div');
  summaryEl.className = 'summary';
  const snapEl = document.createElement('pre');
  snapEl.className = 'snap';
  snapEl.hidden = true;
  const comp = composer(s.id);
  comp.hidden = true; // collapsed by default to keep the list compact; Reply reveals it
  reply.onclick = () => {
    comp.hidden = !comp.hidden;
    reply.classList.toggle('on', !comp.hidden);
    if (!comp.hidden) {
      const ta = comp.querySelector('textarea');
      if (ta) ta.focus();
    }
  };
  card.append(top, summaryEl, snapEl, comp);
  expand.onclick = async () => {
    snapEl.hidden = !snapEl.hidden;
    expand.classList.toggle('on', !snapEl.hidden);
    if (!snapEl.hidden) {
      snapEl.textContent = 'loading…';
      try {
        const d = await api('api/session/' + s.id);
        snapEl.textContent = (d.snapshot || '').split('\n').filter((l) => l.trim()).slice(-60).join('\n') || '(no output)';
      } catch (e) {
        snapEl.textContent = 'failed to load: ' + e.message;
      }
    }
  };
  return { card, catEl, badgeEl, metaEl, summaryEl };
}

function updateCard(e, s) {
  const cat = catOf(s);
  e.card.className = 'qcard cat-' + cat;
  e.catEl.textContent = cat === 'pending' ? '…' : cat;
  e.badgeEl.innerHTML = `${badge(s)} <b>${escapeHtml(where(s))}</b>`;
  e.metaEl.innerHTML = meta(s);
  e.summaryEl.textContent = s.summary || (cat === 'pending' ? 'summarizing…' : s.title || '');
}

function composer(sessionId) {
  const wrap = document.createElement('div');
  wrap.className = 'composer';
  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.placeholder = 'Reply…';
  const status = document.createElement('span');
  status.className = 'mic-status';
  const mic = document.createElement('button');
  mic.className = 'btn ghost mic';
  const send = document.createElement('button');
  send.className = 'btn';
  send.textContent = 'Send';
  wrap.append(ta, status, mic, send);

  send.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      const r = await fetch(`api/session/${sessionId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, source: 'text' }),
      });
      if (r.status === 409) {
        if (confirm('This session has stopped. Resume it now? (then Send again in a few seconds)')) {
          await api(`api/session/${sessionId}/resume`, { method: 'POST' });
        }
      } else if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('Send failed: ' + (j.error || r.status));
      } else {
        ta.value = '';
      }
    } catch (e) {
      alert('Send failed: ' + e.message);
    } finally {
      send.disabled = false;
    }
  };

  wireMic(mic, ta, status);
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send.click();
  });
  return wrap;
}

function sessionRow(s) {
  const row = document.createElement('div');
  row.className = 'srow';
  const resumeBtn = s.status === 'exited' ? `<button class="btn ghost sm" data-resume="${s.id}">resume</button>` : '';
  row.innerHTML =
    `<span class="dot ${s.status}"></span>${badge(s)}` +
    `<span class="title"><b>${where(s)}</b> <span class="muted">${escapeHtml(s.title || '')}</span> ${meta(s)}</span>` +
    `<span class="meta status-txt ${s.status}">${s.status}</span>` +
    `<span class="meta hide-sm">${fmtAgo(s.last_activity)} ago</span>` +
    resumeBtn +
    `<a class="btn ghost sm" href="session?id=${s.id}">open</a>`;
  const rb = row.querySelector('[data-resume]');
  if (rb)
    rb.onclick = async (e) => {
      e.preventDefault();
      rb.disabled = true;
      rb.textContent = '…';
      try {
        await api(`api/session/${s.id}/resume`, { method: 'POST' });
        location.href = new URL('session?id=' + s.id, document.baseURI).href;
      } catch (err) {
        alert('Resume failed: ' + err.message);
        rb.disabled = false;
        rb.textContent = 'resume';
      }
    };
  return row;
}
const PREF_RECENT_OPEN = 'aios.dash.recentOpen';
let recentOpen = localStorage.getItem(PREF_RECENT_OPEN) === '1';
function renderSessions() {
  const box = $('#sessions');
  if (isInteracting(box)) return; // don't collapse the expanded "Recent" list out from under you
  const all = STATE.sessions || [];
  const live = all.filter((s) => s.status !== 'exited');
  const dead = all.filter((s) => s.status === 'exited').slice(0, 12);
  box.innerHTML = '';
  if (!all.length) {
    box.innerHTML = '<div class="empty">No sessions yet. Click <b>+ Session</b> to launch one.</div>';
    return;
  }
  if (!live.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'empty', innerHTML: 'No active sessions.' }));
  for (const s of live) box.appendChild(sessionRow(s));
  if (dead.length) {
    const det = document.createElement('details');
    det.className = 'recent';
    det.open = recentOpen; // survive the ~3s 'changed' re-render so the list stays expanded to click Resume
    det.addEventListener('toggle', () => {
      recentOpen = det.open;
      localStorage.setItem(PREF_RECENT_OPEN, det.open ? '1' : '0');
    });
    det.innerHTML = `<summary class="muted">Recent · exited (${dead.length})</summary>`;
    for (const s of dead) {
      const r = sessionRow(s);
      r.style.opacity = '0.5';
      det.appendChild(r);
    }
    box.appendChild(det);
  }
}

function renderProjects() {
  const box = $('#projects');
  const list = STATE.projects || [];
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">No projects registered.</div>';
    return;
  }
  for (const p of list) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `<b>${escapeHtml(p.name)}</b><span class="path">${escapeHtml(p.path)}</span><button class="x" data-del="${p.id}" title="Remove from list">×</button>`;
    chip.querySelector('[data-del]').onclick = async () => {
      if (!confirm(`Remove project "${p.name}" from the list?\n(The folder and session history stay — it's just unlisted.)`)) return;
      try {
        await api(`api/projects/${p.id}`, { method: 'DELETE' });
        refresh();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    };
    box.appendChild(chip);
  }
}

// ---- modals -----------------------------------------------------------------
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
$$('[data-close]').forEach((b) => (b.onclick = () => (b.closest('.modal').hidden = true)));
$$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

let nsTool = 'claude',
  nsModel = null,
  nsAutonomy = null,
  nsEffort = null,
  nsFast = false,
  nsOrch = null;
const AUTONOMY_LABELS = { ask: 'Ask', auto: 'Auto', full: 'Full' };

function selectedNewSessionModel() {
  return (STATE.tools.find((x) => x.id === nsTool)?.models || []).find((m) => m.id === nsModel);
}

function renderSeg(sel, items, current, onPick) {
  const box = $(sel);
  box.innerHTML = items.map((it) => `<button data-v="${it.value}" class="${it.value === current ? 'on' : ''}">${it.label}</button>`).join('');
  $$(sel + ' button').forEach((b) => (b.onclick = () => {
    onPick(b.dataset.v);
    $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b));
  }));
}
function updateToolDeps() {
  const t = STATE.tools.find((x) => x.id === nsTool);
  const models = (t && t.models) || [];
  const modelSel = $('#ns-model');
  const modelLabel = modelSel ? modelSel.previousElementSibling : null;
  if (modelSel) {
    if (models.length) {
      modelSel.style.display = '';
      if (modelLabel) modelLabel.style.display = '';
      if (!models.some((m) => m.id === nsModel)) nsModel = t.model || models[0].id;
      modelSel.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label || m.id)}</option>`).join('');
      modelSel.value = nsModel;
      modelSel.onchange = () => {
        nsModel = modelSel.value;
        updateToolDeps();
      };
    } else {
      modelSel.style.display = 'none';
      if (modelLabel) modelLabel.style.display = 'none';
      nsModel = null;
    }
  }
  const selectedModel = selectedNewSessionModel();
  const fastToggle = $('#ns-fast');
  if (fastToggle) {
    const showFast = nsTool === 'codex' && !!selectedModel?.supportsFast;
    if (!showFast) nsFast = false;
    fastToggle.hidden = !showFast;
    fastToggle.style.display = showFast ? '' : 'none';
    fastToggle.setAttribute('aria-pressed', showFast && nsFast ? 'true' : 'false');
    fastToggle.classList.toggle('on', showFast && !!nsFast);
    fastToggle.onclick = () => {
      nsFast = !nsFast;
      fastToggle.setAttribute('aria-pressed', nsFast ? 'true' : 'false');
      fastToggle.classList.toggle('on', nsFast);
    };
  }
  const efforts = (t && t.efforts) || [];
  const note = $('#ns-effort-note');
  if (efforts.length) {
    $('#ns-effort').style.display = '';
    if (!efforts.includes(nsEffort)) nsEffort = t.defaultEffort;
    renderSeg('#ns-effort', efforts.map((e) => ({ value: e, label: e })), nsEffort, (v) => (nsEffort = v));
    note.textContent = selectedModel ? `· model ${selectedModel.label || selectedModel.id}` : t.modelLabel ? `· model ${t.modelLabel}` : '';
  } else {
    $('#ns-effort').style.display = 'none';
    note.textContent = t ? `${t.label} · model ${(selectedModel && (selectedModel.label || selectedModel.id)) || t.modelLabel || '-'} (no effort setting)` : '';
  }
  // orchestration (claude only: ultracode / workflow) — show/hide like effort
  const orchs = (t && t.orchestrations) || [];
  const orchLabel = $('#ns-orch-label');
  if (orchs.length) {
    $('#ns-orch').style.display = '';
    if (orchLabel) orchLabel.style.display = '';
    if (!orchs.includes(nsOrch)) nsOrch = t.defaultOrchestration;
    renderSeg('#ns-orch', orchs.map((o) => ({ value: o, label: o })), nsOrch, (v) => (nsOrch = v));
  } else {
    $('#ns-orch').style.display = 'none';
    if (orchLabel) orchLabel.style.display = 'none';
    nsOrch = null;
  }
}
// ↻ in the Model label: re-pull the live model lists (proxy fleet / CLIs) without leaving the modal.
const nsRescan = $('#ns-rescan');
if (nsRescan) {
  nsRescan.onclick = async () => {
    nsRescan.disabled = true;
    nsRescan.textContent = '…';
    const msg = $('#ns-msg');
    msg.className = 'msg';
    try {
      const r = await api('api/models/refresh', { method: 'POST' });
      await refresh(); // STATE.tools picks up the new catalog
      updateToolDeps();
      msg.textContent = r.added && r.added.length
        ? `+${r.added.length} new model(s): ${r.added.slice(0, 5).map((a) => a.label || a.id).join(', ')}${r.added.length > 5 ? '…' : ''}`
        : `models up to date (${r.modelCount})`;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = 'rescan failed: ' + e.message;
    }
    nsRescan.disabled = false;
    nsRescan.textContent = '↻';
  };
}
$('#btn-new').onclick = () => {
  nsAutonomy = nsAutonomy || (STATE.defaults && STATE.defaults.autonomy) || 'full';
  const sel = $('#ns-project');
  sel.innerHTML = '<option value="">— pick or use path below —</option>' +
    STATE.projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  renderSeg('#ns-tool', STATE.tools.map((t) => ({ value: t.id, label: t.label })), nsTool, (v) => {
    nsTool = v;
    nsModel = null;
    updateToolDeps();
  });
  renderSeg('#ns-autonomy', (STATE.autonomyLevels || ['ask', 'auto', 'full']).map((a) => ({ value: a, label: AUTONOMY_LABELS[a] || a })), nsAutonomy, (v) => (nsAutonomy = v));
  updateToolDeps();
  $('#ns-msg').textContent = '';
  openModal('#modal-new');
};
$('#ns-go').onclick = async () => {
  const body = {
    project_id: $('#ns-project').value || undefined,
    path: $('#ns-path').value.trim() || undefined,
    tool: nsTool,
    autonomy: nsAutonomy,
    effort: nsEffort,
    model: nsModel || undefined,
    fastMode: nsTool === 'codex' && nsFast && !!selectedNewSessionModel()?.supportsFast,
    orchestration: nsOrch || undefined,
    task: $('#ns-task').value.trim() || undefined,
  };
  const msg = $('#ns-msg');
  msg.className = 'msg';
  msg.textContent = 'launching…';
  try {
    const s = await api('api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    closeModal('#modal-new');
    $('#ns-path').value = '';
    $('#ns-task').value = '';
    location.href = new URL('session?id=' + s.id, document.baseURI).href;
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
};

$('#btn-project').onclick = () => { $('#pr-msg').textContent = ''; openModal('#modal-project'); };
$('#pr-go').onclick = async () => {
  const msg = $('#pr-msg');
  msg.className = 'msg';
  msg.textContent = 'saving…';
  try {
    await api('api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('#pr-name').value.trim(), path: $('#pr-path').value.trim() }),
    });
    closeModal('#modal-project');
    $('#pr-name').value = '';
    $('#pr-path').value = '';
    refresh();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
};

// ---- push notifications -----------------------------------------------------
registerSW();
const notifyBtn = $('#btn-notify');
async function refreshNotifyBtn() {
  const st = await pushStatus();
  notifyBtn.textContent = st === 'on' ? '🔔' : '🔕';
  notifyBtn.title = st === 'on' ? 'Notifications on' : 'Enable push notifications';
  notifyBtn.style.opacity = st === 'on' ? '1' : '0.65';
}
notifyBtn.onclick = async () => {
  if (await enablePush()) refreshNotifyBtn();
};
refreshNotifyBtn();

$('#btn-voice').onclick = () => startVoiceMode();

const reauthBtn = $('#btn-reauth');
if (reauthBtn)
  reauthBtn.onclick = async () => {
    reauthBtn.disabled = true;
    const old = reauthBtn.textContent;
    reauthBtn.textContent = '↻ …';
    try {
      const r = await api('api/reauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      reauthBtn.textContent = r.relaunched ? `↻ ${r.relaunched} relaunched` : '↻ none stuck';
      refresh();
    } catch (e) {
      reauthBtn.textContent = '↻ failed';
      alert('Re-auth failed: ' + (e.message || e));
    } finally {
      setTimeout(() => { reauthBtn.textContent = old; reauthBtn.disabled = false; }, 2500);
    }
  };
// ---- live updates -----------------------------------------------------------
function clock() {
  $('#clock').textContent = new Date().toLocaleTimeString();
}
setInterval(clock, 1000);
clock();

const es = new EventSource('api/events');
es.addEventListener('changed', coalesce(refresh)); // 10 working agents fire 'changed' ~every poll tick
es.onerror = () => {};

// claude auth mode badge (proxy / aios / cli / pinned) — shows which login sessions use
async function authBadge() {
  const el = $('#auth-badge');
  if (!el) return;
  try {
    const s = await api('api/auth/status');
    el.textContent = s.mode || '?';
    el.className = 'auth-badge am-' + (s.mode || 'none');
    const lnk = $('#lnk-auth');
    if (lnk) {
      const li = (s.providers || []).filter((p) => p.loggedIn).map((p) => p.id);
      lnk.title = `Claude mode: ${s.mode}${s.proxyUp ? ' · proxy up' : ''}${li.length ? ' · logged in: ' + li.join(', ') : ''}`;
    }
  } catch { el.textContent = '?'; }
}
authBadge();
setInterval(authBadge, 30000);

refresh();
setInterval(refresh, 15000); // safety poll
