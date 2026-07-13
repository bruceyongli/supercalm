// SPA decisions view. Mounts into #view. The standalone /decisions page loads THREE scripts, all ported
// here faithfully so the page behaves identically:
//   1. decisions.js       — the Messages tab: filter + page the stored decision records (/api/decisions).
//   2. doctrine-tab.js     — the segmented Doctrine/Messages control + the #dc-doctrine approval cards.
//   3. doctrine-panel.js   — the #doctrine approval panel (self-refreshing on a 45s interval).
// Every module-top DOM binding (its `$('#…')`, `document.getElementById`, `querySelectorAll`) is moved
// INSIDE init() so it resolves against the freshly-rendered markup, and each module's code lives in its
// own scoped init function so their many same-named locals ($/box/card/load/render/post) don't collide.
// The doctrine-tab legacy-hide root is scoped to `host` (the standalone used `.dk-main` which the app
// shell does not have). teardown() clears the doctrine-panel 45s interval + the Messages search debounce.
// View contract: export init(host, params) + teardown().
import { $, api, escapeHtml, fmtAgo } from '../common.js';

const DECISIONS_CSS = `
      /* Scoped header layout for the SPA mount: the shell has no .dk-main, so the standalone's
         .dk-main>header reset doesn't apply. Stack the header as blocks so the Doctrine/Messages
         toggle + the #dc-doctrine content sit BELOW the title row instead of crammed into the
         flex .brand line (they used to be nested inside .brand). */
      .dc-head { display: block; max-width: 1100px; margin: 0 auto; padding: 12px 12px 0; }
      .dc-head .brand { display: flex; align-items: baseline; gap: 10px; margin: 0 0 4px; }
      .dc-head .brand .spacer { flex: 1; }
      .dc-head .brand .count { color: #5c6675; font-size: 12px; }
      .dc-head #dc-doctrine { display: block; }
      .rec-wrap { max-width: 1100px; margin: 0 auto; padding: 12px; }
      .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 10px; }
      .filters label { display: flex; flex-direction: column; font-size: 11px; color: #8a95a5; gap: 3px; }
      .filters select, .filters input { background: #0b0f16; color: #e2e8f1; border: 1px solid #2c3646; border-radius: 6px; padding: 6px; font: inherit; font-size: 13px; min-width: 0; }
      .filterbar-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
      .dec { border: 1px solid #232c38; border-left-width: 3px; border-radius: 8px; padding: 9px 11px; margin-bottom: 8px; background: #10151d; }
      .dec .rh { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 11px; color: #8a95a5; margin-bottom: 6px; }
      .dec.cat-action { border-left-color: #f2554d; }
      .dec.cat-decision { border-left-color: #e2b23e; }
      .dec.cat-review { border-left-color: #4ecb6c; }
      .cat { border-radius: 4px; padding: 0 6px; font-weight: 600; text-transform: uppercase; font-size: 10px; }
      .cat-action .cat, .b-action { background: #f2554d22; color: #f2554d; }
      .cat-decision .cat, .b-decision { background: #e2b23e22; color: #e2b23e; }
      .cat-review .cat, .b-review { background: #4ecb6c22; color: #4ecb6c; }
      .st { border: 1px solid #2c3646; border-radius: 4px; padding: 0 5px; font-size: 10px; }
      .st-answered { color: #4ecb6c; border-color: #4ecb6c55; }
      .st-pending { color: #e2b23e; border-color: #e2b23e55; }
      .st-superseded { color: #5c6675; }
      .src-tag { border: 1px solid #2c3646; border-radius: 4px; padding: 0 5px; }
      .summary { font-size: 14px; color: #e2e8f1; font-weight: 600; margin-bottom: 6px; word-break: break-word; }
      .ask { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: #adbac7; background: #0b0f14; border: 1px solid #202a35; border-radius: 6px; padding: 7px 9px; margin-bottom: 6px; max-height: 4.6em; overflow: hidden; cursor: pointer; }
      .ask.open { max-height: none; }
      .ask::before { content: "ask ▸ "; color: #5c6675; font-size: 11px; }
      .resp { font-size: 13px; word-break: break-word; padding: 6px 9px; border-radius: 6px; background: #122119; border: 1px solid #1f3a2a; color: #e2e8f1; }
      .resp.none { background: #1a1410; border-color: #3a2a1f; color: #8a95a5; }
      .resp .who { color: #4ecb6c; font-weight: 600; }
      .resp.none .who { color: #e2b23e; }
      .resp .rmeta { color: #5c6675; font-size: 11px; }
      .pager { display: flex; gap: 8px; align-items: center; justify-content: center; margin: 14px 0 28px; }
      .count { color: #8a95a5; font-size: 12px; }
      a.rlink { color: #58a6ff; text-decoration: none; }
      .tabs { display: flex; gap: 6px; }
      .tabs a { font-size: 12px; padding: 3px 10px; border: 1px solid #2c3646; border-radius: 6px; color: #8a95a5; text-decoration: none; }
      .tabs a.on { background: #1f6feb22; color: #58a6ff; border-color: #1f6feb55; }
      /* Supervisor doctrine (approval queue) */
      #doctrine { margin-bottom: 18px; }
      .doct-h { font-size: 15px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
      .doct-badge { background: #e2b23e22; color: #e2b23e; border: 1px solid #e2b23e55; border-radius: 10px; padding: 0 8px; font-size: 11px; font-weight: 600; }
      .doct { border: 1px solid #232c38; border-left: 3px solid #e2b23e; border-radius: 8px; padding: 9px 11px; margin-bottom: 8px; background: #10151d; }
      .doct.st-active { border-left-color: #4ecb6c; }
      .doct.st-rejected { border-left-color: #5c6675; opacity: .75; }
      .doct-when { font-size: 11px; color: #e2b23e; text-transform: uppercase; letter-spacing: .3px; margin-bottom: 4px; }
      .doct.st-active .doct-when { color: #4ecb6c; }
      .doct-rule { font-size: 13.5px; color: #e2e8f1; margin-bottom: 4px; word-break: break-word; }
      .doct-apply { font-size: 12px; color: #8a95a5; margin-bottom: 4px; }
      .doct-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
      .doct-ev { font-size: 12px; color: #8a95a5; margin-top: 4px; }
      .doct-ev summary { cursor: pointer; }
      .doct-ask, .doct-resp, .doct-div { white-space: pre-wrap; word-break: break-word; border: 1px solid #202a35; border-radius: 6px; padding: 5px 8px; margin-top: 5px; background: #0b0f14; }
      .doct-resp { background: #122119; border-color: #1f3a2a; color: #e2e8f1; }
      .doct-div { color: #e2b23e; }
      .doct-edit label { display: flex; flex-direction: column; font-size: 11px; color: #8a95a5; gap: 3px; margin: 5px 0; }
      .doct-edit input, .doct-edit textarea { background: #0b0f16; color: #e2e8f1; border: 1px solid #2c3646; border-radius: 6px; padding: 6px; font: inherit; font-size: 13px; }
      .doct-group { margin-top: 10px; }
      .doct-group summary { cursor: pointer; font-size: 12px; color: #8a95a5; margin-bottom: 6px; }
      .doct-err { color: #f2554d; font-size: 12px; }
      .doct-chip { border: 1px solid #2c3646; border-radius: 4px; padding: 0 6px; font-size: 10px; color: #8a95a5; }
      .doct-chip.audit { color: #58a6ff; border-color: #1f6feb55; }
      .doct-chip.viol { color: #e2b23e; border-color: #e2b23e55; }
      .doct-chip.rec-ok { color: #4ecb6c; border-color: #4ecb6c55; font-weight: 600; }
      .doct-chip.rec-no { color: #f2554d; border-color: #f2554d55; }
      .doct-triage-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
      .doct-edit select { background: #0b0f16; color: #e2e8f1; border: 1px solid #2c3646; border-radius: 6px; padding: 6px; font: inherit; font-size: 13px; }
`;

let host = null;
let panelTimer = null;      // doctrine-panel.js 45s self-refresh interval
let msgDebounce = null;     // Messages tab search-input debounce

// ---- 1. Messages tab (port of decisions.js) ------------------------------------------------------
function initMessages() {
  const PAGE = 50;
  let offset = 0;
  let total = 0;

  const fmtTs = (ts) => new Date(ts).toLocaleString();
  const localToMs = (v) => (v ? new Date(v).getTime() : 0);
  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function filters() {
    return {
      project: $('#f-project').value,
      session: $('#f-session').value,
      tool: $('#f-tool').value,
      model: $('#f-model').value,
      category: $('#f-category').value,
      status: $('#f-status').value,
      since: localToMs($('#f-since').value) || '',
      until: localToMs($('#f-until').value) || '',
      q: $('#f-q').value.trim(),
    };
  }
  function qs(extra = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters(), ...extra })) if (v) p.set(k, v);
    return p.toString();
  }

  async function load() {
    if (!host) return; // view already torn down
    $('#results').innerHTML = '<div class="empty">loading…</div>';
    try {
      const res = await api('api/decisions?' + qs({ limit: PAGE, offset }));
      if (!host) return; // left the view mid-fetch → #view cleared, $() now resolves to null
      total = res.total;
      render(res.records);
      $('#summary').textContent = `${total} decision${total === 1 ? '' : 's'}`;
      const from = total ? offset + 1 : 0;
      const to = Math.min(offset + PAGE, total);
      $('#pageinfo').textContent = `${from}–${to} of ${total}`;
      $('#prev').disabled = offset <= 0;
      $('#next').disabled = offset + PAGE >= total;
    } catch (e) {
      if (host) $('#results').innerHTML = '<div class="empty">Failed to load: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  function render(records) {
    const box = $('#results');
    if (!records.length) {
      box.innerHTML = '<div class="empty">No decisions match these filters.</div>';
      return;
    }
    box.innerHTML = '';
    for (const r of records) {
      const cat = ['action', 'decision', 'review'].includes(r.category) ? r.category : 'review';
      const el = document.createElement('div');
      el.className = 'dec cat-' + cat;
      const proj = r.project || '(adhoc)';
      el.innerHTML =
        '<div class="rh">' +
        `<span>${fmtTs(r.asked_at)}</span>` +
        `<span class="cat">${escapeHtml(cat)}</span>` +
        `<span class="st st-${escapeHtml(r.status || 'pending')}">${escapeHtml(r.status || 'pending')}</span>` +
        `<span class="badge">${escapeHtml(r.tool || '?')}</span>` +
        (r.model ? `<span class="src-tag">${escapeHtml(r.model)}</span>` : '') +
        `<b>${escapeHtml(proj)}</b>` +
        `<a class="rlink" href="session?id=${encodeURIComponent(r.session_id)}" title="open this session">${escapeHtml((r.session_id || '').slice(0, 10))} ↗</a>` +
        '</div>' +
        '<div class="summary"></div>' +
        '<div class="ask"></div>' +
        '<div class="resp' + (r.response ? '' : ' none') + '"></div>';
      el.querySelector('.summary').textContent = r.summary || '(no summary)';
      const askEl = el.querySelector('.ask');
      askEl.textContent = r.ask || r.question || '(no detail captured)';
      askEl.onclick = (e) => e.currentTarget.classList.toggle('open');
      const respEl = el.querySelector('.resp');
      if (r.response) {
        const dt = r.responded_at && r.asked_at ? ` · after ${fmtDur(r.responded_at - r.asked_at)}` : '';
        respEl.innerHTML = `<span class="who">you ▸ ${escapeHtml(r.response_source || '?')}</span> <span class="rmeta">${dt}</span><br>`;
        respEl.appendChild(document.createTextNode(r.response));
      } else {
        respEl.innerHTML = `<span class="who">no response</span> <span class="rmeta">· ${r.status === 'superseded' ? 'superseded by a later ask' : 'still pending'}</span>`;
      }
      box.appendChild(el);
    }
  }

  async function populate() {
    const st = await api('api/state');
    if (!host) return; // torn down mid-fetch
    const fill = (sel, items) => {
      const el = $(sel);
      for (const it of items) {
        const o = document.createElement('option');
        o.value = it.value;
        o.textContent = it.label;
        el.appendChild(o);
      }
    };
    fill('#f-project', (st.projects || []).map((p) => ({ value: p.id, label: p.name })));
    fill('#f-session', (st.sessions || []).map((s) => ({
      value: s.id,
      label: `${s.project ? s.project.name : 'adhoc'} · ${s.tool} · ${s.id.slice(0, 8)}${s.title ? ' — ' + s.title.slice(0, 30) : ''}`,
    })));
    fill('#f-tool', [...new Set((st.sessions || []).map((s) => s.tool))].filter(Boolean).map((t) => ({ value: t, label: t })));
    fill('#f-model', [...new Set((st.sessions || []).map((s) => s.model))].filter(Boolean).map((m) => ({ value: m, label: m })));
  }

  $('#clear').onclick = () => {
    document.querySelectorAll('.filters select, .filters input').forEach((e) => (e.value = ''));
    offset = 0;
    load();
  };
  $('#prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); };
  $('#next').onclick = () => { offset += PAGE; load(); };
  $('#export').onclick = async () => {
    try {
      const res = await api('api/decisions?' + qs({ limit: 2000, offset: 0 }));
      const blob = new Blob([JSON.stringify(res.records, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'aios-decisions.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      alert('Export failed: ' + (e.message || e));
    }
  };

  $('#f-q').addEventListener('input', () => { clearTimeout(msgDebounce); msgDebounce = setTimeout(() => { offset = 0; load(); }, 350); });
  document.querySelectorAll('.filters select, #f-since, #f-until').forEach((e) =>
    e.addEventListener('change', () => { offset = 0; load(); })
  );

  (async () => {
    try { await populate(); } catch {}
    load();
  })();
}

// ---- 2. Doctrine tab control + #dc-doctrine cards (port of doctrine-tab.js) -----------------------
function initDoctrineTab() {
  const esc = escapeHtml;
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

  // segmented: doctrine default; messages = the page's existing browser. Scope the legacy-view toggle to
  // the view container (`host`); the standalone used `.dk-main`, which the SPA app shell does not provide.
  const seg = host.querySelectorAll('[data-dc-tab]');
  const legacyRoot = host;
  const legacy = [...legacyRoot.children].filter((el) => !el.matches('[data-dc-seg], #dc-doctrine, script, h1, header, .dc-seg'));
  function setTab(t) {
    for (const b of seg) b.classList.toggle('on', b.dataset.dcTab === t);
    box.style.display = t === 'doctrine' ? '' : 'none';
    for (const el of legacy) el.style.display = t === 'doctrine' ? 'none' : '';
  }
  for (const b of seg) b.onclick = () => setTab(b.dataset.dcTab);
  setTab('doctrine');
  load();
}

// ---- 3. #doctrine approval panel (port of doctrine-panel.js) --------------------------------------
function initDoctrinePanel() {
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
    const enfChip = `<span class="doct-chip ${r.enforcement === 'audit' ? 'audit' : ''}" title="${r.enforcement === 'audit' ? 'Checked against work evidence on every completion review' : 'Shapes the supervisor’s judgment (prompt-injected)'}">${esc(r.enforcement || 'advisory')}</span>`;
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
  panelTimer = setInterval(() => {
    if (Date.now() < interactingUntil) return;
    if (box.querySelector('.doct-edit:not([hidden])')) return; // an edit is open — don't wipe it
    load();
  }, 45000);
}

export function init(el) {
  host = el;
  if (!document.getElementById('view-decisions-css')) {
    const st = document.createElement('style');
    st.id = 'view-decisions-css';
    st.textContent = DECISIONS_CSS;
    document.head.appendChild(st);
  }
  host.innerHTML = `
    <header class="dc-head">
      <div class="brand"><a href="." class="rlink">←</a> <h1>Decisions</h1><span class="spacer"></span><span class="count" id="summary"></span></div>
      <div class="dc-seg" data-dc-seg style="display:flex;gap:5px;margin:10px 0 16px">
        <button data-dc-tab="doctrine" class="on">Doctrine</button>
        <button data-dc-tab="messages">Messages</button>
      </div>
      <div id="dc-doctrine" data-dc-doctrine></div>
    </header>
    <main class="rec-wrap">
      <section id="doctrine"></section>
      <p class="count" style="margin:-2px 0 10px">Every time an agent paused for you: the model-distilled <b>ask</b> (its reasoning + the choice) → your <b>response</b>. For quick history + decision-model training.</p>
      <div class="filters">
        <label>Project <select id="f-project"><option value="">all</option></select></label>
        <label>Session <select id="f-session"><option value="">all</option></select></label>
        <label>Tool <select id="f-tool"><option value="">all</option></select></label>
        <label>Model <select id="f-model"><option value="">all</option></select></label>
        <label>Category <select id="f-category"><option value="">all</option><option value="decision">decision</option><option value="action">action</option><option value="review">review</option></select></label>
        <label>Status <select id="f-status"><option value="">all</option><option value="answered">answered</option><option value="pending">pending</option><option value="superseded">superseded</option><option value="expired">expired</option></select></label>
        <label>From <input type="datetime-local" id="f-since" /></label>
        <label>To <input type="datetime-local" id="f-until" /></label>
        <label style="grid-column: 1 / -1">Search text <input type="search" id="f-q" placeholder="substring of ask / summary / your response…" /></label>
      </div>
      <div class="filterbar-actions">
        <button class="btn ghost sm" id="clear">Clear filters</button>
        <button class="btn ghost sm" id="export">Export JSON (training)</button>
      </div>
      <div id="results"></div>
      <div class="pager">
        <button class="btn ghost sm" id="prev">← prev</button>
        <span class="count" id="pageinfo"></span>
        <button class="btn ghost sm" id="next">next →</button>
      </div>
    </main>`;

  initMessages();
  initDoctrineTab();
  initDoctrinePanel();
}

export function teardown() {
  if (panelTimer) clearInterval(panelTimer);
  panelTimer = null;
  if (msgDebounce) clearTimeout(msgDebounce);
  msgDebounce = null;
  host = null;
}
