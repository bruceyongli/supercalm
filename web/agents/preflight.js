import { api, $, escapeHtml } from '../common.js';

// "Council" panel (dual-mode). COUNCIL: an always-open thinking space — open a Thread (explore / review /
// debate / design / decision), talk it through with a panel of models grounded in the project's decision
// history, then OPTIONALLY capture an outcome to the knowledge base / supervision doc / agent. PREFLIGHT:
// the launch-time spec-sharpen pass (kept collapsed below). Council actions go through the agent SDK
// (P.call → /api/session/:id/agents/preflight/<action>); preflight enable/spec use the REST routes.
let P = null;
let host = null;
let pid = null;
let data = null;            // { pf, helpers, models }
let threads = [];           // history list
let kinds = [];             // ['explore', ...]
let active = null;          // full thread view, or null (list view)
let panelModels = [];       // the active advisor panel (chips)
let pendingAtt = [];        // attachments for the next operator message
let busy = '';              // '' | 'round' | 'draft' | 'capture'
let draftText = '';
let captureDest = { wiki: true, decision: false, agent: false };
let captureTouched = { wiki: false, decision: false, agent: false };
let captureResult = null;
let search = '';
let showArchived = false;
let shellSig = '';          // structural signature — re-render the shell only when this changes
let renderedIds = new Set(); // message ids already painted into the transcript (append-only)

const esc = (s) => escapeHtml(String(s ?? ''));
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const PANEL_KEY = 'aios_council_panel';

async function call(action, body) { const r = await P.call(action, body || {}); return r?.result ?? r; }

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's'; const m = Math.round(s / 60); if (m < 60) return m + 'm';
  const h = Math.round(m / 60); if (h < 48) return h + 'h'; return Math.round(h / 24) + 'd';
}

async function load() {
  const sid = P.sessionId;
  const sr = await api('api/session/' + sid).catch(() => null);
  const s = sr?.session || sr || {};
  pid = s.project?.id || s.project_id || null;
  const [pf, helpers, cl] = await Promise.all([
    api(`api/session/${sid}/preflight`).catch(() => null),
    pid ? api(`api/project/${pid}/helpers`).catch(() => null) : Promise.resolve(null),
    call('council-list', { archived: showArchived }).catch(() => null),
  ]);
  data = { pf: pf || { status: 'none' }, helpers: helpers?.helpers || {}, models: helpers?.models || [] };
  threads = cl?.threads || [];
  kinds = cl?.kinds || ['explore', 'review', 'debate', 'design', 'decision'];
  if (!panelModels.length) {
    try { panelModels = JSON.parse(localStorage.getItem(PANEL_KEY) || '[]'); } catch { panelModels = []; }
    if (!panelModels.length) panelModels = cl?.models || [];
  }
  if (active) { const fresh = await call('council-thread', { threadId: active.id }).catch(() => null); active = fresh?.thread || null; }
}

// ---------- view machine ----------
function shellSignature() {
  if (!active) return 'list|' + search + '|' + (showArchived ? 1 : 0) + '|' + threads.map((t) => t.id + t.status + t.updatedAt).join(',') + '|' + (data?.pf?.status || '');
  return 'thread|' + active.id + '|' + esc(active.title) + '|' + (active.kind || '') + '|' + active.status + '|' + panelModels.join(',') + '|' + busy + '|' + pendingAtt.length + '|' + JSON.stringify(captureDest) + '|' + JSON.stringify(captureResult || {});
}

function resetCapture(thread) {
  captureDest = { wiki: true, decision: thread?.kind === 'decision', agent: false };
  captureTouched = { wiki: false, decision: false, agent: false };
  captureResult = null;
}
function open(thread) { active = thread; draftText = ''; resetCapture(thread); renderedIds = new Set(); render(true); }
function back() { active = null; render(true); }

// ---------- list (history) ----------
function listItemsHtml() {
  const q = search.trim().toLowerCase();
  const rows = threads.filter((t) => !q || (t.title + ' ' + (t.summary || '')).toLowerCase().includes(q));
  if (!rows.length) return `<p class="kn-note">${q ? 'No threads match.' : 'No threads yet. Start one to think a topic through with a panel of models.'}</p>`;
  return rows.map((t) => `
    <div class="cl-row" data-id="${esc(t.id)}">
      <div class="cl-row-main">
        <div class="cl-row-top">${t.kind ? `<span class="cl-kind k-${esc(t.kind)}">${esc(t.kind)}</span>` : ''}<span class="cl-row-title">${esc(t.title)}</span></div>
        ${t.summary ? `<div class="cl-row-sum">${esc(t.summary)}</div>` : ''}
        <div class="cl-row-meta">${ago(t.updatedAt)} ago · ${t.count} msg${t.status === 'captured' ? ' · captured' : ''}</div>
      </div>
      <div class="cl-row-actions">
        <button class="cl-icon" data-act="archive" data-id="${esc(t.id)}" title="${showArchived ? 'unarchive' : 'archive'}">${showArchived ? '↩' : '⌫'}</button>
        <button class="cl-icon" data-act="delete" data-id="${esc(t.id)}" title="delete">✕</button>
      </div>
    </div>`).join('');
}
function listHtml() {
  return `<section class="kn-sec cl-sec">
    <div class="cl-bar"><b>Council</b><button class="btn sm" id="cl-new">+ New thread</button></div>
    <div class="cl-bar"><input id="cl-search" class="cl-search" placeholder="search threads…" value="${esc(search)}"/><label class="cl-arch"><input type="checkbox" id="cl-show-arch" ${showArchived ? 'checked' : ''}/> archived</label></div>
    <div class="cl-list">${listItemsHtml()}</div>
  </section>`;
}

// ---------- thread ----------
const STARTERS = [
  ['explore', 'Explore options for…'],
  ['review', 'Review this approach:…'],
  ['design', 'Critique this design:…'],
  ['decision', 'Help me decide between…'],
];
function kindChipsHtml() {
  return `<div class="cl-kinds">${kinds.map((k) => `<button class="cl-kind k-${esc(k)} ${active.kind === k ? 'on' : ''}" data-kind="${esc(k)}">${esc(k)}</button>`).join('')}</div>`;
}
function modelTagsHtml() {
  const avail = (data?.models || []).map((m) => m.id).filter((id) => !panelModels.includes(id));
  const opts = avail.slice(0, 60).map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
  return `<div class="cl-models-row"><span class="cl-ml-label">panel</span>${panelModels.map((m) => `<span class="cl-tag">${esc(m)}<button class="cl-tag-x" data-rm="${esc(m)}">×</button></span>`).join('')}
    <select id="cl-add-model" class="cl-add-model"><option value="">+ add</option>${opts}</select></div>`;
}
function captureStatusHtml() {
  if (!captureResult) return '';
  const c = captureResult;
  const req = c.requested || {};
  const rows = [];
  if (req.wiki) rows.push(c.wiki ? `Saved: ${esc(c.wiki)}` : `Knowledge base skipped${c.wikiError ? ': ' + esc(c.wikiError) : ''}`);
  if (req.decision) rows.push(c.decision ? 'Decision recorded' : `Decision skipped: ${esc(c.decisionReason || 'not recorded')}`);
  if (req.agent) rows.push(c.agent ? 'Sent to agent' : `Agent skipped: ${esc(c.agentReason || c.agentError || 'not sent')}`);
  return rows.length ? `<div class="cl-capture-status">${rows.map((r) => `<span>${r}</span>`).join('')}</div>` : '';
}
function agentSendGranted() {
  const caps = P?.view?.()?.grant?.caps || [];
  return caps.includes('send-input');
}
function threadHtml() {
  const empty = !active.messages.length;
  const starters = empty ? `<div class="cl-starters">${STARTERS.map(([k, label]) => `<button class="cl-starter" data-fill="${esc(label)}" data-kind="${esc(k)}">${esc(label)}</button>`).join('')}</div>` : '';
  const canSend = agentSendGranted();
  return `<section class="kn-sec cl-sec">
    <div class="cl-bar"><button class="cl-back" id="cl-back">← Threads</button><input id="cl-title" class="cl-title" value="${esc(active.title)}" title="click to rename"/>${active.status === 'captured' ? '<span class="cl-done">captured</span>' : ''}</div>
    ${kindChipsHtml()}
    <div class="cl-transcript" id="cl-transcript"></div>
    ${starters}
    ${pendingAtt.length ? `<div class="cl-pending">attaching: ${pendingAtt.map((a) => `<span class="cl-chip">${a.isImage ? '🖼' : '📄'} ${esc(a.name)}</span>`).join('')}</div>` : ''}
    <textarea id="cl-say" class="cl-say" rows="2" placeholder="Pose the topic, or reply to the panel…"></textarea>
    ${modelTagsHtml()}
    <div class="cl-actions">
      <button class="btn sm" id="cl-ask" ${busy ? 'disabled' : ''}>${busy === 'round' ? 'Asking…' : 'Ask the panel'}</button>
      <button class="btn sm ghost" id="cl-say-btn" ${busy ? 'disabled' : ''}>Add note</button>
      <button class="btn sm ghost" id="cl-attach">Attach</button>
      <input type="file" id="cl-file" style="display:none"/>
      <button class="btn sm ghost" id="cl-draft" ${busy ? 'disabled' : ''}>${busy === 'draft' ? 'Drafting…' : 'Draft outcome'}</button>
    </div>
    <details class="cl-capture" ${draftText ? 'open' : ''}>
      <summary>Capture an outcome</summary>
      <textarea id="cl-out" class="cl-say" rows="4" placeholder="The outcome to keep — a summary, design note, or decision (‘Draft outcome’ fills this from the discussion)">${esc(draftText)}</textarea>
      <div class="cl-dest">
        <label class="sup-check"><input type="checkbox" id="cl-d-wiki" ${captureDest.wiki ? 'checked' : ''}> knowledge base</label>
        <label class="sup-check"><input type="checkbox" id="cl-d-dec" ${captureDest.decision ? 'checked' : ''}> record as a decision</label>
        <label class="sup-check ${canSend ? '' : 'disabled'}" title="${canSend ? '' : 'Grant Council send-input to enable this destination.'}"><input type="checkbox" id="cl-d-agent" ${captureDest.agent ? 'checked' : ''} ${canSend ? '' : 'disabled'}> send to agent</label>
        <button class="btn sm" id="cl-capture" ${busy ? 'disabled' : ''}>${busy === 'capture' ? 'Capturing…' : 'Capture'}</button>
      </div>
      ${captureStatusHtml()}
    </details>
  </section>`;
}

// ---------- transcript (append-only) ----------
function msgHtml(m) {
  if (m.role === 'operator') return `<div class="cl-msg cl-op"><span class="cl-who">You</span><div class="cl-body">${esc(m.content)}</div>${attChips(m.attachments)}</div>`;
  if (m.role === 'advisor') return `<div class="cl-msg cl-adv"><span class="cl-who">${esc(m.model || 'advisor')}</span><div class="cl-body">${esc(m.content)}</div><div class="cl-msg-actions">
    <button class="cl-msg-act" data-focus="debate" data-msg="${esc(m.id)}">Debate</button>
    <button class="cl-msg-act" data-focus="critique" data-msg="${esc(m.id)}">Critique</button>
    <button class="cl-msg-act" data-focus="synthesize" data-msg="${esc(m.id)}">Synthesize</button>
  </div></div>`;
  if (m.role === 'outcome' || m.role === 'decision') return `<div class="cl-msg cl-dec"><span class="cl-who">✓ Captured outcome</span><div class="cl-body">${esc(m.content)}</div></div>`;
  return `<div class="cl-msg"><div class="cl-body">${esc(m.content)}</div></div>`;
}
function attChips(atts) {
  if (!atts || !atts.length) return '';
  return `<div class="cl-atts">${atts.map((a) => `<span class="cl-chip">${a.isImage ? '🖼' : '📄'} ${esc(a.name)}</span>`).join('')}</div>`;
}
// Append only messages not yet painted; never rebuild existing nodes (so scroll + selection survive). full=true
// repaints from scratch (after a shell render / thread switch). Autoscroll only when already near the bottom.
function paintTranscript(full) {
  const tr = $('#cl-transcript');
  if (!tr || !active) return;
  if (full) { tr.innerHTML = ''; renderedIds = new Set(); }
  const nearBottom = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 60;
  let added = 0;
  for (const m of active.messages) { if (renderedIds.has(m.id)) continue; tr.insertAdjacentHTML('beforeend', msgHtml(m)); renderedIds.add(m.id); added++; }
  setThinking(busy === 'round');
  if ((full || (added && nearBottom))) tr.scrollTop = tr.scrollHeight;
}
function setThinking(on) {
  const tr = $('#cl-transcript'); if (!tr) return;
  const ex = tr.querySelector('#cl-thinking');
  if (on && !ex) tr.insertAdjacentHTML('beforeend', `<div class="cl-msg cl-thinking" id="cl-thinking"><span class="cl-who">panel</span><div class="cl-body">thinking… (${esc(panelModels.join(', '))})</div></div>`);
  else if (!on && ex) ex.remove();
}

function focusAdvisorResponse(msgId, mode) {
  if (!active) return;
  const m = active.messages.find((x) => x.id === msgId);
  if (!m) return;
  const model = m.model || 'that advisor';
  const body = String(m.content || '').trim().slice(0, 1800);
  const prompt = {
    debate: `Debate ${model}'s take below. Have the panel argue what is strongest, what is wrong or risky, and what conclusion survives.\n\n${model} said:\n${body}`,
    critique: `Critique ${model}'s take below. Focus on weak assumptions, missing evidence, hidden product risks, and a better architecture if needed.\n\n${model} said:\n${body}`,
    synthesize: `Synthesize ${model}'s take below with the rest of the discussion. Summarize the agreement, disagreement, and the concrete recommendation.\n\n${model} said:\n${body}`,
  }[mode] || '';
  const ta = $('#cl-say');
  if (ta && prompt) {
    ta.value = prompt;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = 0;
    captureResult = null;
    P.markDirty?.();
  }
}

// ---------- render ----------
function render(forceShell) {
  if (!host) return;
  const sig = shellSignature();
  if (!forceShell && sig === shellSig) { if (active) paintTranscript(false); return; }
  shellSig = sig;
  const pf = data?.pf || { status: 'none' };
  const h = data?.helpers || {};
  const spec = pf.spec || '';
  const secs = pf.latencyMs ? ` · ${Math.round(pf.latencyMs / 1000)}s` : '';
  host.innerHTML = `<div class="kn-pane">
    ${active ? threadHtml() : listHtml()}
    <details class="kn-sec cl-preflight">
      <summary>Preflight — launch-time spec sharpen</summary>
      <div class="kn-head">Interrogates the task against the repo before a fresh launch and prepends an advisory brief.</div>
      <label class="kn-toggle"${pid ? '' : ' style="opacity:.5"'}><input type="checkbox" id="pf-on" ${h.preflight ? 'checked' : ''} ${pid ? '' : 'disabled'}> sharpen on launch — ${pid ? 'this project' : '(no project)'}</label>
      <div class="kn-row"><span class="kn-meta">This session: <b>${esc(pf.status || 'none')}</b>${pf.model ? ' · ' + esc(pf.model) : ''}${secs}</span></div>
      ${spec ? `<pre class="kn-doc kn-ro">${esc(spec)}</pre>` : `<p class="kn-note">No spec for this session${h.preflight ? ' yet (runs on a fresh launch)' : ''}.</p>`}
    </details>
  </div>`;
  if (active) paintTranscript(true);
  wire();
}

function wire() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el[ev] = fn; };
  // preflight
  on('#pf-on', 'onchange', (e) => { if (pid) post(`api/project/${pid}/helpers`, { preflight: e.target.checked }).then((r) => { if (r?.helpers) data.helpers = r.helpers; }); });

  if (!active) {
    // list view
    on('#cl-new', 'onclick', async () => { const r = await call('council-open', {}); if (r?.thread) { await load(); open(r.thread); } });
    on('#cl-search', 'oninput', (e) => { search = e.target.value; renderList(); });
    on('#cl-show-arch', 'onchange', async (e) => { showArchived = e.target.checked; await load(); render(true); });
    wireRows();
    return;
  }

  // thread view
  on('#cl-back', 'onclick', () => back());
  on('#cl-transcript', 'onclick', (e) => {
    const b = e.target.closest?.('.cl-msg-act');
    if (!b) return;
    focusAdvisorResponse(b.dataset.msg, b.dataset.focus);
  });
  on('#cl-title', 'onchange', async (e) => { const v = e.target.value.trim(); if (v && v !== active.title) { const r = await call('council-rename', { threadId: active.id, title: v }); if (r?.thread) { active = r.thread; shellSig = ''; } } });
  on('#cl-say', 'oninput', () => { captureResult = null; P.markDirty?.(); });
  on('#cl-out', 'oninput', (e) => { draftText = e.target.value; captureResult = null; P.markDirty?.(); });
  host.querySelectorAll('.cl-kinds .cl-kind').forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.kind === active.kind ? null : b.dataset.kind;
      const r = await call('council-kind', { threadId: active.id, kind: k });
      if (r?.thread) {
        active = r.thread;
        if (!captureTouched.decision) captureDest.decision = active.kind === 'decision';
        render(true);
      }
    };
  });
  host.querySelectorAll('.cl-tag-x').forEach((b) => { b.onclick = () => { panelModels = panelModels.filter((m) => m !== b.dataset.rm); savePanel(); render(true); }; });
  on('#cl-add-model', 'onchange', (e) => { const v = e.target.value; if (v && !panelModels.includes(v)) { panelModels.push(v); savePanel(); render(true); } });
  host.querySelectorAll('.cl-starter').forEach((b) => { b.onclick = async () => { const ta = $('#cl-say'); if (ta) { ta.value = b.dataset.fill; ta.focus(); } if (b.dataset.kind && !active.kind) { const r = await call('council-kind', { threadId: active.id, kind: b.dataset.kind }); if (r?.thread) { active = r.thread; if (!captureTouched.decision) captureDest.decision = active.kind === 'decision'; render(true); } } }; });
  [
    ['#cl-d-wiki', 'wiki'],
    ['#cl-d-dec', 'decision'],
    ['#cl-d-agent', 'agent'],
  ].forEach(([sel, key]) => on(sel, 'onchange', (e) => {
    captureDest[key] = !!e.target.checked;
    captureTouched[key] = true;
    captureResult = null;
    P.markDirty?.();
  }));

  const takeSay = () => ($('#cl-say')?.value || '').trim();
  on('#cl-say-btn', 'onclick', async () => { const text = takeSay(); if (!text && !pendingAtt.length) return; const r = await call('council-say', { threadId: active.id, text, attachments: pendingAtt }); pendingAtt = []; if (r?.thread) active = r.thread; P.clearDirty?.(); render(true); });
  on('#cl-ask', 'onclick', async () => {
    if (busy) return; busy = 'round';
    const text = takeSay();
    try {
      if (text || pendingAtt.length) { const r = await call('council-say', { threadId: active.id, text, attachments: pendingAtt }); pendingAtt = []; if (r?.thread) active = r.thread; P.clearDirty?.(); }
      render(true); setThinking(true);
      const r = await call('council-round', { threadId: active.id, models: panelModels });
      if (r?.thread) active = r.thread;
    } catch (e) { alert('Round failed: ' + (e.message || e)); }
    finally { busy = ''; shellSig = ''; render(true); }
  });
  on('#cl-draft', 'onclick', async () => {
    if (busy) return; busy = 'draft'; render(true);
    try { const r = await call('council-draft', { threadId: active.id, model: panelModels[0] }); draftText = r?.draft || draftText; }
    catch (e) { alert('Draft failed: ' + (e.message || e)); }
    finally { busy = ''; shellSig = ''; render(true); }
  });
  on('#cl-capture', 'onclick', async () => {
    const text = ($('#cl-out')?.value || '').trim();
    if (!text) { alert('Write or draft the outcome first.'); return; }
    const dest = {
      wiki: $('#cl-d-wiki')?.checked,
      decision: $('#cl-d-dec')?.checked,
      agent: $('#cl-d-agent')?.checked,
    };
    captureDest = { ...captureDest, ...dest };
    captureResult = null;
    busy = 'capture'; render(true);
    try {
      const r = await call('council-capture', { threadId: active.id, title: active.title, text, dest });
      if (r?.thread) active = r.thread;
      captureResult = r?.captured || null;
      draftText = '';
      P.clearDirty?.();
    }
    catch (e) { alert('Capture failed: ' + (e.message || e)); }
    finally { busy = ''; shellSig = ''; render(true); }
  });

  const attach = $('#cl-attach'); const file = $('#cl-file');
  if (attach && file) {
    attach.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0]; if (!f) return;
      try {
        const data_base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^data:[^,]+,/, '')); r.onerror = rej; r.readAsDataURL(f); });
        const up = await post(`api/session/${P.sessionId}/upload`, { name: f.name, type: f.type, data_base64 });
        const a = up?.attachment || up;
        if (a?.path || a?.name) { pendingAtt.push({ name: a.name || f.name, path: a.path, type: a.type || f.type, isImage: !!a.isImage }); shellSig = ''; render(true); }
      } catch (e) { alert('Upload failed: ' + (e.message || e)); }
    };
  }
}
function wireRows() {
  host.querySelectorAll('.cl-row').forEach((row) => {
    row.onclick = async (e) => { if (e.target.closest('.cl-row-actions')) return; const r = await call('council-thread', { threadId: row.dataset.id }); if (r?.thread) open(r.thread); };
  });
  host.querySelectorAll('.cl-icon').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      if (b.dataset.act === 'delete') { if (!confirm('Delete this thread?')) return; await call('council-delete', { threadId: id }); }
      else await call('council-archive', { threadId: id, archived: !showArchived });
      await load(); render(true);
    };
  });
}
function renderList() { const l = $('.cl-list'); if (l) { l.innerHTML = listItemsHtml(); wireRows(); } }
function savePanel() { try { localStorage.setItem(PANEL_KEY, JSON.stringify(panelModels)); } catch {} }

export const panel = {
  async mount(el, papi) { P = papi; host = el; await load(); render(true); },
  async update() {
    if (P?.isDirty?.()) return;
    // In a thread, a poll never changes the transcript (it only changes via our actions) — leave the DOM
    // (and your scroll/selection) alone; just keep the threads cache warm for when you go back.
    if (active) { try { const cl = await call('council-list', { archived: showArchived }); threads = cl?.threads || threads; } catch {} return; }
    await load();
    if (shellSignature() !== shellSig) render(false);
  },
  unmount() { host = null; },
};
