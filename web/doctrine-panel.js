// Supervisor doctrine — the approval gate for what the supervisor actively learned from the operator's
// real replies (src/agents/doctrine.js). Approving a candidate IS the production deployment: active rules
// inject into the supervisor's answer prompt on its next tick. Self-contained; renders into #doctrine.

const box = document.getElementById('doctrine');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (ts) => {
  const m = Math.round((Date.now() - Number(ts || 0)) / 60000);
  if (m < 60) return m + 'm ago';
  if (m < 60 * 48) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
};

let rules = [];
let triaging = false;

async function load() {
  try {
    const r = await fetch('api/doctrine');
    const j = await r.json();
    rules = j.rules || [];
    render();
  } catch {
    box.innerHTML = '<p class="count">doctrine unavailable</p>';
  }
}

function evidenceHtml(r) {
  if (!r.ask && !r.response) return '';
  return `<details class="doct-ev"><summary>evidence · learned ${esc(ago(r.created_at))}${r.session_id ? ` · <a class="rlink" href="session?id=${esc(r.session_id)}">${esc(r.session_id)}</a>` : ''}</summary>
    <div class="doct-ask">ask ▸ ${esc(r.ask || '')}</div>
    <div class="doct-resp">you ▸ ${esc(r.response || '')}</div>
    ${r.divergence ? `<div class="doct-div">divergence ▸ ${esc(r.divergence)}</div>` : ''}
  </details>`;
}

function triageChip(r) {
  if (r.status !== 'candidate' || !r.triage_verdict) return '';
  if (r.triage_verdict === 'approve') return `<span class="doct-chip rec-ok" title="${esc(r.triage_reason || '')}">#${r.triage_rank || '?'} ✓ suggested</span>`;
  if (r.triage_verdict === 'duplicate') return `<span class="doct-chip rec-no" title="${esc(r.triage_reason || '')}">⇄ dup of ${esc((r.triage_dup_of || '').slice(0, 12))}</span>`;
  return `<span class="doct-chip rec-no" title="${esc(r.triage_reason || '')}">✕ suggested reject</span>`;
}

function card(r) {
  const enfChip = `<span class="doct-chip ${r.enforcement === 'audit' ? 'audit' : ''}" title="${r.enforcement === 'audit' ? 'Checked against work evidence on every completion review' : 'Shapes the supervisor\u2019s judgment (prompt-injected)'}">${esc(r.enforcement || 'advisory')}</span>`;
  const scopeChip = `<span class="doct-chip">${esc(r.scope || 'project')}</span>`;
  const viol = Number(r.violation_count) ? `<span class="doct-chip viol" title="times the audit caught this rule violated">⚠ ${r.violation_count}×</span>` : '';
  const stale = r.source === 'stale-recheck' ? '<span class="doct-chip viol">stale — re-approve?</span>' : '';
  const counts = `${triageChip(r)}${enfChip}${scopeChip}${viol}${stale}<span class="count">×${r.evidence_count} seen${r.reuse_count ? ` · used ${r.reuse_count}×` : ''}</span>`;
  const body = `
    <div class="doct-when">WHEN ${esc(String(r.situation || 'applicable').replace(/^\s*when(ever)?[\s,:]+/i, ''))}</div>
    <div class="doct-rule" data-view>${esc(r.rule)}</div>
    ${r.apply_how ? `<div class="doct-apply" data-view>apply ▸ ${esc(r.apply_how)}</div>` : ''}
    <div class="doct-edit" hidden>
      <label>When (situation)<input data-f="situation" value="${esc(r.situation || '')}" /></label>
      <label>Rule<textarea data-f="rule" rows="3">${esc(r.rule)}</textarea></label>
      <label>How to apply<input data-f="apply_how" value="${esc(r.apply_how || '')}" /></label>
      <label>Enforcement<select data-f="enforcement"><option value="advisory" ${r.enforcement !== 'audit' ? 'selected' : ''}>advisory — shapes judgment</option><option value="audit" ${r.enforcement === 'audit' ? 'selected' : ''}>audit — checked against evidence</option></select></label>
      <label>Scope<select data-f="scope"><option value="project" ${r.scope !== 'global' ? 'selected' : ''}>this project</option><option value="global" ${r.scope === 'global' ? 'selected' : ''}>everywhere</option></select></label>
    </div>
    ${evidenceHtml(r)}`;
  const actions = r.status === 'candidate'
    ? `<button class="btn sm" data-act="approve">✓ Approve</button>
       <button class="btn ghost sm" data-act="edit">✎ Edit</button>
       <button class="btn ghost sm" data-act="save" hidden>Save &amp; approve</button>
       <button class="btn ghost sm" data-act="reject">✕ Reject</button>`
    : r.status === 'active'
      ? `<button class="btn ghost sm" data-act="edit">✎ Edit</button>
         <button class="btn ghost sm" data-act="save" hidden>Save</button>
         <button class="btn ghost sm" data-act="demote">Demote</button>
         <button class="btn ghost sm" data-act="delete">Delete</button>`
      : `<button class="btn ghost sm" data-act="restore">Restore</button>
         <button class="btn ghost sm" data-act="delete">Delete</button>`;
  return `<div class="doct st-${esc(r.status)}" data-id="${esc(r.id)}">${body}<div class="doct-actions">${actions} ${counts}</div></div>`;
}

function render() {
  const cand = rules.filter((r) => r.status === 'candidate').sort((a, b) => {
    // triaged first, by verdict (approve>dup>reject) then rank; untriaged keep recency order
    const w = (r) => (r.triage_verdict === 'approve' ? (r.triage_rank || 99) : r.triage_verdict === 'duplicate' ? 200 : r.triage_verdict === 'reject' ? 300 : 150);
    return w(a) - w(b);
  });
  const act = rules.filter((r) => r.status === 'active');
  const rej = rules.filter((r) => r.status === 'rejected');
  box.innerHTML = `
    <h2 class="doct-h">Supervisor doctrine ${cand.length ? `<span class="doct-badge">${cand.length} to review</span>` : ''}</h2>
    <p class="count" style="margin:2px 0 8px">What the supervisor learned from your replies to builders. <b>Approve</b> puts a rule into its live answer prompt; reject teaches it not to propose that again.</p>
    ${cand.length >= 2 ? `<div class="doct-triage-bar">
      <button class="btn ghost sm" id="doct-triage" ${triaging ? 'disabled' : ''}>${triaging ? 'Reviewing…' : '✨ Have the supervisor review these'}</button>
      ${cand.some((r) => r.triage_verdict) ? `<button class="btn sm" id="doct-triage-apply" title="approve the ✓-suggested, reject the ✕/dup-suggested — per-card buttons still work">Apply ${cand.filter((r) => r.triage_verdict).length} suggestions</button>` : ''}
      <span class="count" id="doct-triage-msg"></span>
    </div>` : ''}
    ${cand.length ? cand.map(card).join('') : '<p class="count">No new learnings to review — candidates appear when you reply to builders in supervised sessions.</p>'}
    ${act.length ? `<details class="doct-group" open><summary>Active doctrine (${act.length}) — live in the supervisor's prompt</summary>${act.map(card).join('')}</details>` : ''}
    ${rej.length ? `<details class="doct-group"><summary>Rejected (${rej.length})</summary>${rej.map(card).join('')}</details>` : ''}`;
}

// A silently-failed approve leaves the UI lying (the operator believes the rule is live). Surface every
// failure on the card, and only trust the server's returned state.
function flashError(id, msg) {
  const el = box.querySelector(`.doct[data-id="${CSS.escape(id)}"] .doct-actions`);
  if (el) {
    let e = el.querySelector('.doct-err');
    if (!e) { e = document.createElement('span'); e.className = 'doct-err'; el.appendChild(e); }
    e.textContent = msg;
  } else {
    alert(msg);
  }
}
async function post(id, body) {
  try {
    const r = await fetch('api/doctrine/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
    if (body.status && j.rule?.status !== body.status) throw new Error('server did not apply the change');
    load();
  } catch (e) {
    flashError(id, '⚠ failed: ' + (e.message || e) + ' — retry');
  }
}

box.addEventListener('click', async (e) => {
  if (e.target?.id === 'doct-triage') {
    triaging = true; render();
    try {
      const r = await fetch('api/doctrine/triage', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      rules = j.rules || rules;
    } catch (err) {
      triaging = false; render();
      const m = document.getElementById('doct-triage-msg'); if (m) m.textContent = '⚠ ' + (err.message || err);
      return;
    }
    triaging = false; render();
    return;
  }
  if (e.target?.id === 'doct-triage-apply') {
    const r = await fetch('api/doctrine/triage/apply', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    rules = j.rules || rules; render();
    const m = document.getElementById('doct-triage-msg');
    if (m) m.textContent = `applied: ${j.approved || 0} approved · ${(j.rejected || 0) + (j.duplicates || 0)} removed`;
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const cardEl = btn.closest('.doct');
  const id = cardEl?.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  if (act === 'edit') {
    cardEl.querySelector('.doct-edit').hidden = false;
    for (const el of cardEl.querySelectorAll('[data-view]')) el.hidden = true;
    btn.hidden = true;
    cardEl.querySelector('[data-act="save"]').hidden = false;
    return;
  }
  if (act === 'save') {
    const f = (k) => cardEl.querySelector(`[data-f="${k}"]`)?.value || '';
    const isCandidate = rules.find((r) => r.id === id)?.status === 'candidate';
    return post(id, { situation: f('situation'), rule: f('rule'), apply_how: f('apply_how'), enforcement: f('enforcement'), scope: f('scope'), ...(isCandidate ? { status: 'active' } : {}) });
  }
  if (act === 'approve') return post(id, { status: 'active' });
  if (act === 'reject') return post(id, { status: 'rejected' });
  if (act === 'demote' || act === 'restore') return post(id, { status: 'candidate' });
  if (act === 'delete') {
    await fetch('api/doctrine/' + id, { method: 'DELETE' });
    load();
  }
});

load();
// Keep the queue fresh while the page sits open — but NEVER re-render over an interaction in progress
// (an open edit form, or a click that hasn't resolved). An innerHTML refresh mid-tap replaces the very
// button being pressed and the action silently vanishes (the classic settings-reset clobber bug).
let interactingUntil = 0;
box.addEventListener('pointerdown', () => { interactingUntil = Date.now() + 15000; });
setInterval(() => {
  if (Date.now() < interactingUntil) return;
  if (box.querySelector('.doct-edit:not([hidden])')) return; // an edit is open — don't wipe it
  load();
}, 45000);
