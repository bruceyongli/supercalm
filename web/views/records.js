// SPA records view. Mounts into #view; rich filter card (project/session/tool/model/source/direction +
// dates + text) + record cards from /api/records. Faithful port of the standalone records.js — the
// module-top filter wiring + initial load are moved into init() so DOM lookups resolve against the
// freshly-rendered markup; async work is generation-gated and the search-debounce timeout is captured
// and cleared in teardown(), so a fast route change cannot resume into a removed filter form.
// View contract: export init(host, params) + teardown().
import { api, escapeHtml as esc, fmtAgo } from '../common.js';

const RECORDS_CSS = `
    .rc-wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 32px; }
    .rc-wrap h1 { font-family: 'IBM Plex Sans', sans-serif; font-size: 26px; font-weight: 600; letter-spacing: -.01em; color: #e9eef5; margin: 0 0 16px; }
    .rc-filter { background: #10151d; border: 1px solid #1d2632; border-radius: 13px; padding: 13px 15px; display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    .rc-filter-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .rc-filter-row2 { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .rc-filter-row2 input[type="search"] { flex: 1; min-width: 180px; }
    .rc-filter select, .rc-filter input { background: #0b0f16; border: 1px solid #232c38; border-radius: 10px; color: #e9eef5; font: inherit; font-size: 12.5px; padding: 7px 10px; }
    .rc-filter input[type="search"] { flex: 1; min-width: 160px; }
    .rc-card { background: #0d1219; border: 1px solid #161d27; border-radius: 11px; padding: 11px 14px; margin-bottom: 8px; }
    .rc-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: #5c6675; }
    .rc-top b { color: #e9eef5; font-size: 12px; }
    .rc-top a { color: #79b8ff; text-decoration: none; }
    .rc-text { font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.6; color: #b9c4d4; margin-top: 6px; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .rc-more { text-align: center; margin: 14px 0; }
`;

let host = null;
let offset = 0, lastQuery = '';
let searchTimer = null;
let viewGeneration = 0;
const $ = (s) => host?.querySelector(s);
const localToMs = (v) => (v ? new Date(v).getTime() : 0);
const SELECTS = ['rc-project', 'rc-session', 'rc-tool', 'rc-model', 'rc-source', 'rc-dir'];

function queryString() {
  if (!host || !$('#rc-project')) return null;
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

async function load(append = false, token = viewGeneration) {
  const qs = queryString();
  if (qs == null) return;
  lastQuery = qs;
  let r = { records: [] };
  try { r = await api('api/records?' + qs); } catch {}
  if (!host || token !== viewGeneration) return;
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
  if (!list) return;
  if (append) list.insertAdjacentHTML('beforeend', cards);
  else list.innerHTML = cards || '<div class="dk-allclear">No records match.</div>';
  const more = $('#rc-more');
  if (more) more.style.display = (r.records || []).length === 40 ? '' : 'none';
}

async function populate(token) {
  try {
    const st = await api('api/state');
    if (!host || token !== viewGeneration) return;
    const fill = (sel, items) => {
      const el = $(sel);
      if (!el) return;
      for (const it of items) {
        const o = document.createElement('option');
        o.value = it.value;
        o.textContent = it.label;
        el.appendChild(o);
      }
    };
    fill('#rc-project', (st.projects || []).map((p) => ({ value: p.id, label: p.name })));
    fill('#rc-session', (st.sessions || []).map((s) => ({ value: s.id, label: `${s.project ? s.project.name : 'adhoc'} · ${s.tool} · ${s.id.slice(0, 8)}` })));
    fill('#rc-tool', [...new Set((st.sessions || []).map((s) => s.tool))].filter(Boolean).map((t) => ({ value: t, label: t })));
    fill('#rc-model', [...new Set((st.sessions || []).map((s) => s.model))].filter(Boolean).map((m) => ({ value: m, label: m })));
    fill('#rc-source', ['text', 'voice', 'detect', 'extracted', 'hook'].map((s) => ({ value: s, label: s })));
  } catch {}
}

export function init(el) {
  host = el;
  const token = ++viewGeneration;
  offset = 0; lastQuery = '';
  if (!document.getElementById('view-records-css')) {
    const st = document.createElement('style');
    st.id = 'view-records-css';
    st.textContent = RECORDS_CSS;
    document.head.appendChild(st);
  }
  host.innerHTML = `
    <div class="rc-wrap" data-rc>
      <h1>Records</h1>
      <div class="rc-filter" data-rc-filter>
        <div class="rc-filter-row">
          <select id="rc-project"><option value="">project · all</option></select>
          <select id="rc-session"><option value="">session · all</option></select>
          <select id="rc-tool"><option value="">tool · all</option></select>
          <select id="rc-model"><option value="">model · all</option></select>
          <select id="rc-source"><option value="">source · all</option></select>
          <select id="rc-dir"><option value="">direction · all</option><option value="in">in — to agent</option><option value="out">out — from agent</option></select>
        </div>
        <div class="rc-filter-row2">
          <input type="date" id="rc-since" />
          <input type="date" id="rc-until" />
          <input type="search" id="rc-q" placeholder="substring of any message…" />
          <button class="dk-reply-btn" id="rc-clear">Clear</button>
          <button class="dk-reply-btn" id="rc-export">Export JSON</button>
        </div>
      </div>
      <div id="rc-list">loading…</div>
      <div class="rc-more"><button class="dk-reply-btn" id="rc-more">Load more</button></div>
    </div>`;

  for (const id of [...SELECTS, 'rc-since', 'rc-until']) $('#' + id).onchange = () => { offset = 0; load(false, token); };
  $('#rc-q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { offset = 0; load(false, token); }, 350); };
  $('#rc-clear').onclick = () => { for (const id of [...SELECTS, 'rc-since', 'rc-until', 'rc-q']) $('#' + id).value = ''; offset = 0; load(false, token); };
  $('#rc-more').onclick = () => { offset += 40; load(true, token); };
  $('#rc-export').onclick = () => { location.href = 'api/records?' + lastQuery.replace(/limit=40/, 'limit=2000'); };
  (async () => {
    await populate(token);
    if (host && token === viewGeneration) await load(false, token);
  })().catch(() => {});
}

export function teardown() {
  clearTimeout(searchTimer);
  searchTimer = null;
  viewGeneration++;
  host = null;
}
