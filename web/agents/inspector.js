import { api, escapeHtml } from '../common.js';

let P = null;
let host = null;
let data = null;
let loading = false;
let teaching = false;
let savedStandardId = null;
let focus = null;
let onFocusEvent = null;

const esc = (value) => escapeHtml(String(value ?? ''));
const when = (ts) => ts ? new Date(Number(ts)).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const request = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

function focusFromWindow() {
  const next = window.__aiosEvidenceFocus;
  return next && (!next.sessionId || next.sessionId === P?.sessionId) ? next : null;
}

async function load() {
  if (!P || loading) return;
  loading = true;
  if (!data) render();
  try {
    focus = focusFromWindow() || focus;
    const query = focus?.ts ? `?focus_ts=${encodeURIComponent(focus.ts)}` : '';
    data = await api(`api/session/${P.sessionId}/evidence${query}`);
    if (savedStandardId && !(data.guidance?.standards || []).some((rule) => rule.id === savedStandardId)) savedStandardId = null;
  } catch (error) {
    data = { error: error?.message || String(error) };
  } finally {
    loading = false;
    render();
  }
}

function verdictClass(verdict) {
  if (verdict === 'complete' || verdict === 'on_track') return 'ok';
  if (verdict === 'off_track') return 'bad';
  if (verdict === 'needs_attention') return 'warn';
  return '';
}

function stepRows(steps) {
  if (!steps?.length) return '<p class="ev-empty">No command was attached to this event.</p>';
  return steps.map((step) => `<div class="ev-step">
    <span>${esc(step.human || 'Command')}</span>
    ${step.cmd ? `<code>$ ${esc(step.cmd)}</code>` : ''}
  </div>`).join('');
}

function ruleRow(rule) {
  const usage = rule.usedInThisRun
    ? '<span class="ev-rule-use current">in this run</span>'
    : rule.reuseCount
      ? `<span class="ev-rule-use">used ${rule.reuseCount}×</span>`
      : '<span class="ev-rule-use never">never used</span>';
  return `<li class="ev-rule${rule.id === savedStandardId ? ' learned' : ''}">
    <div><span class="ev-rule-dot"></span><span>${esc(rule.text)}</span></div>
    <footer>${usage}${rule.lastUsedAt ? `<span>${esc(when(rule.lastUsedAt))}</span>` : ''}</footer>
  </li>`;
}

function render() {
  if (!host) return;
  if (loading && !data) {
    host.innerHTML = '<div class="ev-pane"><div class="ev-loading">Gathering focused evidence…</div></div>';
    return;
  }
  if (data?.error) {
    host.innerHTML = `<div class="ev-pane"><div class="ev-head"><div><span class="ev-kicker">Exception loop</span><h2>Evidence</h2></div><button class="btn sm" data-ev-refresh>Retry</button></div><p class="ev-empty">${esc(data.error)}</p></div>`;
    host.querySelector('[data-ev-refresh]').onclick = load;
    return;
  }
  const event = data?.focus;
  const review = data?.review;
  const git = data?.evidence?.git;
  const rules = data?.guidance?.standards || [];
  const rulesInRun = rules.filter((rule) => rule.usedInThisRun);
  const context = data?.guidance?.context;
  const saved = savedStandardId ? rules.find((rule) => rule.id === savedStandardId) : null;
  const focusTitle = event?.title || (review?.assessment ? 'Supervisor review' : 'Latest session evidence');
  const focusBody = event?.body || review?.assessment || 'No exception has been recorded yet. Evidence will appear as the agent works.';
  const touched = git?.stat || git?.status || '';
  host.innerHTML = `
    <div class="ev-pane">
      <div class="ev-head">
        <div><span class="ev-kicker">Exception loop</span><h2>Evidence → Rule</h2></div>
        <button class="btn ghost sm" data-ev-refresh title="Refresh evidence">↻</button>
      </div>
      <p class="ev-purpose">Find the smallest useful failure, teach the system once, then let the agent try again.</p>

      ${review ? `<section class="ev-review">
        <div><span class="ev-verdict ${verdictClass(review.verdict)}">${esc(String(review.verdict || 'review').replaceAll('_', ' '))}</span>${review.score != null ? `<span class="ev-score">${Number(review.score)}/100</span>` : ''}</div>
        <p>${esc(review.assessment || review.message || '')}</p>
        ${review.unmet?.length ? `<ul>${review.unmet.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
      </section>` : ''}

      <section class="ev-focus">
        <div class="ev-section-head"><span>Focused step</span>${event?.ts ? `<time>${esc(when(event.ts))}</time>` : ''}</div>
        <h3>${esc(focusTitle)}</h3>
        <p>${esc(focusBody)}</p>
        ${event?.exitCode != null ? `<span class="ev-exit">exit ${Number(event.exitCode)}</span>` : ''}
        <div class="ev-steps">${stepRows(data?.commandSteps || [])}</div>
      </section>

      <section class="ev-rules-in-run">
        <div class="ev-section-head"><span>Guidance in this run</span><button class="ev-link" data-ev-knowledge>Open Knowledge</button></div>
        <div class="ev-rule-chips">
          ${context?.enabled ? '<span class="ev-rule-chip">Project context</span>' : ''}
          ${rulesInRun.map((rule) => `<span class="ev-rule-chip" title="${esc(rule.text)}">${esc(rule.text.slice(0, 110))}</span>`).join('')}
          ${!context?.enabled && !rulesInRun.length ? '<span class="ev-none">No saved project rules were included in this run.</span>' : ''}
        </div>
      </section>

      <div class="ev-details">
        ${touched ? `<details><summary>Changed files</summary><pre>${esc(touched)}</pre></details>` : ''}
        ${git?.diffHunk ? `<details><summary>Focused diff hunk</summary><pre>${esc(git.diffHunk)}</pre></details>` : ''}
        ${data?.evidence?.terminal ? `<details><summary>Terminal tail</summary><pre>${esc(data.evidence.terminal)}</pre></details>` : ''}
        ${data?.timeline?.length ? `<details><summary>Nearby timeline · ${data.timeline.length} events</summary><ol>${data.timeline.map((item) => `<li><span>${esc(item.kind)}</span>${esc(item.title || item.body || '')}</li>`).join('')}</ol></details>` : ''}
      </div>

      ${teaching ? `<section class="ev-teach">
        <div class="ev-section-head"><span>Teach a project rule</span><span>applies to future runs</span></div>
        <textarea data-ev-rule rows="5" maxlength="1000">${esc(data?.suggestedRule || '')}</textarea>
        <p>Keep it narrow and observable. Saving is approval; the rule becomes active immediately.</p>
        <div class="ev-actions"><button class="btn ghost sm" data-ev-cancel>Cancel</button><button class="btn sm" data-ev-save>Save project rule</button></div>
      </section>` : saved ? `<section class="ev-learned">
        <span>✓ Project rule saved</span>
        <p>${esc(saved.text)}</p>
        <button class="btn sm" data-ev-retry>Retry with this rule</button>
      </section>` : `<button class="ev-teach-primary" data-ev-teach ${data?.project ? '' : 'disabled'}>Teach from this exception</button>`}

      ${rules.length ? `<section class="ev-ledger">
        <div class="ev-section-head"><span>Project rule ledger</span><span>${rules.length} active</span></div>
        <ul>${rules.slice(-6).reverse().map(ruleRow).join('')}</ul>
      </section>` : ''}
    </div>`;
  wire();
}

function wire() {
  host.querySelector('[data-ev-refresh]')?.addEventListener('click', load);
  host.querySelector('[data-ev-knowledge]')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('aios:open-agent', { detail: { id: 'knowledge' } }));
  });
  host.querySelector('[data-ev-teach]')?.addEventListener('click', () => {
    teaching = true;
    P?.markDirty?.();
    render();
    host.querySelector('[data-ev-rule]')?.focus();
  });
  host.querySelector('[data-ev-cancel]')?.addEventListener('click', () => {
    teaching = false;
    P?.clearDirty?.();
    render();
  });
  host.querySelector('[data-ev-rule]')?.addEventListener('input', () => P?.markDirty?.());
  host.querySelector('[data-ev-save]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const rule = host.querySelector('[data-ev-rule]')?.value.trim() || '';
    if (rule.length < 20) {
      button.textContent = 'Make the rule more specific';
      return;
    }
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const result = await request(`api/session/${P.sessionId}/teach`, { rule, focus_ts: data?.focus?.ts || 0 });
      savedStandardId = result?.standard?.id || null;
      teaching = false;
      P?.clearDirty?.();
      window.dispatchEvent(new CustomEvent('aios:evidence-learned', {
        detail: { sessionId: P.sessionId, eventTs: data?.focus?.ts || 0, standardId: savedStandardId },
      }));
      await load();
    } catch (error) {
      button.disabled = false;
      button.textContent = `Save failed · ${error?.message || error}`;
    }
  });
  host.querySelector('[data-ev-retry]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Sending rule…';
    try {
      await request(`api/session/${P.sessionId}/teach/${encodeURIComponent(savedStandardId)}/retry`, {});
      button.textContent = '✓ Sent — agent resumed';
      await load();
    } catch (error) {
      button.disabled = false;
      button.textContent = `Retry failed · ${error?.message || error}`;
    }
  });
}

export const panel = {
  async mount(element, papi) {
    P = papi;
    host = element;
    focus = focusFromWindow();
    onFocusEvent = (event) => {
      if (event.detail?.sessionId && event.detail.sessionId !== P?.sessionId) return;
      focus = event.detail || null;
      data = null;
      savedStandardId = null;
      teaching = false;
      P?.clearDirty?.();
      load();
    };
    window.addEventListener('aios:inspect-evidence', onFocusEvent);
    await load();
  },
  async update() {
    if (teaching || P?.isDirty?.()) return;
    await load();
  },
  unmount() {
    if (onFocusEvent) window.removeEventListener('aios:inspect-evidence', onFocusEvent);
    onFocusEvent = null;
    host = null;
    P = null;
    data = null;
    focus = null;
    teaching = false;
    savedStandardId = null;
  },
};
