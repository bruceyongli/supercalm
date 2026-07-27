import { api, escapeHtml, renderMarkdown } from '../common.js';

let P = null;
let host = null;
let reviews = [];
let active = null;
let draft = '';
let model = '';
let busy = false;
let notice = '';
const esc = (value) => escapeHtml(String(value ?? ''));

async function call(action, body = {}) {
  const response = await P.call(action, body);
  return response?.result ?? response;
}

function latestAdvice(thread) {
  return [...(thread?.messages || [])].reverse().find((message) => message.role === 'advisor') || null;
}

async function load() {
  const result = await call('review-list').catch(() => ({ reviews: [] }));
  reviews = result?.reviews || [];
  if (!active && reviews[0]) {
    const found = await call('review-thread', { threadId: reviews[0].id }).catch(() => null);
    active = found?.thread || null;
    const advice = latestAdvice(active);
    draft = advice?.content || '';
    model = advice?.model || '';
  }
}

function render() {
  if (!host) return;
  host.innerHTML = `
    <section class="review-sidecar">
      <div class="review-head">
        <div><h2>Council Review</h2><p>Diagnose what would help this session work more autonomously.</p></div>
        <span class="review-readonly">Read only</span>
      </div>
      <label class="review-focus">What should Council pay attention to?
        <textarea id="review-focus" rows="3" placeholder="Optional — for example: why is this blocked, or is my attention actually needed?"></textarea>
      </label>
      <div class="review-actions">
        <button class="btn sm" id="review-run" type="button" ${busy ? 'disabled' : ''}>${busy ? 'Reviewing…' : 'Review current session'}</button>
        ${reviews.length ? `<span>${reviews.length} saved review${reviews.length === 1 ? '' : 's'}</span>` : ''}
      </div>
      ${draft ? `
        <div class="review-result">
          <div class="review-result-head"><b>Council recommendation</b>${model ? `<span>${esc(model)}</span>` : ''}</div>
          <div class="review-rendered">${renderMarkdown(draft)}</div>
          <label>Edit before sending
            <textarea id="review-draft" rows="8">${esc(draft)}</textarea>
          </label>
          <div class="review-send">
            <button class="btn ghost sm" id="review-copy" type="button">Copy</button>
            <button class="btn sm" id="review-send" type="button">Send to agent</button>
          </div>
        </div>` : `<div class="review-empty">Nothing runs automatically. Start a review when you want a second opinion.</div>`}
      ${notice ? `<div class="review-notice">${esc(notice)}</div>` : ''}
    </section>`;
  const focus = host.querySelector('#review-focus');
  focus?.addEventListener('input', () => P.markDirty?.());
  host.querySelector('#review-run')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    notice = '';
    render();
    try {
      const result = await call('review-run', { focus: focus?.value || '' });
      active = result?.thread || null;
      draft = result?.review || latestAdvice(active)?.content || '';
      model = result?.model || latestAdvice(active)?.model || '';
      if (!draft) notice = result?.error || 'Council returned no recommendation.';
      await load();
    } catch (error) {
      notice = `Review failed: ${error?.message || error}`;
    } finally {
      busy = false;
      P.clearDirty?.();
      render();
    }
  });
  const draftBox = host.querySelector('#review-draft');
  draftBox?.addEventListener('input', () => {
    draft = draftBox.value;
    P.markDirty?.();
  });
  host.querySelector('#review-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(draftBox?.value || draft);
      notice = 'Copied.';
    } catch {
      notice = 'Copy failed.';
    }
    render();
  });
  host.querySelector('#review-send')?.addEventListener('click', async () => {
    const text = String(draftBox?.value || draft).trim();
    if (!text || !confirm('Send this recommendation to the working agent?')) return;
    try {
      await api(`api/session/${P.sessionId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, source: 'text' }),
      });
      notice = 'Sent explicitly to the agent.';
      P.clearDirty?.();
    } catch (error) {
      notice = `Send failed: ${error?.message || error}`;
    }
    render();
  });
}

export const panel = {
  async mount(element, panelApi) {
    P = panelApi;
    host = element;
    await load();
    render();
  },
  async update() {
    if (busy || P?.isDirty?.()) return;
    await load();
    render();
  },
  unmount() {
    P = null;
    host = null;
    reviews = [];
    active = null;
    draft = '';
    model = '';
    notice = '';
  },
};
