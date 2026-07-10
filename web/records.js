// Records page (design handoff): filter card + record cards from /api/records.
import { api, escapeHtml as esc, fmtAgo } from './common.js';
const $ = (s) => document.querySelector(s);
let offset = 0, lastQuery = '';

function queryString() {
  const p = new URLSearchParams();
  if ($('#rc-dir').value) p.set('direction', $('#rc-dir').value);
  if ($('#rc-tool').value) p.set('tool', $('#rc-tool').value);
  if ($('#rc-q').value.trim()) p.set('q', $('#rc-q').value.trim());
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
for (const id of ['rc-dir', 'rc-tool']) $('#' + id).onchange = () => { offset = 0; load(); };
let t = null;
$('#rc-q').oninput = () => { clearTimeout(t); t = setTimeout(() => { offset = 0; load(); }, 350); };
$('#rc-clear').onclick = () => { $('#rc-dir').value = ''; $('#rc-tool').value = ''; $('#rc-q').value = ''; offset = 0; load(); };
$('#rc-more').onclick = () => { offset += 40; load(true); };
$('#rc-export').onclick = () => { location.href = 'api/records?' + lastQuery.replace(/limit=40/, 'limit=2000'); };
load();
