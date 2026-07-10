// Doctrine tab on /decisions (design handoff): rule cards with WHEN trigger, Approve/Edit/Reject,
// triage + apply-suggestions — the doctrine-approval surface, first-class instead of panel-only.
// Messages tab = the existing decision-records browser on this page (untouched below).
import { api, escapeHtml as esc, fmtAgo } from './common.js';
const $ = (s) => document.querySelector(s);
const box = $('#dc-doctrine');

function card(r) {
  const cand = r.status === 'candidate';
  return `
  <div class="dc-rule${cand ? '' : ' settled'}" data-dc-rule data-id="${esc(r.id)}">
    <div class="dc-when">WHEN ${esc((r.situation || '').replace(/^\s*when\s+/i, '').toUpperCase().slice(0, 160))}</div>
    <div class="dc-text">${esc(r.rule || '')}</div>
    ${r.apply_how ? `<div class="dc-apply">apply ▸ ${esc(r.apply_how)}</div>` : ''}
    <div class="dc-foot">
      ${cand ? `<button class="dk-new sm" data-act="active">✓ Approve</button>
        <button class="dk-reply-btn" data-act="edit">Edit</button>
        <button class="dk-reply-btn" data-act="rejected">✕ Reject</button>`
      : `<span class="dk-chip" style="color:${r.status === 'active' ? '#4ecb6c' : '#8a95a5'};border-color:currentColor">${esc(r.status.toUpperCase())}</span>`}
      ${r.enforcement === 'audit' ? '<span class="dk-chip" style="color:#e2b23e;border-color:#e2b23e55">AUDIT</span>' : ''}
      <span class="dc-meta">learned ${fmtAgo(r.created_at)} ago · evidence ×${r.evidence_count || 1}${r.reuse_count ? ` · applied ${r.reuse_count}×` : ''}</span>
    </div>
    <div class="dc-edit" hidden><textarea rows="3">${esc(r.rule || '')}</textarea><button class="dk-new sm" data-act="save-edit">Save &amp; approve</button></div>
  </div>`;
}

async function load() {
  let rules = [];
  try { rules = (await api('api/doctrine')).rules || []; } catch (e) { box.innerHTML = `<p class="hint">doctrine unavailable: ${esc(e.message || e)}</p>`; return; }
  const cands = rules.filter((r) => r.status === 'candidate');
  const live = rules.filter((r) => r.status === 'active');
  box.innerHTML = `
    <p class="dc-intro">Standing rules learned from your real replies. <b>Approving deploys the rule</b> into the supervisor's prompts on the next tick.</p>
    <div class="dc-actions">
      <button class="dk-reply-btn" id="dc-triage">✳ Have the supervisor review these</button>
      <button class="dk-new sm" id="dc-apply" ${cands.length ? '' : 'disabled'}>Apply suggestions</button>
      <span class="dc-meta">${cands.length} to review · ${live.length} live</span>
      <span class="dc-meta" id="dc-msg"></span>
    </div>
    ${cands.map(card).join('')}
    <details class="dc-live"><summary>Live rules (${live.length})</summary>${live.map(card).join('')}</details>`;
  wire();
}

function wire() {
  $('#dc-triage').onclick = async () => { $('#dc-msg').textContent = 'reviewing…'; try { await api('api/doctrine/triage', { method: 'POST' }); $('#dc-msg').textContent = '✓ reviewed'; load(); } catch (e) { $('#dc-msg').textContent = '⚠ ' + (e.message || e); } };
  $('#dc-apply').onclick = async () => { $('#dc-msg').textContent = 'applying…'; try { await api('api/doctrine/triage/apply', { method: 'POST' }); $('#dc-msg').textContent = '✓ applied'; load(); } catch (e) { $('#dc-msg').textContent = '⚠ ' + (e.message || e); } };
  for (const el of box.querySelectorAll('[data-dc-rule]')) {
    const id = el.dataset.id;
    for (const b of el.querySelectorAll('[data-act]')) b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'edit') { el.querySelector('.dc-edit').hidden = false; return; }
      const body = act === 'save-edit' ? { status: 'active', rule: el.querySelector('.dc-edit textarea').value } : { status: act };
      try { await api(`api/doctrine/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); el.style.opacity = '0.5'; setTimeout(load, 500); }
      catch (e) { b.textContent = '⚠'; }
    };
  }
}

// segmented: doctrine default; messages = the page's existing browser
const seg = document.querySelectorAll('[data-dc-tab]');
const legacy = [...document.querySelectorAll('body > *')].filter((el) => !el.matches('[data-dc-seg], #dc-doctrine, script, h1, header, .dc-seg'));
function setTab(t) {
  for (const b of seg) b.classList.toggle('on', b.dataset.dcTab === t);
  box.style.display = t === 'doctrine' ? '' : 'none';
  for (const el of legacy) el.style.display = t === 'doctrine' ? 'none' : '';
}
for (const b of seg) b.onclick = () => setTab(b.dataset.dcTab);
setTab('doctrine');
load();
