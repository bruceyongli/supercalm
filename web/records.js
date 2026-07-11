// Records page (design handoff): rich filter card (project/session/tool/model/source/direction + dates
// + text) + record cards from /api/records. Filter options come from /api/state, matching Decisions.
import { api, escapeHtml as esc, fmtAgo } from './common.js';
const $ = (s) => document.querySelector(s);
let offset = 0, lastQuery = '';
const localToMs = (v) => (v ? new Date(v).getTime() : 0);
const SELECTS = ['rc-project', 'rc-session', 'rc-tool', 'rc-model', 'rc-source', 'rc-dir'];

function queryString() {
  const p = new URLSearchParams();
  const set = (k, v) => { if (v) p.set(k, v); };
  set('project', $('#rc-project').value);
  set('session', $('#rc-session').value);
  set('tool', $('#rc-tool').value);
  set('model', $('#rc-model').value);
  set('source', $('#rc-source').value);
  set('direction', $('#rc-dir').value);
  const since = localToMs($('#rc-since').value); if (since) p.set('since', String(since));
  const until = localToMs($('#rc-until').value); if (until) p.set('until', String(until));
  set('q', $('#rc-q').value.trim());
  p.set('limit', '40');
  p.set('offset', String(offset));
  return p.toString();
}

async function load(append = false) {
  const qs = queryString();
  lastQuery = qs;
  let r = { records: [] };
  try { r = await api('api/records?' + qs); } catch {}
  const cards = (r.records || []).map((x) => `
    <div class="rc-card" data-rc-card>
      <div class="rc-top">
        <b>${esc(x.tool || '')}</b>
        ${x.model ? `<span class="dk-chip" style="color:#9aa7b8;border-color:#232c38">${esc(x.model)}</span>` : ''}
        <span>${esc(x.direction === 'in' ? '→ to agent' : '← from agent')}</span>
        <span>${esc(x.project || '')}</span>
        <a href="session?id=${esc(x.session_id)}">${esc((x.session_id || '').slice(0, 13))}</a>
        <span style="margin-left:auto">${fmtAgo(x.ts)} ago</span>
      </div>
      <div class="rc-text">${esc((x.text || '').slice(0, 700))}</div>
    </div>`).join('');
  const list = $('#rc-list');
  if (append) list.insertAdjacentHTML('beforeend', cards);
  else list.innerHTML = cards || '<div class="dk-allclear">No records match.</div>';
  $('#rc-more').style.display = (r.records || []).length === 40 ? '' : 'none';
}

async function populate() {
  try {
    const st = await api('api/state');
    const fill = (sel, items) => { const el = $(sel); for (const it of items) { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; el.appendChild(o); } };
    fill('#rc-project', (st.projects || []).map((p) => ({ value: p.id, label: p.name })));
    fill('#rc-session', (st.sessions || []).map((s) => ({ value: s.id, label: `${s.project ? s.project.name : 'adhoc'} · ${s.tool} · ${s.id.slice(0, 8)}` })));
    fill('#rc-tool', [...new Set((st.sessions || []).map((s) => s.tool))].filter(Boolean).map((t) => ({ value: t, label: t })));
    fill('#rc-model', [...new Set((st.sessions || []).map((s) => s.model))].filter(Boolean).map((m) => ({ value: m, label: m })));
    fill('#rc-source', ['text', 'voice', 'detect', 'extracted', 'hook'].map((s) => ({ value: s, label: s })));
  } catch {}
}

for (const id of [...SELECTS, 'rc-since', 'rc-until']) $('#' + id).onchange = () => { offset = 0; load(); };
let t = null;
$('#rc-q').oninput = () => { clearTimeout(t); t = setTimeout(() => { offset = 0; load(); }, 350); };
$('#rc-clear').onclick = () => { for (const id of [...SELECTS, 'rc-since', 'rc-until', 'rc-q']) $('#' + id).value = ''; offset = 0; load(); };
$('#rc-more').onclick = () => { offset += 40; load(true); };
$('#rc-export').onclick = () => { location.href = 'api/records?' + lastQuery.replace(/limit=40/, 'limit=2000'); };
(async () => { await populate(); load(); })();
