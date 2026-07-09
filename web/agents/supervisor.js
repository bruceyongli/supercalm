import { fmtAgo } from '../common.js';

// Supervisor panel module — { mount, update } over the agent SDK. Config/verdict/history/models all
// come from the registry view (papi.view()); actions go through papi.call(); enable/caps/config through
// papi.save(). The host's shared dirty-lock (papi.isDirty) guards EVERY edit surface here (doc editor,
// revise box, and the message textarea), fixing the old SSE-clobber bug for all of them.

// Verify verdicts + intervention-kind verdicts share one label/badge map.
const VERDICT_LABEL = {
  on_track: 'On track', needs_attention: 'Needs attention', off_track: 'Off track', complete: 'Verified complete', unknown: 'Unknown',
  answered: 'Answered', draft: 'Draft', challenged: 'Completion check', nudged: 'Unstuck', escalated: 'Escalated',
};
const KIND_LABEL = { answer: 'Answered', gate: 'Completion check', unstick: 'Unstuck', keepworking: 'Keep working', escalate: 'Escalated to you', checkpoint: 'Checkpoint', verify: 'Review', recover: 'API retry' };
const TRIGGER_LABEL = { completion: 'Done check', manual: 'Manual check', checkpoint: 'Checkpoint', sync: 'Auto catch-up' };
// badge class + label for one intervention row (verify/checkpoint colour by verdict; the rest by kind).
function badgeFor(rv) {
  const kind = rv.kind || 'verify';
  if (kind === 'verify' || kind === 'checkpoint') {
    return { cls: 'sup-' + (rv.verdict || 'unknown'), label: (VERDICT_LABEL[rv.verdict] || rv.verdict) + (kind === 'checkpoint' ? ' · checkpoint' : '') };
  }
  return { cls: 'sup-kind-' + kind, label: KIND_LABEL[kind] || kind };
}
function triggerLabel(trigger) {
  return TRIGGER_LABEL[trigger] || trigger || '';
}
function scorePill(rv, compact = false) {
  if (!((rv.kind === 'verify' || rv.kind === 'checkpoint') && rv.score != null)) return '';
  const value = esc(String(rv.score));
  const title = 'Supervisor model confidence; complete means verdict is complete and no criteria are unmet.';
  return compact
    ? `<span class="sup-hist-score" title="${esc(title)}">conf ${value}</span>`
    : `<span class="sup-score" title="${esc(title)}"><span>Confidence</span><b>${value}</b></span>`;
}
const AUTOPILOT_CAPS = ['read-context', 'screenshot', 'model-calls', 'send-input'];

let P = null; // papi
let host = null; // root element
let draft = null; // editable config copy
let editMode = false;
let docExpanded = false; // Supervision Doc starts collapsed (preview) so answer/history are reachable
let reviseText = '';
let busy = ''; // run | generate | revise | save | template
let settingsOpen = false;
let chainOpen = false; // inline model-chain editor visibility
let bgExpanded = false; // "Runs on the server" full-sentence toggle
let saveNotice = '';
let templates = [];
let templatesLoaded = false;

const esc = (s) => P.escapeHtml(s);

const MODES = ['observe', 'copilot', 'autopilot'];
function cfgOf(v) {
  const cfg = { model: '', doc: '', review_template: '', preview_url: '', preview_profiles: [], write_goal_file: false, observe_only: false, copilot_confidence: 0.8, completion_gate: true, stuck_timeout_sec: 300, stop_interval_sec: 60, fallback_models: [], ...(v?.config || {}) };
  // Resolve the send-authority MODE exactly like the server (send_policy.js modeOf): explicit mode wins,
  // else the legacy observe_only flag — so a legacy observe config renders on the right segment and the
  // first save doesn't silently flip it.
  cfg.mode = MODES.includes(cfg.mode) ? cfg.mode : cfg.observe_only ? 'observe' : 'autopilot';
  cfg.preview_profiles = normalizePreviewProfiles(cfg);
  return cfg;
}
// caps the auto-pilot switch grants when enabled (send-input is the point); write-files only when GOAL.md is on.
function autopilotCaps(d) {
  return d.write_goal_file ? [...AUTOPILOT_CAPS, 'write-files'] : [...AUTOPILOT_CAPS];
}

export const panel = {
  mount(el, papi) {
    P = papi;
    host = el;
    el.innerHTML = '<div id="sup-header"></div><div id="sup-doc"></div><div id="sup-learn"></div><div id="sup-result"></div>';
    draft = cfgOf(papi.view());
    // Interaction guard for the Learning card: a pointerdown inside it defers SSE-driven re-renders,
    // so an open evidence fold or a mid-tap Approve is never wiped by innerHTML refresh (clobber class).
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#sup-learn')) learnInteractingUntil = Date.now() + 15000;
    });
    renderAll();
    loadTemplates();
    loadDoctrine(true);
  },
  update(view) {
    if (!view) return;
    // Don't clobber in-progress edits (host already skips update() while dirty, but be defensive).
    if (!P.isDirty() && !editMode && !busy) draft = cfgOf(view);
    renderAll();
  },
};

async function loadTemplates() {
  if (templatesLoaded) return;
  try {
    const r = await P.call('template-list', {});
    templates = r.result?.templates || [];
    templatesLoaded = true;
    renderAll();
  } catch {}
}

function view() {
  return P.view() || {};
}
function data() {
  return view().data || {};
}

function newPreviewId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function normalizePreviewProfiles(d) {
  const raw = Array.isArray(d.preview_profiles) ? d.preview_profiles : [];
  const out = raw.map((p, i) => ({
    id: String(p.id || `preview-${i + 1}`).replace(/[^A-Za-z0-9_.:-]/g, '-'),
    label: p.label || `Preview ${i + 1}`,
    url: p.url || p.preview_url || '',
    enabled: p.enabled !== false,
    passcode_gated: !!(p.passcode_gated ?? p.preview_passcode_gated),
    username: p.username || p.preview_username || '',
    passcode: p.passcode || '',
    passcode_set: !!p.passcode_set,
  }));
  if (!out.length && d.preview_url) {
    out.push({
      id: 'default',
      label: 'Default',
      url: d.preview_url,
      enabled: true,
      passcode_gated: !!d.preview_passcode_gated,
      username: d.preview_username || '',
      passcode: '',
      passcode_set: !!d.preview_passcode_set,
    });
  }
  return out;
}

function previewProfile(d, id) {
  d.preview_profiles = normalizePreviewProfiles(d);
  return d.preview_profiles.find((p) => p.id === id);
}

function previewProfilesHtml(d) {
  const profiles = normalizePreviewProfiles(d);
  const enabledCount = profiles.filter((p) => p.enabled && p.url).length;
  const rows = profiles.length
    ? profiles.map((p, i) => `
      <div class="sup-preview-profile" data-preview-id="${esc(p.id)}">
        <div class="sup-preview-head">
          <label class="sup-check"><input type="checkbox" data-preview-check="${esc(p.id)}" data-field="enabled" ${p.enabled ? 'checked' : ''}/> Use in reviews</label>
          <button class="btn ghost sm" type="button" data-preview-remove="${esc(p.id)}">Remove</button>
        </div>
        <div class="sup-preview-grid">
          <label class="sup-field">Name<input data-preview-field="${esc(p.id)}" data-field="label" value="${esc(p.label || `Preview ${i + 1}`)}" placeholder="dev / rc / prod" /></label>
          <label class="sup-field">URL<input data-preview-field="${esc(p.id)}" data-field="url" value="${esc(p.url || '')}" placeholder="https://app.example.com" /></label>
        </div>
        <label class="sup-check"><input type="checkbox" data-preview-check="${esc(p.id)}" data-field="passcode_gated" ${p.passcode_gated ? 'checked' : ''}/> Passcode-gated preview</label>
        ${p.passcode_gated ? `
          <div class="sup-pc-fields">
            <label class="sup-field">Username (optional)<input data-preview-field="${esc(p.id)}" data-field="username" autocomplete="off" value="${esc(p.username || '')}" /></label>
            <label class="sup-field">Passcode${p.passcode_set ? ' <span class="sup-set">saved</span>' : ''}<input data-preview-field="${esc(p.id)}" data-field="passcode" type="password" autocomplete="new-password" placeholder="${p.passcode_set ? 'unchanged unless retyped' : 'required'}" /></label>
          </div>` : ''}
      </div>`).join('')
    : '<div class="sup-hint">No preview profiles yet.</div>';
  return `
    <div class="sup-preview-tools">
      <div class="sup-hint">${enabledCount ? `${enabledCount} preview${enabledCount === 1 ? '' : 's'} captured during UI reviews.` : 'No enabled preview URL - UI claims need manual screenshots or code-only review.'}</div>
      <button class="btn ghost sm" type="button" id="sup-preview-add">Add preview</button>
    </div>
    <div class="sup-preview-list">${rows}</div>`;
}

function renderAll() {
  renderHeader();
  renderDoc();
  renderLearn();
  renderResult();
  if (Date.now() - doctrineAt > 30000) loadDoctrine(); // piggyback on SSE updates, throttled
  if (Date.now() - pmAt > 30000) loadTasks(); // task card (Project Memory), same throttle
}

// ---- Learning (operator doctrine) -------------------------------------------
// What the supervisor has LEARNED from the operator's real replies to builders (distilled server-side,
// automatically — src/agents/doctrine.js). Approving here IS the deployment: active rules enter the
// supervisor's answer+verify prompts on the next tick. Doctrine is global (the operator's style, not a
// per-session setting); rules learned from THIS session are tagged.
let doctrineRules = null; // null = not loaded yet
let doctrineAt = 0;
let learnErr = '';
let learnMsg = ''; // last triage/apply outcome (non-error)
let triaging = false; // ✨ model review in flight
let learnInteractingUntil = 0;
// The whole card collapses (a long review queue would otherwise dominate the panel); the count
// badges stay visible in the summary. Preference persists per browser, collapsed by default.
let learnOpen = localStorage.aios_sup_learn_open === '1';

async function loadDoctrine(force = false) {
  if (!force && Date.now() - doctrineAt < 25000) return;
  doctrineAt = Date.now();
  try {
    const r = await P.api('api/doctrine');
    doctrineRules = r?.rules || [];
    learnErr = '';
  } catch (e) {
    if (doctrineRules === null) doctrineRules = [];
    learnErr = 'failed to load learnings: ' + (e.message || e);
  }
  renderLearn(force);
}

function learnCard(r, mine) {
  // Triage recommendation chip (from the one-click model review) — reason rides in the tooltip.
  const rec = r.status === 'candidate' && r.triage_verdict
    ? (r.triage_verdict === 'approve'
      ? `<span class="sup-badge sm rec-ok" title="${esc(r.triage_reason || '')}">#${r.triage_rank || '?'} ✓ suggested</span> `
      : `<span class="sup-badge sm rec-no" title="${esc(r.triage_reason || '')}">${r.triage_verdict === 'duplicate' ? '⇄ dup' : '✕ suggested reject'}</span> `)
    : '';
  const tag = rec + (mine ? '<span class="sup-badge sm">this session</span>' : '')
    + (r.enforcement === 'audit' ? ' <span class="sup-badge sm" title="checked against work evidence on completion reviews">audit</span>' : '')
    + (r.scope === 'global' ? ' <span class="sup-badge sm">global</span>' : '')
    + (Number(r.violation_count) ? ` <span class="sup-badge sm" title="violations caught">⚠ ${r.violation_count}×</span>` : '');
  const ev = (r.ask || r.response)
    ? `<details class="sup-learn-ev"><summary>evidence</summary><div class="sup-learn-ask">ask ▸ ${esc(r.ask || '')}</div><div class="sup-learn-you">you ▸ ${esc(r.response || '')}</div>${r.divergence ? `<div class="sup-learn-div">divergence ▸ ${esc(r.divergence)}</div>` : ''}</details>`
    : '';
  const when = String(r.situation || '').replace(/^\s*when(ever)?[\s,:]+/i, '');
  if (r.status === 'candidate') {
    return `<div class="sup-learn-item cand" data-did="${esc(r.id)}">
      <div class="sup-learn-when">WHEN ${esc(when)} ${tag}</div>
      <div class="sup-learn-rule">${esc(r.rule)}</div>
      ${ev}
      <div class="sup-learn-actions">
        <button class="btn sm" data-doct="active">✓ Approve</button>
        <button class="btn ghost sm" data-doct="rejected">✕ Reject</button>
      </div>
    </div>`;
  }
  return `<div class="sup-learn-item" data-did="${esc(r.id)}">
    <div class="sup-learn-rule">${esc(r.rule)} <span class="muted">· used ${r.reuse_count || 0}×</span> ${tag}</div>
    ${ev}
  </div>`;
}

function renderLearn(force = false) {
  const hostEl = host.querySelector('#sup-learn');
  if (!hostEl) return;
  // Clobber guard: while the section is EXPANDED the operator is reading/tapping — never re-render
  // under them (actions force through). Collapsed, refresh freely so the count badges stay live.
  if (!force && (Date.now() < learnInteractingUntil || hostEl.querySelector('.sup-learn-wrap[open]'))) return;
  const rules = doctrineRules;
  const enabled = !!view().grant?.enabled;
  if (rules === null) { hostEl.innerHTML = ''; return; }
  // Triage-recommended order (mirrors /decisions): ranked approvals, then untriaged, dups, rejects.
  const recW = (r) => (r.triage_verdict === 'approve' ? (r.triage_rank || 99) : r.triage_verdict === 'duplicate' ? 200 : r.triage_verdict === 'reject' ? 300 : 150);
  const cand = rules.filter((r) => r.status === 'candidate').sort((a, b) => recW(a) - recW(b));
  const act = rules.filter((r) => r.status === 'active');
  const used = act.reduce((a, r) => a + (r.reuse_count || 0), 0);
  const mine = (r) => r.session_id === P.sessionId;
  const recCount = cand.filter((r) => r.triage_verdict).length;
  const summary = `${act.length} rule${act.length === 1 ? '' : 's'} live${used ? ` · applied ${used}×` : ''}${cand.length ? '' : ' · learning from your replies automatically'}`;
  const triageBar = cand.length >= 2 ? `<div class="sup-learn-triage">
      <button class="btn ghost sm" type="button" id="sup-triage" ${triaging ? 'disabled' : ''}>${triaging ? 'Reviewing…' : '✨ Have the supervisor review these'}</button>
      ${recCount && !triaging ? `<button class="btn sm" type="button" id="sup-triage-apply" title="approve the ✓-suggested, reject the ✕/dup-suggested — per-card buttons still work">Apply ${recCount} suggestions</button>` : ''}
    </div>` : '';
  const html = `<section class="su-card sup-learn">
    <details class="sup-learn-wrap"${learnOpen ? ' open' : ''}>
      <summary><h2>Learning</h2>${cand.length ? `<span class="sup-badge to-review">${cand.length} to review</span>` : ''}<span class="sup-badge sm">${act.length} live</span></summary>
      <div class="sup-learn-body">
        <div class="sup-hint">${esc(summary)}${enabled ? '' : ' — supervisor is off; it learns only in supervised sessions'}</div>
        ${learnErr ? `<div class="sup-learn-err">⚠ ${esc(learnErr)}</div>` : ''}
        ${learnMsg ? `<div class="sup-hint">${esc(learnMsg)}</div>` : ''}
        ${triageBar}
        ${cand.map((r) => learnCard(r, mine(r))).join('')}
        ${act.length ? `<details class="sup-learn-group"${cand.length ? '' : ' open'}><summary>Active doctrine (${act.length})</summary>${act.map((r) => learnCard(r, mine(r))).join('')}</details>` : ''}
        <div class="sup-hint"><a href="decisions" target="_blank" rel="noopener">Manage all learnings ▸</a></div>
      </div>
    </details>
  </section>`;
  if (hostEl.__lastHtml === html) return;
  hostEl.__lastHtml = html;
  hostEl.innerHTML = html;
  const wrap = hostEl.querySelector('.sup-learn-wrap');
  if (wrap) wrap.addEventListener('toggle', () => {
    learnOpen = wrap.open;
    try { localStorage.aios_sup_learn_open = learnOpen ? '1' : '0'; } catch {}
  });
  const tBtn = hostEl.querySelector('#sup-triage');
  if (tBtn) tBtn.onclick = async () => {
    triaging = true; learnMsg = ''; hostEl.__lastHtml = ''; renderLearn(true);
    try {
      const r = await P.api('api/doctrine/triage', { method: 'POST' }); // model call — can take a minute
      if (r?.rules) doctrineRules = r.rules;
      learnErr = '';
      learnMsg = `reviewed ${r?.triaged ?? 0} of ${r?.of ?? 0} — suggestion on each card; Apply executes them all`;
    } catch (e) {
      learnErr = 'review failed: ' + (e.message || e) + ' — retry';
    }
    triaging = false; learnInteractingUntil = 0; hostEl.__lastHtml = ''; renderLearn(true);
  };
  const aBtn = hostEl.querySelector('#sup-triage-apply');
  if (aBtn) aBtn.onclick = async () => {
    aBtn.disabled = true;
    try {
      const r = await P.api('api/doctrine/triage/apply', { method: 'POST' });
      if (r?.rules) doctrineRules = r.rules;
      learnErr = '';
      learnMsg = `applied: ${r?.approved || 0} approved · ${(r?.rejected || 0) + (r?.duplicates || 0)} removed`;
    } catch (e) {
      learnErr = 'apply failed: ' + (e.message || e) + ' — retry';
    }
    learnInteractingUntil = 0; hostEl.__lastHtml = ''; renderLearn(true);
  };
  for (const btn of hostEl.querySelectorAll('button[data-doct]')) {
    btn.onclick = async () => {
      const id = btn.closest('[data-did]')?.dataset.did;
      const status = btn.dataset.doct;
      if (!id) return;
      btn.disabled = true;
      try {
        const r = await P.api('api/doctrine/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
        if (r?.rule?.status !== status) throw new Error(r?.error || 'server did not apply the change');
        learnErr = '';
      } catch (e) {
        learnErr = `could not ${status === 'active' ? 'approve' : 'reject'}: ${e.message || e} — retry`;
      }
      learnInteractingUntil = 0;
      hostEl.__lastHtml = '';
      loadDoctrine(true); // force-refreshes past the open-details guard
    };
  }
}

// ---- header -----------------------------------------------------------------
// Mode descriptions — the zero-learning-curve copy under the segmented control.
const MODE_COPY = {
  off: 'Off — pick a mode to start. Co-pilot is the balanced default.',
  observe: 'Watches and learns. Drafts what it would do — sends nothing.',
  copilot: 'Sends only what it’s sure of: confident answers and evidence requests. Everything else waits for you.',
  autopilot: 'Runs the session for you — answers, unsticks, verifies completion. Irreversible calls still come to you.',
};

function renderHeader() {
  const hostEl = host.querySelector('#sup-header');
  if (!hostEl) return;
  const v = view();
  const d = draft;
  const models = data().models || [];
  const on = !!v.grant?.enabled;
  const cur = on ? d.mode : 'off';
  const sendCap = data().sendCapability || {};
  const capMissing = on && d.mode !== 'observe' && !sendCap.sendInputGranted;
  const tmplOpts = '<option value="">Load behavior template…</option>' + templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  // Resolved model chain: what the supervisor will ACTUALLY try, in order (custom list wins wholesale,
  // else pinned model + tool-aware default). Primary = chain[0]; "last used" = the latest review's model.
  const chain = d.fallback_models?.length ? d.fallback_models : (data().modelChain || []);
  const primary = chain[0] || d.model || data().defaultModel || '';
  const lastUsed = data().latest?.model || '';
  const seg = (m, label) =>
    `<button type="button" class="sup-seg${cur === m ? ' on' : ''}" id="sup-mode-${m}" data-mode="${m}" ${busy ? 'disabled' : ''}>${label}</button>`;
  const visionWarn = models.length && chain.length && !chain.some((id) => models.find((mm) => mm.id === id)?.vision)
    ? '<div class="sup-hint sup-warn">Text-only chain: screenshots are captured but not shown to the reviewer.</div>' : '';
  const capAlert = capMissing
    ? '<div class="sup-hint sup-cap-alert"><span>This mode needs the <b>send-input</b> capability and it is not granted.</span><button class="btn sm" id="sup-grant-send" type="button">Grant it</button></div>'
    : '';
  // The supervisor loop runs on the server (launchd daemon), not in this page. Compact: dot + 4 words;
  // hover (title) or click for the full reassurance.
  const BG_FULL = 'Keeps supervising even if you close this page, sleep the laptop, or drop offline.';
  const bgNote = on
    ? `<div class="sup-hint sup-bg" id="sup-bg" title="${esc(BG_FULL)}"><span class="sup-bg-dot"></span> Runs on the server${bgExpanded ? ` <span class="sup-bg-more">— ${esc(BG_FULL)}</span>` : ''}</div>`
    : '';
  hostEl.innerHTML = `
    <section class="su-card sup-head">
      <h2><span>Supervisor</span>
        <span class="sup-mode-seg" id="sup-mode" role="group" aria-label="Supervisor mode">
          ${seg('off', 'Off')}${seg('observe', 'Observe')}${seg('copilot', 'Co-pilot')}${seg('autopilot', 'Autopilot')}
        </span>
      </h2>
      <div class="sup-hint sup-mode-copy">${esc(MODE_COPY[cur] || '')}</div>
      <div class="sup-head-row sup-model-row">
        <span class="sup-model-line">Model <b>${esc(primary)}</b>${lastUsed && lastUsed !== primary ? ` <span class="muted">· last used ${esc(lastUsed)}</span>` : ''}
          <button type="button" class="btn ghost sm" id="sup-chain-toggle">${chainOpen ? 'chain ▾' : 'chain ▸'}</button>
        </span>
        <button class="btn ghost" id="sup-run" ${busy ? 'disabled' : ''}>${busy === 'run' ? 'Checking…' : 'Run check now'}</button>
      </div>
      ${chainOpen ? chainEditorHtml(d, models, chain) : ''}
      ${capAlert}${bgNote}${visionWarn}
      <details class="sup-settings" ${settingsOpen ? 'open' : ''}>
        <summary>Settings</summary>
        <label class="sup-field">Review behavior
          <textarea id="sup-review-template" rows="4" placeholder="Standing review behavior, not this session's goal or acceptance criteria">${esc(d.review_template || '')}</textarea>
        </label>
        <div class="sup-template-row">
          <button class="btn ghost sm" id="sup-template-save" ${busy || !String(d.review_template || '').trim() ? 'disabled' : ''}>Save behavior template</button>
          ${tmplNaming ? `<span class="pm-inline"><input id="sup-template-name" placeholder="Template name" /><button class="btn sm" id="sup-template-name-go">Save</button><button class="btn ghost sm" id="sup-template-name-cancel">Cancel</button></span>` : ''}
          <select id="sup-template-load" ${busy || !templates.length ? 'disabled' : ''}>${tmplOpts}</select>
        </div>
        <div class="sup-field">Preview URLs</div>
        ${previewProfilesHtml(d)}
        <div class="sup-toggles">
          <label class="sup-check"><input type="checkbox" id="sup-gate" ${d.completion_gate ? 'checked' : ''}/> Interrogate &amp; verify before accepting “done”</label>
          <label class="sup-check"><input type="checkbox" id="sup-goaldoubt" ${d.goal_doubt !== false ? 'checked' : ''}/> Pause for me on goal conflicts</label>
          <label class="sup-check"><input type="checkbox" id="sup-goalfile" ${d.write_goal_file ? 'checked' : ''}/> Write GOAL.md on each review</label>
        </div>
        <div class="sup-intervals">
          <label>Step-stuck after <input type="number" id="sup-stuck-int" min="60" max="7200" value="${d.stuck_timeout_sec}"/> s</label>
          <label>Min gap between actions <input type="number" id="sup-stop-int" min="20" max="3600" value="${d.stop_interval_sec}"/> s</label>
          <label>Settle after I message <input type="number" id="sup-settle" min="0" max="3600" value="${d.doc_settle_sec ?? 360}"/> s</label>
          <label>Co-pilot sends at ≥ <input type="number" id="sup-conf" min="0.5" max="1" step="0.05" value="${Number(d.copilot_confidence ?? 0.8)}"/> confidence</label>
        </div>
        <div class="sup-save-row">
          <button class="btn sm" id="sup-save" ${busy ? 'disabled' : ''}>${busy === 'save' ? 'Saving…' : 'Save settings'}</button>
          ${saveNotice ? `<span class="sup-save-note">${esc(saveNotice)}</span>` : ''}
        </div>
      </details>
    </section>`;
  wireHeader();
}
// Inline model-chain editor: the resolved chain as ordered rows (first = primary, ↑↓ reorder, ✕ remove)
// + an add-select grouped by provider. Every action APPLIES immediately (enable-toggle pattern) — the
// list saves as cfg.fallback_models with cfg.model pinned to the first entry.
function chainEditorHtml(d, models, chain) {
  const custom = !!d.fallback_models?.length;
  const inChain = new Set(chain);
  const byProvider = new Map();
  for (const m of models) {
    if (inChain.has(m.id)) continue;
    const p = m.provider || 'other';
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(m);
  }
  const groups = [...byProvider.entries()]
    .map(([p, ms]) => `<optgroup label="${esc(p)}">${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}${m.vision ? ' (vision)' : ''}</option>`).join('')}</optgroup>`)
    .join('');
  const rows = chain.map((id, i) => {
    const m = models.find((mm) => mm.id === id);
    return `<div class="sup-chain-row" data-idx="${i}">
      <span class="sup-chain-pos">${i === 0 ? 'primary' : i + 1}</span>
      <span class="sup-chain-name">${esc(m?.label || id)}${m?.vision ? ' <span class="muted">(vision)</span>' : ''}</span>
      <span class="sup-chain-btns">
        <button type="button" class="btn ghost sm" data-chain-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn ghost sm" data-chain-down="${i}" ${i === chain.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn ghost sm" data-chain-del="${i}">✕</button>
      </span>
    </div>`;
  }).join('');
  return `<div class="sup-chain" id="sup-chain">
    <div class="sup-hint">Tried in order until one answers. First is the primary model.${custom ? '' : ' <span class="muted">(tool-aware default — edit to customize)</span>'}</div>
    ${rows || '<div class="sup-hint muted">No models in the chain.</div>'}
    <div class="sup-chain-add">
      <select id="sup-chain-add"><option value="">Add model…</option>${groups}</select>
      ${custom ? '<button type="button" class="btn ghost sm" id="sup-chain-reset">Reset to default</button>' : ''}
    </div>
  </div>`;
}
function wireHeader() {
  const on = (sel, ev, fn) => {
    const el = host.querySelector(sel);
    if (el) el[ev] = fn;
  };
  on('.sup-settings', 'ontoggle', (e) => {
    settingsOpen = e.target.open;
  });
  host.querySelectorAll('#sup-mode .sup-seg').forEach((el) => {
    el.onclick = () => setMode(el.dataset.mode);
  });
  on('#sup-grant-send', 'onclick', () => setMode(draft.mode)); // re-selecting the mode re-grants the caps
  on('#sup-bg', 'onclick', () => {
    bgExpanded = !bgExpanded;
    renderHeader();
  });
  on('#sup-chain-toggle', 'onclick', () => {
    chainOpen = !chainOpen;
    renderHeader();
  });
  // Chain editor — every action applies immediately (first entry becomes the primary model).
  const chainNow = () => (draft.fallback_models?.length ? [...draft.fallback_models] : [...(data().modelChain || [])]);
  const applyChain = (list) => {
    draft.fallback_models = list;
    // Emptying the custom chain must also un-pin the primary, or the server keeps running the pinned
    // model while the UI shows the tool-aware default chain.
    draft.model = list.length ? list[0] : (data().defaultModel || '');
    saveCfg();
  };
  host.querySelectorAll('[data-chain-up]').forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.chainUp);
      const l = chainNow();
      [l[i - 1], l[i]] = [l[i], l[i - 1]];
      applyChain(l);
    };
  });
  host.querySelectorAll('[data-chain-down]').forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.chainDown);
      const l = chainNow();
      [l[i + 1], l[i]] = [l[i], l[i + 1]];
      applyChain(l);
    };
  });
  host.querySelectorAll('[data-chain-del]').forEach((el) => {
    el.onclick = () => {
      const l = chainNow();
      l.splice(Number(el.dataset.chainDel), 1);
      applyChain(l);
    };
  });
  on('#sup-chain-add', 'onchange', (e) => {
    if (!e.target.value) return;
    applyChain([...chainNow(), e.target.value]);
  });
  on('#sup-chain-reset', 'onclick', () => applyChain([]));
  on('#sup-review-template', 'oninput', (e) => {
    draft.review_template = e.target.value;
    P.markDirty();
  });
  on('#sup-template-save', 'onclick', () => { tmplNaming = true; renderHeader(); setTimeout(() => host.querySelector('#sup-template-name')?.focus(), 40); });
  on('#sup-template-name-cancel', 'onclick', () => { tmplNaming = false; renderHeader(); });
  on('#sup-template-name-go', 'onclick', () => saveTemplate(host.querySelector('#sup-template-name')?.value || ''));
  on('#sup-template-load', 'onchange', (e) => loadTemplate(e.target.value));
  on('#sup-gate', 'onchange', (e) => {
    draft.completion_gate = e.target.checked;
    P.markDirty();
  });
  on('#sup-conf', 'oninput', (e) => {
    draft.copilot_confidence = Math.min(1, Math.max(0, Number(e.target.value) || 0.8));
    P.markDirty();
  });
  on('#sup-goalfile', 'onchange', (e) => {
    draft.write_goal_file = e.target.checked;
    P.markDirty();
  });
  on('#sup-stuck-int', 'oninput', (e) => {
    draft.stuck_timeout_sec = Number(e.target.value) || 300;
    P.markDirty();
  });
  on('#sup-stop-int', 'oninput', (e) => {
    draft.stop_interval_sec = Number(e.target.value) || 60;
    P.markDirty();
  });
  on('#sup-settle', 'oninput', (e) => {
    draft.doc_settle_sec = Math.max(0, Number(e.target.value) || 0);
    P.markDirty();
  });
  on('#sup-goaldoubt', 'onchange', (e) => {
    draft.goal_doubt = e.target.checked;
    P.markDirty();
  });
  host.querySelectorAll('[data-preview-field]').forEach((el) => {
    el.oninput = () => {
      const p = previewProfile(draft, el.dataset.previewField);
      if (!p) return;
      p[el.dataset.field] = el.value;
      saveNotice = '';
      P.markDirty();
    };
  });
  host.querySelectorAll('[data-preview-check]').forEach((el) => {
    el.onchange = () => {
      const p = previewProfile(draft, el.dataset.previewCheck);
      if (!p) return;
      p[el.dataset.field] = el.checked;
      saveNotice = '';
      P.markDirty();
      if (el.dataset.field === 'passcode_gated') renderHeader();
    };
  });
  host.querySelectorAll('[data-preview-remove]').forEach((el) => {
    el.onclick = () => {
      draft.preview_profiles = normalizePreviewProfiles(draft).filter((p) => p.id !== el.dataset.previewRemove);
      if (!draft.preview_profiles.length) {
        // Removing the LAST profile must also clear the legacy single-preview fields, or
        // normalizePreviewProfiles re-materializes a "default" profile from preview_url on next render.
        draft.preview_url = '';
        draft.preview_passcode_gated = false;
        draft.preview_username = '';
      }
      settingsOpen = true;
      saveNotice = '';
      P.markDirty();
      renderHeader();
    };
  });
  on('#sup-preview-add', 'onclick', () => {
    draft.preview_profiles = normalizePreviewProfiles(draft);
    draft.preview_profiles.push({ id: newPreviewId(), label: `Preview ${draft.preview_profiles.length + 1}`, url: '', enabled: true, passcode_gated: false, username: '', passcode: '', passcode_set: false });
    settingsOpen = true;
    saveNotice = '';
    P.markDirty();
    renderHeader();
  });
  on('#sup-save', 'onclick', () => saveCfg());
  on('#sup-run', 'onclick', () => runAction('run'));
}

// The mode segments: Off disables the grant; Observe enables without touching send caps; Co-pilot /
// Autopilot enable AND grant the send caps (selecting a sending mode IS the consent). Mutates draft
// first, then saves the FULL draft (enable-toggle pattern), so pending drawer edits are neither lost
// nor able to revert the mode on the next Save settings.
async function setMode(mode) {
  busy = 'save';
  renderHeader();
  try {
    if (mode === 'off') {
      await P.save({ enabled: false, config: configForSave() });
    } else {
      draft.mode = MODES.includes(mode) ? mode : 'copilot';
      const cfg = configForSave();
      const patch = mode === 'observe'
        ? { enabled: true, config: cfg }
        : { enabled: true, caps: autopilotCaps(cfg), config: cfg };
      const r = await P.save(patch);
      draft = cfgOf(r.agent || view());
    }
    saveNotice = '';
  } catch (e) {
    alert('Mode change failed: ' + e.message);
  } finally {
    busy = '';
    renderAll();
  }
}

async function saveCfg() {
  busy = 'save';
  settingsOpen = true;
  renderHeader();
  try {
    const cfg = configForSave();
    // While enabled in a SENDING mode, keep the granted caps aligned with auto-pilot + the GOAL.md
    // toggle. Observe mode never force-adds send caps (the consent tab may have deliberately revoked them).
    const sending = view().grant?.enabled && cfg.mode !== 'observe';
    const patch = sending ? { caps: autopilotCaps(cfg), config: cfg } : { config: cfg };
    const r = await P.save(patch);
    draft = cfgOf(r.agent || view());
    saveNotice = previewSaveNotice(draft);
  } catch (e) {
    saveNotice = '';
    alert('Save failed: ' + e.message);
  } finally {
    busy = '';
    renderAll();
  }
}

// ---- doc --------------------------------------------------------------------
// One-line preview for the collapsed doc: its title + first real sentence, so you know what's being
// supervised without expanding the full multi-section doc.
function docSummaryHtml(doc) {
  const lines = String(doc || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const title = (lines.find((l) => /^#\s/.test(l)) || 'Supervision doc').replace(/^#+\s*/, '');
  const snippet = (lines.find((l) => !/^#/.test(l) && !/^[-*>[]/.test(l)) || '').slice(0, 120);
  // single ellipsis-truncating line (no overflow). Hidden when expanded (doc shows its own title).
  return `<span class="sup-doc-preview-line"><b>${esc(title)}</b>${snippet ? ' — ' + esc(snippet) : ''}</span>`;
}
// ---- Task card (Project Memory phase 3) ------------------------------------
// When the projectMemory flag is on and this session drives a task card, the card IS the contract:
// the doc section renders the card (status, goal, per-criterion state, archive drawer) and the
// operator's EXPLICIT controls (new task / edit / close) are the boundary mechanism. The legacy doc
// UI stays for flag-off sessions. Data via GET api/session/:id/tasks (loadTasks below).
let pmData = null; // {active, open, archived} | null = flag off / no project / not loaded
let pmAt = 0;
let pmForm = false; // "new task" inline form open
let pmEdit = null; // inline editor state: {kind: 'goal'|'crit'|'done'|'abandon'|'satisfy', cid?}
let pmBusy = false;
let pmArchOpen = false;

window.addEventListener('aios:new-task', () => {
  try { document.querySelector('[data-tab=\"supervisor\"]')?.click(); } catch {}
  pmForm = true;
  renderDoc();
  setTimeout(() => host.querySelector('#pm-new-title')?.focus(), 60);
});

async function loadTasks(force = false) {
  if (!force && Date.now() - pmAt < 20000) return;
  pmAt = Date.now();
  try {
    const r = await P.api(`api/session/${P.sessionId}/tasks`);
    pmData = r?.ok ? r : null;
  } catch { pmData = null; }
  renderDoc();
}

function pmStatusChip(st) {
  const cls = st === 'active' ? 'on_track' : st === 'done' ? 'complete' : st === 'verify_pending' ? 'needs_attention' : '';
  return `<span class="sup-badge sm ${cls ? 'sup-' + cls : ''}">${esc(st)}</span>`;
}

function renderTaskCard() {
  const a = pmData.active;
  const openRows = (pmData.open || []).map((t) => `<div class="pm-open-row"><span class="pm-arch-title">${esc(t.title || t.goal?.slice(0, 60) || t.id)}</span> ${pmStatusChip(t.status)} <button class="btn ghost sm" data-pm-activate="${esc(t.id)}">Resume</button></div>`).join('');
  const arch = (pmData.archived || []).map((t) => `
    <div class="pm-arch-row" title="${esc(t.outcome || '')}">
      ${pmStatusChip(t.status)}
      <span class="pm-arch-title">${esc(t.title || t.id)}</span>
      <span class="pm-arch-outcome">${esc(t.outcome || '')}</span>
    </div>`).join('');
  const form = pmForm ? `
    <div class="pm-form">
      <input id="pm-new-title" placeholder="Task title" />
      <textarea id="pm-new-goal" rows="2" placeholder="Goal — what does done look like?"></textarea>
      <textarea id="pm-new-criteria" rows="3" placeholder="Acceptance criteria — one per line"></textarea>
      <div class="sup-actions"><button class="btn sm" id="pm-new-save" ${pmBusy ? 'disabled' : ''}>Create & switch</button><button class="btn ghost sm" id="pm-new-cancel">Cancel</button></div>
    </div>` : '';
  const mig = !pmData?.active ? (pmData?.open || []).find((t) => t.legacy && t.status === 'proposed' && t.mine) : null;
  const migBanner = mig ? `
    <div class="pm-boundary">
      <span>📦 Card drafted from this session's old doc: <b>${esc(mig.title || mig.id)}</b> — activate it, or dismiss if it's stale (the original doc stays archived either way).</span>
      <button class="btn sm" data-pm-activate="${esc(mig.id)}">Activate</button>
      <button class="btn ghost sm" data-pm-decline="${esc(mig.id)}">Dismiss</button>
    </div>` : '';
  const pb = pmData?.pendingBoundary;
  const boundary = pb ? `
    <div class="pm-boundary">
      <span>✨ Looks like a new task: <b>${esc(pb.title || pb.goal || '')}</b>${pb.reason ? ` <span class="count" title="${esc(pb.reason)}">why?</span>` : ''}</span>
      <button class="btn sm" id="pm-b-accept">Start card</button>
      <button class="btn ghost sm" id="pm-b-dismiss">Dismiss</button>
    </div>` : '';
  // In-theme inline editors — native browser dialogs are unreadable and off-theme:
  const critRow = (c) => {
    if (c.status === 'satisfied') return `<div class="pm-crit satisfied" title="evidence recorded">☑ ${esc(c.text)}</div>`;
    if (pmEdit?.kind === 'satisfy' && pmEdit.cid === c.id) return `
      <div class="pm-crit open">☐ ${esc(c.text)}</div>
      <div class="pm-inline">
        <input id="pm-satisfy-note" placeholder="Evidence note (optional) — why is this met?" />
        <button class="btn sm" id="pm-satisfy-go">Mark met</button><button class="btn ghost sm" data-pm-cancel>Cancel</button>
      </div>`;
    return `<div class="pm-crit open" data-pm-satisfy="${esc(c.id)}" title="Click to mark met (records operator evidence)">☐ ${esc(c.text)}</div>`;
  };
  const goalBlock = pmEdit?.kind === 'goal'
    ? `<div class="pm-inline col"><textarea id="pm-goal-edit" rows="3">${esc(a.task.goal || '')}</textarea>
       <div class="sup-actions"><button class="btn sm" id="pm-goal-save">Save goal</button><button class="btn ghost sm" data-pm-cancel>Cancel</button></div></div>`
    : `<div class="pm-goal">${esc(a.task.goal || '')}</div>`;
  const critAdd = pmEdit?.kind === 'crit'
    ? `<div class="pm-inline"><input id="pm-crit-new" placeholder="New acceptance criterion" />
       <button class="btn sm" id="pm-crit-save">Add</button><button class="btn ghost sm" data-pm-cancel>Cancel</button></div>` : '';
  const doneRow = pmEdit?.kind === 'done'
    ? `<div class="pm-inline"><input id="pm-done-outcome" placeholder="Outcome (one line, optional)" />
       <button class="btn sm" id="pm-done-go">Close as done</button><button class="btn ghost sm" data-pm-cancel>Cancel</button></div>` : '';
  const abandonRow = pmEdit?.kind === 'abandon'
    ? `<div class="pm-inline warn"><span>Abandon this card? The archive keeps it.</span>
       <button class="btn sm" id="pm-abandon-go">Yes, abandon</button><button class="btn ghost sm" data-pm-cancel>Cancel</button></div>` : '';
  const between = !a && pmData?.lastClosed ? `
    <div class="pm-boundary" style="border-style:solid;color:var(--muted)">
      <span>Between tasks — last: <b>${esc(pmData.lastClosed.title || pmData.lastClosed.id)}</b> ${pmStatusChip(pmData.lastClosed.status)}${pmData.lastClosed.outcome ? ` <span class="count">${esc(String(pmData.lastClosed.outcome).slice(0, 90))}</span>` : ''}</span>
      <span class="count">start the next card (or accept a suggestion) so the supervisor has a current contract</span>
    </div>` : '';
  const card = a ? `
    <div class="pm-card">
      <div class="pm-card-head">${pmStatusChip(a.task.status)} <b>${esc(a.task.title || 'Current task')}</b> <span class="count">v${a.task.version}</span></div>
      ${goalBlock}
      <div class="pm-criteria">${(a.criteria || []).map(critRow).join('') || '<span class="count">no criteria yet</span>'}</div>
      ${critAdd}${doneRow}${abandonRow}
      <div class="sup-actions">
        <button class="btn ghost sm" data-pm-edit="crit">+ criterion</button>
        <button class="btn ghost sm" data-pm-edit="goal">Edit goal</button>
        <button class="btn ghost sm" data-pm-edit="done">✓ Done</button>
        <button class="btn ghost sm" data-pm-edit="abandon">Abandon</button>
        <span class="count" id="pm-msg"></span>
      </div>
      <div class="sup-hint">Criteria tick themselves when a verify cites evidence; click one to mark it met yourself. The card closes automatically when the gate verifies complete with every criterion met.</div>
    </div>` : '<div class="sup-empty-doc">No active task card — create one to give the supervisor its contract.</div>';
  return `
    <section class="su-card sup-doc-card">
      <h2><span>Task card</span><span class="count" title="Project Memory: the supervisor judges against this card, not a prose doc">the contract</span></h2>
      <div class="sup-doc-tools"><button class="btn sm" id="pm-new">${pmForm ? 'New task ▾' : '+ New task'}</button></div>
      ${form}
      ${migBanner}
      ${boundary}
      ${between}
      ${card}
      ${openRows ? `<details class="sup-learn-group"><summary>Open / paused (${pmData.open.length})</summary>${openRows}</details>` : ''}
      ${arch ? `<details class="sup-learn-group" ${pmArchOpen ? 'open' : ''}><summary>Archive (${pmData.archived.length})</summary><div class="pm-arch">${arch}</div></details>` : ''}
    </section>`;
}

function wireTaskCard() {
  const on = (sel, ev, fn) => { const el = host.querySelector(sel); if (el) el[ev] = fn; };
  const msg = (t) => { const el = host.querySelector('#pm-msg'); if (el) el.textContent = t || ''; };
  const post = async (path, body) => {
    pmBusy = true;
    try { await P.api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); pmEdit = null; pmForm = false; }
    catch (e) { msg('⚠ ' + (e.message || e)); pmBusy = false; return; }
    pmBusy = false;
    await loadTasks(true);
  };
  on('#pm-new', 'onclick', () => { pmForm = !pmForm; pmEdit = null; renderDoc(); });
  on('#pm-new-cancel', 'onclick', () => { pmForm = false; renderDoc(); });
  on('#pm-new-save', 'onclick', () => {
    const v = (id) => host.querySelector(id)?.value || '';
    const criteria = v('#pm-new-criteria').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!v('#pm-new-title').trim() && !v('#pm-new-goal').trim()) return;
    post(`api/session/${P.sessionId}/tasks`, { title: v('#pm-new-title'), goal: v('#pm-new-goal'), criteria });
  });
  on('#pm-b-accept', 'onclick', () => post(`api/session/${P.sessionId}/tasks/boundary`, { action: 'accept' }));
  on('#pm-b-dismiss', 'onclick', () => post(`api/session/${P.sessionId}/tasks/boundary`, { action: 'dismiss' }));
  // inline editors
  for (const btn of host.querySelectorAll('[data-pm-edit]')) {
    btn.onclick = () => { pmEdit = { kind: btn.dataset.pmEdit }; renderDoc(); };
  }
  for (const el of host.querySelectorAll('[data-pm-cancel]')) el.onclick = () => { pmEdit = null; renderDoc(); };
  for (const el of host.querySelectorAll('[data-pm-satisfy]')) {
    el.onclick = () => { pmEdit = { kind: 'satisfy', cid: el.dataset.pmSatisfy }; renderDoc(); setTimeout(() => host.querySelector('#pm-satisfy-note')?.focus(), 40); };
  }
  on('#pm-satisfy-go', 'onclick', () => post(`api/pm/task/${pmData.active.task.id}/criteria/${pmEdit.cid}/satisfy`, { note: host.querySelector('#pm-satisfy-note')?.value || '' }));
  on('#pm-goal-save', 'onclick', () => post(`api/pm/task/${pmData.active.task.id}`, { goal: host.querySelector('#pm-goal-edit')?.value || '' }));
  on('#pm-crit-save', 'onclick', () => {
    const t = host.querySelector('#pm-crit-new')?.value?.trim();
    if (t) post(`api/pm/task/${pmData.active.task.id}`, { addCriteria: [t] });
  });
  on('#pm-done-go', 'onclick', () => post(`api/pm/task/${pmData.active.task.id}`, { status: 'done', outcome: host.querySelector('#pm-done-outcome')?.value || '' }));
  on('#pm-abandon-go', 'onclick', () => post(`api/pm/task/${pmData.active.task.id}`, { status: 'abandoned' }));
  for (const btn of host.querySelectorAll('[data-pm-activate]')) {
    btn.onclick = () => post(`api/session/${P.sessionId}/tasks/activate`, { taskId: btn.dataset.pmActivate });
  }
  for (const btn of host.querySelectorAll('[data-pm-decline]')) {
    btn.onclick = () => post(`api/pm/task/${btn.dataset.pmDecline}`, { status: 'abandoned', outcome: 'migration proposal dismissed by operator' });
  }
  const arch = host.querySelector('.sup-doc-card details:last-of-type');
  if (arch) arch.ontoggle = (e) => { pmArchOpen = e.target.open; };
}

function renderDoc() {
  const hostEl = host.querySelector('#sup-doc');
  if (!hostEl) return;
  if (pmData) { // Project Memory is live: the card shell IS the primary surface (active card,
    // between-tasks strip, suggestions, open/paused, archive). The legacy doc — when one still
    // exists — collapses behind it as a relic: an LLM tick already treats the card as the
    // contract, so the panel must stop presenting the retired doc as current.
    const legacyDoc = String(draft?.doc || '').trim();
    hostEl.innerHTML = renderTaskCard() + (legacyDoc ? `
      <details class="sup-learn-group" style="margin-top:8px"><summary>Legacy doc (retired — cards are the contract now)</summary>
        <div class="sup-md" style="opacity:.75">${renderMarkdown(legacyDoc.slice(0, 4000))}${legacyDoc.length > 4000 ? '<p class="count">… truncated — the full doc is archived</p>' : ''}</div>
      </details>` : '');
    wireTaskCard();
    return;
  }
  const d = draft;
  const body = editMode
    ? `<textarea id="sup-doc-edit" class="sup-doc-edit" rows="16">${esc(d.doc)}</textarea>
       <div class="sup-actions"><button class="btn" id="sup-doc-save" ${busy ? 'disabled' : ''}>Save doc</button><button class="btn ghost" id="sup-doc-cancel" ${busy ? 'disabled' : ''}>Cancel</button></div>`
    : d.doc
      ? `<details class="sup-doc-collapse" ${docExpanded ? 'open' : ''}><summary class="sup-doc-summary">${docSummaryHtml(d.doc)}</summary><div class="sup-md">${renderMarkdown(d.doc)}</div></details>`
      : '<div class="sup-empty-doc">No supervision doc yet.</div>';
  hostEl.innerHTML = `
    <section class="su-card sup-doc-card">
      <h2><span>Supervision Doc</span><button class="btn ghost sm" id="sup-doc-mode">${editMode ? 'View' : 'Edit'}</button></h2>
      <div class="sup-doc-tools">
        <button class="btn sm" id="sup-generate" ${busy ? 'disabled' : ''}>${busy === 'generate' ? 'Generating…' : 'Generate from session'}</button>
      </div>
      ${body}
      <div class="sup-revise">
        <input id="sup-revise-input" placeholder="Ask the supervisor to revise the doc" value="${esc(reviseText)}" />
        <button class="btn ghost sm" id="sup-revise-send" ${busy || !d.doc.trim() ? 'disabled' : ''}>${busy === 'revise' ? 'Revising…' : 'Send'}</button>
      </div>
    </section>`;
  wireDoc();
}
function wireDoc() {
  const on = (sel, ev, fn) => {
    const el = host.querySelector(sel);
    if (el) el[ev] = fn;
  };
  on('#sup-doc-mode', 'onclick', () => {
    editMode = !editMode;
    if (editMode) P.markDirty();
    renderDoc();
  });
  on('.sup-doc-collapse', 'ontoggle', (e) => {
    docExpanded = e.target.open; // persist across SSE re-renders
  });
  on('#sup-doc-edit', 'oninput', (e) => {
    draft.doc = e.target.value;
    P.markDirty();
  });
  on('#sup-doc-save', 'onclick', async () => {
    await saveCfg();
    editMode = false;
    P.clearDirty();
    renderDoc();
  });
  on('#sup-doc-cancel', 'onclick', () => {
    draft = cfgOf(view());
    editMode = false;
    P.clearDirty();
    renderAll();
  });
  on('#sup-generate', 'onclick', () => runAction('generate'));
  on('#sup-revise-input', 'oninput', (e) => {
    reviseText = e.target.value;
  });
  on('#sup-revise-send', 'onclick', revise);
}

// ---- actions ----------------------------------------------------------------
function configForSave() {
  // Drop the derived display-only `_set` flag, and drop an EMPTY passcode so the stored secret survives
  // (config merges server-side) — only a freshly-typed passcode overwrites it.
  const cfg = { ...draft };
  cfg.self_maintaining_doc = true;
  // Mode is the single source of truth; observe_only is only ever DERIVED here (legacy mirror for the
  // server-side modeOf fallback + old readers). Clamp the co-pilot threshold to a sane range.
  cfg.mode = MODES.includes(cfg.mode) ? cfg.mode : 'copilot';
  cfg.observe_only = cfg.mode === 'observe';
  cfg.copilot_confidence = Math.min(1, Math.max(0, Number(cfg.copilot_confidence) || 0.8));
  // A custom chain's first entry IS the primary model (keeps modelChain() and the compact display in agreement).
  if (Array.isArray(cfg.fallback_models) && cfg.fallback_models.length) cfg.model = cfg.fallback_models[0];
  const profiles = normalizePreviewProfiles(cfg).map((p) => {
    const out = { ...p };
    delete out.passcode_set;
    if (!out.passcode) delete out.passcode;
    return out;
  });
  cfg.preview_profiles = profiles;
  const primary = profiles.find((p) => p.enabled !== false && p.url) || null;
  cfg.preview_url = primary?.url || '';
  cfg.preview_passcode_gated = !!primary?.passcode_gated;
  cfg.preview_username = primary?.username || '';
  delete cfg.preview_passcode_set;
  delete cfg.preview_passcode;
  if (primary?.passcode) cfg.preview_passcode = primary.passcode;
  return cfg;
}

function previewSaveNotice(d) {
  const profiles = normalizePreviewProfiles(d);
  const enabled = profiles.filter((p) => p.enabled && p.url).length;
  const secrets = profiles.filter((p) => p.passcode_gated && p.passcode_set).length;
  return `Saved${enabled ? ` · ${enabled} active preview${enabled === 1 ? '' : 's'}` : ''}${secrets ? ` · ${secrets} passcode${secrets === 1 ? '' : 's'} recorded` : ''}`;
}

async function runAction(action) {
  busy = action;
  renderAll();
  try {
    const cfg = configForSave();
    await P.save({ config: cfg }); // persist current settings first
    const r = await P.call(action, { config: cfg });
    if (r.result?.doc != null) draft.doc = r.result.doc;
    P.clearDirty();
    editMode = false;
  } catch (e) {
    alert((action === 'run' ? 'Review' : 'Generate') + ' failed: ' + (e.message || e));
  } finally {
    busy = '';
    renderAll();
  }
}
async function revise() {
  const instruction = reviseText.trim();
  if (!instruction) return;
  busy = 'revise';
  renderDoc();
  try {
    const cfg = configForSave();
    await P.save({ config: cfg });
    const r = await P.call('revise', { config: cfg, instruction });
    if (r.result?.doc != null) draft.doc = r.result.doc;
    reviseText = '';
    editMode = false;
    P.clearDirty();
  } catch (e) {
    alert('Revise failed: ' + (e.message || e));
  } finally {
    busy = '';
    renderAll();
  }
}
let tmplNaming = false; // inline name row open (in-theme — no native prompt)
async function saveTemplate(name) {
  name = String(name || '').trim();
  if (!name) return;
  tmplNaming = false;
  busy = 'template';
  renderHeader();
  try {
    const r = await P.call('template-save', { name, body: draft.review_template || '' });
    templates = r.result?.templates || templates;
  } catch (e) {
    alert('Template save failed: ' + e.message);
  } finally {
    busy = '';
    renderHeader();
  }
}
async function loadTemplate(id) {
  if (!id) return;
  const t = templates.find((x) => String(x.id) === String(id));
  if (!t) return;
  draft.review_template = t.body || t.doc || '';
  settingsOpen = true;
  await saveCfg();
  P.clearDirty();
  renderAll();
}

// ---- activity feed ----------------------------------------------------------
function renderResult() {
  const hostEl = host.querySelector('#sup-result');
  if (!hostEl) return;
  const hist = data().history || [];
  const latest = data().latest || hist[0] || null;
  const heldHtml = heldCard();
  const policyHtml = policyCard();
  const stateHtml = supervisorStateCard();
  const decisionsHtml = policyHistory();
  if (!latest) {
    hostEl.innerHTML = heldHtml + policyHtml + stateHtml + decisionsHtml || '<section class="su-card"><span class="muted">No activity yet. Turn the supervisor on — it will generate a doc if needed — or press “Run check now”.</span></section>';
    wireResult();
    return;
  }
  hostEl.innerHTML = heldHtml + policyHtml + stateHtml + latestCard(latest) + decisionsHtml + history(hist.slice(1));
  wireResult();
}
const MSG_LABEL = { answer: 'Answer to agent', unstick: 'Nudge to agent', gate: 'Completion challenge', verify: 'Message to agent', checkpoint: 'Message to agent', recover: 'Retry sent to agent' };
const HELD_REASON = { goal_conflict: 'goal conflict with the spec', integrity: 'integrity — won’t fabricate', human_gate: 'needs your decision' };
const POLICY_ACTION_LABEL = { none: 'No send', wait: 'Wait', answer: 'Answer', gate: 'Challenge', challenge: 'Challenge', nudge: 'Nudge', unstick: 'Unstick', recover: 'Recover', resolve: 'Resolve' };
// The needs-operator HOLD: the supervisor escalated a goal-conflict / integrity refusal and stopped pushing
// the agent. A Resolve box (not a bare button) so the operator's decision is RECORDED as context, not lost.
function heldCard() {
  const h = data().held;
  if (!h) return '';
  return `
    <section class="su-card sup-held-card">
      <div class="sup-verdict-head">
        <span class="sup-badge sup-escalated">⏸ Held for you</span>
        <span class="sup-trig">${esc(HELD_REASON[h.reason] || h.reason || 'needs you')}</span>
      </div>
      <p class="sup-assess">Paused so it doesn’t push the agent the wrong way. Tell it your decision to resume — it’s recorded under the doc’s Decisions so the supervisor steers by it. Leave empty to just resume.</p>
      <div class="sup-suggest">
        <textarea id="sup-resolve-text" rows="2" placeholder="Your decision — e.g. “switch to DESIGN_v1.md, drop the 0.8.0 release work”"></textarea>
        <div class="sup-resolve-row">
          <label class="sup-check"><input type="checkbox" id="sup-resolve-send"/> also send to the agent</label>
          <button class="btn sm" id="sup-resolve-btn">Resolve &amp; resume</button>
        </div>
      </div>
    </section>`;
}
function policyStatus(d) {
  if (!d) return { cls: 'idle', label: 'No record' };
  if (d.sent) return { cls: 'sent', label: 'Sent' };
  if (d.allowedSend) return { cls: 'allowed', label: 'Allowed' };
  return { cls: 'quiet', label: 'Quiet' };
}
function policyLine(label, value) {
  const v = value == null || value === '' ? '—' : String(value);
  return `<div class="sup-policy-row"><span>${esc(label)}</span><b title="${esc(v)}">${esc(v)}</b></div>`;
}
function currentTaskHtml(task) {
  if (!task) return '';
  const intent = task.directOperatorIntent || {};
  const forwarded = Array.isArray(task.forwardedReports) ? task.forwardedReports : [];
  const stale = task.staleDocOverride || null;
  return `
    <div class="sup-policy-grid">
      ${policyLine('Current task', task.currentWork || task.nextRequiredAction || '')}
      ${policyLine('Next action', task.nextRequiredAction || '')}
      ${policyLine('Intent source', task.source || '')}
      ${policyLine('Confidence', task.confidence == null ? '' : Number(task.confidence).toFixed(2))}
    </div>
    ${task.latestOperatorWordsConsidered ? `<div class="sup-policy-quote"><b>Latest words considered:</b> ${esc(task.latestOperatorWordsConsidered)}</div>` : ''}
    ${intent.text ? `<div class="sup-policy-quote"><b>Direct operator span:</b> ${esc(intent.text)}</div>` : ''}
    ${stale ? `<div class="sup-policy-quote"><b>Doc override:</b> ${esc(stale.reason || 'latest operator words override stale doc')} ${stale.docCurrentWork ? `<span class="muted">(${esc(stale.docCurrentWork)})</span>` : ''}</div>` : ''}
    ${forwarded.length ? `<div class="sup-policy-reasons">${forwarded.slice(0, 3).map((r) => `<span>Forwarded: ${esc(r.text)}</span>`).join('')}</div>` : ''}`;
}
function policyCard() {
  const p = data().policy || null;
  const d = data().latestDecision || null;
  const row = d || p;
  if (!row) return '';
  const st = policyStatus(row);
  const action = POLICY_ACTION_LABEL[row.actionType] || row.actionType || 'Decision';
  const intent = row.latestOperatorIntent || {};
  const signal = row.triggeringSignal || {};
  const task = row.currentTask || row.decision?.currentTask || p?.currentTask || null;
  const reasons = Array.isArray(row.reasons) ? row.reasons : [];
  const sentText = row.sentText ? `<div class="sup-policy-sent">${esc(row.sentText)}</div>` : '';
  const reasonHtml = reasons.length ? `<div class="sup-policy-reasons">${reasons.slice(0, 4).map((r) => `<span>${esc(r)}</span>`).join('')}</div>` : '';
  return `
    <section class="su-card sup-policy-card">
      <div class="sup-verdict-head">
        <span class="sup-badge sup-policy-badge">Policy Decision</span>
        <span class="sup-policy-state ${st.cls}">${esc(st.label)}</span>
        <span class="sup-trig">${esc(action)}</span>
        ${row.ts ? `<span class="sup-ts">${fmtAgo(row.ts)} ago</span>` : ''}
      </div>
      <div class="sup-policy-grid">
        ${policyLine('Rule', row.ruleId)}
        ${policyLine('Operator intent', intent.type || 'none')}
        ${policyLine('Signal', signal.type || 'none')}
        ${policyLine('Suppression', row.suppressionReason || '')}
      </div>
      ${intent.text ? `<div class="sup-policy-quote"><b>Operator:</b> ${esc(intent.text)}</div>` : ''}
      ${signal.summary ? `<div class="sup-policy-quote"><b>Signal:</b> ${esc(signal.summary)}</div>` : ''}
      ${currentTaskHtml(task)}
      ${reasonHtml}
      ${sentText}
    </section>`;
}
function policyHistory() {
  const rows = data().decisionHistory || [];
  if (!rows.length) return '';
  return `<details class="su-card sup-policy-history"><summary>Decision records (${rows.length})</summary>${rows.slice(0, 12).map(policyHistItem).join('')}</details>`;
}
function policyHistItem(r) {
  const st = policyStatus(r);
  const intent = r.latestOperatorIntent || {};
  const signal = r.triggeringSignal || {};
  const action = POLICY_ACTION_LABEL[r.actionType] || r.actionType || 'Decision';
  const preview = esc(r.suppressionReason || signal.summary || intent.text || r.ruleId || '');
  return `<details class="sup-policy-item"><summary class="sup-hist-row"><span class="sup-policy-state ${st.cls}">${esc(st.label)}</span><span class="sup-trig">${esc(action)}</span><span class="sup-hist-preview">${preview}</span><span class="sup-ts">${fmtAgo(r.ts)} ago</span></summary><div class="sup-policy-detail">${policyLine('Rule', r.ruleId)}${policyLine('Intent', intent.type || 'none')}${policyLine('Signal', signal.type || 'none')}${policyLine('Suppression', r.suppressionReason || '')}${r.sentText ? `<div class="sup-policy-sent">${esc(r.sentText)}</div>` : ''}</div></details>`;
}
function supervisorStateCard() {
  const st = data().supervisorState || null;
  if (!st) return '';
  const hold = st.activeHold || null;
  const rec = st.recoveryState || {};
  const lastGate = st.lastGate || {};
  const holdText = hold ? `${hold.reason || 'held'}${hold.scope ? ' · ' + hold.scope : ''}` : 'none';
  const recovery = [rec.errSig ? `error: ${rec.errSig}` : '', rec.ctxWedgeAt ? `context wedge ${fmtAgo(rec.ctxWedgeAt)} ago` : ''].filter(Boolean).join(' · ') || 'clear';
  return `
    <section class="su-card sup-state-card">
      <div class="sup-verdict-head">
        <span class="sup-badge sup-state-badge">Supervisor State</span>
        <span class="sup-policy-state ${hold ? 'allowed' : 'quiet'}">${hold ? 'Held' : 'Ready'}</span>
      </div>
      <div class="sup-policy-grid">
        ${policyLine('Signed off', st.signedOff ? 'yes' : 'no')}
        ${policyLine('Active hold', holdText)}
        ${policyLine('Last gate', lastGate.key || 'none')}
        ${policyLine('Recovery', recovery)}
      </div>
    </section>`;
}
function latestCard(rv) {
  const { cls, label } = badgeFor(rv);
  const shot = rv.screenshot ? `<img class="sup-shot" src="api/session/${P.sessionId}/shot/${encodeURIComponent(String(rv.screenshot).split('/').pop())}" alt="preview screenshot" loading="lazy"/>` : '';
  const note = rv.kind === 'escalate' ? '<div class="sup-hint">Left for you — this is in your needs-you queue.</div>' : '';
  const msgBlock = rv.message
    ? `<div class="sup-section-h">${MSG_LABEL[rv.kind] || 'Message to agent'} ${rv.sent ? '<span class="sup-sent">sent</span>' : '<span class="sup-draft">draft</span>'}</div>
       <div class="sup-suggest"><textarea id="sup-suggest-text" rows="3">${esc(rv.message)}</textarea><button class="btn sm" id="sup-send">${rv.sent ? 'Send again' : 'Send to agent'}</button></div>`
    : '';
  return `
    <section class="su-card sup-verdict-card">
      <div class="sup-verdict-head">
        <span class="sup-badge ${cls}">${esc(label)}</span>
        ${rv.repeat > 1 ? `<span class="sup-rep" title="${rv.repeat} consecutive identical re-checks">×${rv.repeat}</span>` : ''}
        ${scorePill(rv)}
        <span class="sup-trig">${esc(triggerLabel(rv.trigger))}</span>
        <span class="sup-ts">${fmtAgo(rv.ts)} ago</span>
      </div>
      ${rv.error ? `<div class="sup-err">${esc(rv.error)}</div>` : ''}
      ${rv.assessment ? `<p class="sup-assess">${esc(rv.assessment)}</p>` : ''}
      ${note}
      ${shot}
      ${msgBlock}
    </section>`;
}
// Audit log: each row expands to show exactly what the supervisor sent and WHY — so you can catch up
// on what happened while it supervised, without opening anything else.
function history(rows) {
  if (!rows.length) return '';
  return `<details class="su-card sup-history" open><summary>History (${rows.length}) — what it did &amp; why</summary>${rows.map(histItem).join('')}</details>`;
}
// Lead the row preview with the DISTINCTIVE content, not the shared boilerplate opener many supervisor
// messages use (e.g. the gate's "I don't accept 'done' on your word…"). Otherwise two different sessions'
// gate/answer rows preview identically and look cross-wired. If the message has an enumerated list
// "(1) …" (the per-task acceptance criteria), start there; else use the message/assessment head.
function previewText(r) {
  let s = (r.message || r.assessment || '').replace(/\s+/g, ' ').trim();
  const at = s.search(/\(\s*1\s*\)/);
  if (at > 40) s = '… ' + s.slice(at);
  return s.slice(0, 120);
}
function histItem(r) {
  const { cls, label } = badgeFor(r);
  const sentTag = r.sent ? '<span class="sup-sent">sent</span>' : r.message ? '<span class="sup-draft">draft</span>' : '';
  const preview = esc(previewText(r));
  const shot = r.screenshot ? `<img class="sup-shot" src="api/session/${P.sessionId}/shot/${encodeURIComponent(String(r.screenshot).split('/').pop())}" loading="lazy"/>` : '';
  const body =
    (r.assessment ? `<div class="sup-hist-why"><b>Why:</b> ${esc(r.assessment)}</div>` : '') +
    (r.message ? `<div class="sup-section-h">${MSG_LABEL[r.kind] || 'Message to agent'} ${r.sent ? '<span class="sup-sent">sent</span>' : '<span class="sup-draft">draft</span>'}</div><div class="sup-hist-msg">${esc(r.message)}</div>` : '') +
    (r.error ? `<div class="sup-err">${esc(r.error)}</div>` : '') +
    shot;
  const rep = r.repeat > 1 ? `<span class="sup-rep" title="${r.repeat} consecutive identical re-checks">×${r.repeat}</span>` : '';
  return `<details class="sup-hist-item"><summary class="sup-hist-row"><span class="sup-badge sm ${cls}">${esc(label)}</span>${rep}${scorePill(r, true)}<span class="sup-trig">${esc(triggerLabel(r.trigger))}</span><span class="sup-hist-preview">${preview}</span>${sentTag}<span class="sup-ts">${fmtAgo(r.ts)} ago</span></summary>${body || '<div class="sup-hint">(no message)</div>'}</details>`;
}
function wireResult() {
  // Resolve box (needs-operator HOLD): clear the hold + record the decision; optionally relay to the agent.
  const rta = host.querySelector('#sup-resolve-text');
  if (rta) rta.oninput = () => P.markDirty(); // protect the typed decision from refresh clobber
  const rbtn = host.querySelector('#sup-resolve-btn');
  if (rbtn) rbtn.onclick = async () => {
    const note = (host.querySelector('#sup-resolve-text')?.value || '').trim();
    const send = !!host.querySelector('#sup-resolve-send')?.checked;
    rbtn.disabled = true;
    try {
      await P.call('resolve', { note, send });
      P.clearDirty(); // let the next refresh re-render without the held card
    } catch (e) {
      alert('Resolve failed: ' + (e.message || e));
      rbtn.disabled = false;
    }
  };
  const ta = host.querySelector('#sup-suggest-text');
  if (ta) ta.oninput = () => P.markDirty(); // protect the message edit from refresh clobber
  const btn = host.querySelector('#sup-send');
  if (!btn) return;
  btn.onclick = async () => {
    const text = (host.querySelector('#sup-suggest-text')?.value || '').trim();
    if (!text) return;
    btn.disabled = true;
    try {
      const r = await fetch(`api/session/${P.sessionId}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source: 'supervisor' }) });
      if (r.status === 409) {
        if (confirm('This session has stopped. Resume it now?')) {
          await P.api(`api/session/${P.sessionId}/resume`, { method: 'POST' });
          setTimeout(() => location.reload(), 900);
        }
      } else if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('Send failed: ' + (j.error || r.status));
      } else {
        btn.textContent = 'Sent';
        P.clearDirty();
      }
    } catch (e) {
      alert('Send failed: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  };
}

// ---- minimal markdown (headings, bullets, checkboxes, code) ------------------
function inlineMd(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = '';
  let listCls = '';
  let inFence = false;
  let fence = [];
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = '';
      listCls = '';
    }
  };
  const openList = (cls) => {
    if (list !== 'ul' || listCls !== cls) {
      closeList();
      out.push(`<ul class="${cls}">`);
      list = 'ul';
      listCls = cls;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    if (/^```/.test(line)) {
      if (inFence) {
        closeList();
        out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
        fence = [];
        inFence = false;
      } else {
        closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fence.push(raw);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      closeList();
      const tag = h[1].length === 1 ? 'h3' : h[1].length === 2 ? 'h4' : 'h5';
      out.push(`<${tag}>${inlineMd(h[2])}</${tag}>`);
      continue;
    }
    const cb = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (cb) {
      openList('sup-md-checks');
      out.push(`<li><input type="checkbox" disabled ${cb[1].toLowerCase() === 'x' ? 'checked' : ''}/> <span>${inlineMd(cb[2])}</span></li>`);
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.+)$/);
    if (bullet) {
      openList('sup-md-list');
      out.push(`<li>${inlineMd(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  if (inFence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  return out.join('');
}
