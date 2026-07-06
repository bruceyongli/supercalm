import { $, api, escapeHtml } from './common.js';

// Decisions browser: filter + page the stored decision events via /api/decisions. Each row =
// one agent "ask" (model-distilled reasoning + the choice) paired with your response. Filter
// options come from /api/state. Path-relative (served under /aios/).
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
  $('#results').innerHTML = '<div class="empty">loading…</div>';
  try {
    const res = await api('api/decisions?' + qs({ limit: PAGE, offset }));
    total = res.total;
    render(res.records);
    $('#summary').textContent = `${total} decision${total === 1 ? '' : 's'}`;
    const from = total ? offset + 1 : 0;
    const to = Math.min(offset + PAGE, total);
    $('#pageinfo').textContent = `${from}–${to} of ${total}`;
    $('#prev').disabled = offset <= 0;
    $('#next').disabled = offset + PAGE >= total;
  } catch (e) {
    $('#results').innerHTML = '<div class="empty">Failed to load: ' + escapeHtml(e.message || String(e)) + '</div>';
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

let debounce;
$('#f-q').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { offset = 0; load(); }, 350); });
document.querySelectorAll('.filters select, #f-since, #f-until').forEach((e) =>
  e.addEventListener('change', () => { offset = 0; load(); })
);

(async () => {
  try { await populate(); } catch {}
  load();
})();
