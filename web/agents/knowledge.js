import { api, $, escapeHtml } from '../common.js';

// "Project Knowledge" panel — manages #2 CONTEXT.md (shared vocabulary, injected into launches) and
// #4 wiki (self-maintaining, served to agents over MCP), both PER-PROJECT. Always-on tab (like Graph);
// drives the REST routes directly. The per-project enables live in project_helpers (toggled here).
let P = null;
let host = null;
let pid = null;
let pname = '';
let data = null;
let dirty = false; // guards the CONTEXT editor from update() clobber (see [[sse-refresh-clobber]])
let copyNotice = '';
let uploadFilterText = '';
let uploadFilterType = '';
let filesFilterText = '';
const esc = (s) => escapeHtml(String(s ?? ''));
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

// model <select> from the live fleet catalog; value '' = auto (the module's default/fallback chain).
function modelSelect(id, models, current) {
  const groups = new Map();
  for (const m of (models || [])) { const k = m.providerLabel || m.provider || '?'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const known = new Set((models || []).map((m) => m.id));
  let opts = `<option value="" ${!current ? 'selected' : ''}>Auto (default chain)</option>`;
  if (current && !known.has(current)) opts += `<option value="${esc(current)}" selected>${esc(current)} · custom</option>`;
  for (const [prov, list] of groups) opts += `<optgroup label="${esc(prov)}">` + list.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc((m.label || m.id).replace(prov + ' / ', ''))}</option>`).join('') + `</optgroup>`;
  return `<select id="${id}" class="kn-model">${opts}</select>`;
}

async function load() {
  const sid = P.sessionId;
  const sr = await api('api/session/' + sid).catch(() => null);
  const s = sr?.session || sr || {};
  pid = s.project?.id || s.project_id || null;
  pname = s.project?.name || '';
  if (!pid) { data = null; return; }
  const [helpers, ctx, wiki, assets, lessons, files] = await Promise.all([
    api(`api/project/${pid}/helpers`).catch(() => null),
    api(`api/project/${pid}/context`).catch(() => null),
    api(`api/project/${pid}/wiki`).catch(() => null),
    api(`api/project/${pid}/assets?session=${encodeURIComponent(sid)}`).catch(() => null),
    api(`api/project/${pid}/lessons`).catch(() => null),
    api(`api/session/${sid}/files`).catch(() => null),
  ]);
  data = { helpers: helpers?.helpers || {}, models: helpers?.models || [], ctx: ctx?.context || null, pages: wiki?.pages || [], assets: assets || { uploads: [], wiki: [] }, lessons: lessons?.lessons || [], files: files?.files || [], filesTrunc: !!files?.truncated };
}

function lessonRow(l) {
  const badge = l.status === 'active' ? 'active' : l.kind === 'adherence' ? 'adherence' : 'candidate';
  const color = badge === 'active' ? '#3fb950' : badge === 'adherence' ? '#8b949e' : '#d29922';
  const reuse = l.reuse_count ? ` · used ${l.reuse_count}×` : '';
  const sha = l.git_sha ? ` · @${esc(l.git_sha)}` : '';
  const act = l.status === 'active'
    ? `<button class="btn sm" data-les-demote="${esc(l.id)}">demote</button>`
    : `<button class="btn sm" data-les-promote="${esc(l.id)}">promote</button>`;
  const tip = l.gotcha || l.dead_end || l.what_worked || '';
  return `<li class="kn-lesson" style="margin:6px 0;padding:6px 0;border-top:1px solid #21262d">
    <div><span style="display:inline-block;padding:0 6px;border-radius:8px;font-size:10px;border:1px solid ${color}99;color:${color}">${badge}</span> <b>${esc(l.title || l.task_type || 'lesson')}</b> <span class="kn-meta">${esc(l.task_type || '')}${reuse}${sha}</span></div>
    ${tip ? `<div class="kn-meta" style="margin:2px 0">${esc(tip).slice(0, 220)}</div>` : ''}
    <div class="kn-row">${act} <button class="btn sm" data-les-del="${esc(l.id)}">delete</button></div>
  </li>`;
}

function assetMeta(a) {
  const bits = [];
  if (a.format) bits.push(a.format);
  if (a.source) bits.push(a.source);
  if (a.size) bits.push(formatBytes(a.size));
  if (a.session_title) bits.push(a.current_session ? 'this session' : a.session_title);
  return bits.join(' · ');
}

function fileStatusChip(status) {
  const map = { new: ['new', '#3fb950'], modified: ['changed', '#d29922'], tracked: ['doc', '#8b949e'] };
  const [label, color] = map[status] || ['file', '#8b949e'];
  return `<span class="kn-chip" style="border-color:${color}99;color:${color}">${label}</span>`;
}
function fileRow(f) {
  return `<li class="kn-file-row" data-open-file="${esc(f.path)}" title="${esc(f.path)}">
    ${fileStatusChip(f.status)}<code class="kn-file-path">${esc(f.path)}</code><span class="kn-meta">${esc(formatBytes(f.bytes))}</span>
  </li>`;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n ? n + ' B' : '';
}

function allAssets() {
  const wiki = data?.assets?.wiki?.length
    ? data.assets.wiki
    : (data?.pages || []).map((p) => ({
        id: `wiki:${p.path}`,
        kind: 'wiki',
        contentKind: 'text',
        path: p.path,
        title: p.title || p.path,
        source: p.source || '',
        size: p.bytes || 0,
        viewUrl: `api/project/${encodeURIComponent(pid)}/wiki/raw?path=${encodeURIComponent(p.path)}`,
        downloadUrl: `api/project/${encodeURIComponent(pid)}/wiki/raw?path=${encodeURIComponent(p.path)}&download=1`,
        refText: `[wiki:${p.path}] ${p.title || p.path}`,
        composerText: `[wiki:${p.path}] ${p.title || p.path}`,
      }));
  return [...(data?.assets?.uploads || []), ...wiki];
}

function assetById(id) {
  return allAssets().find((a) => String(a.id) === String(id));
}

function assetBadge(a) {
  if (a.kind === 'wiki') return 'WIKI';
  if (a.contentKind === 'text' && /^pasted-/i.test(a.name || '')) return 'PASTED';
  return String(a.format || a.contentKind || 'FILE').toUpperCase().slice(0, 12);
}

function assetRows(items, emptyText) {
  if (!items?.length) return `<li class="kn-note">${esc(emptyText)}</li>`;
  return items.map((a) => {
    const title = a.title || a.name || a.path || a.id;
    const path = a.localPath || a.path || '';
    const meta = assetMeta(a);
    const visual = a.contentKind === 'image' && a.viewUrl
      ? `<img class="asset-card-image" src="${esc(a.viewUrl)}" alt="${esc(title)}" loading="lazy" />`
      : `<div class="asset-card-text">${esc(a.preview || title)}</div>`;
    const view = a.viewUrl ? `<a class="btn ghost sm" href="${esc(a.viewUrl)}" target="_blank" rel="noopener">View</a>` : '';
    const download = a.downloadUrl ? `<a class="btn ghost sm" href="${esc(a.downloadUrl)}" download="${esc(a.downloadName || a.name || '')}">Download</a>` : '';
    return `<li class="asset-card" draggable="true" data-asset-id="${esc(a.id)}" title="Drag into the composer to reference this file">
      <button class="asset-card-open" type="button" data-open-asset="${esc(a.id)}" aria-label="Open ${esc(title)} details">
        <div class="asset-card-preview ${a.contentKind === 'image' ? 'image' : 'text'}">${visual}</div>
        <div class="asset-card-badge">${esc(assetBadge(a))}</div>
        <div class="asset-card-name">${esc(title)}</div>
        ${meta ? `<div class="asset-card-meta">${esc(meta)}</div>` : ''}
      </button>
      <div class="asset-card-actions">
        ${view}
        ${download}
        <button class="btn ghost sm" type="button" data-copy-asset="${esc(a.id)}">Copy</button>
        <button class="btn sm" type="button" data-insert-asset="${esc(a.id)}">Insert</button>
      </div>
    </li>`;
  }).join('');
}

function uploadTypeOptions(uploads) {
  const vals = [...new Set((uploads || []).map((a) => a.contentKind || a.format || 'file').filter(Boolean))].sort();
  return '<option value="">All types</option>' + vals.map((v) => `<option value="${esc(v)}" ${v === uploadFilterType ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function filteredUploads(uploads) {
  const q = uploadFilterText.trim().toLowerCase();
  return (uploads || []).filter((a) => {
    const type = a.contentKind || a.format || 'file';
    if (uploadFilterType && type !== uploadFilterType) return false;
    if (!q) return true;
    return [a.name, a.path, a.id, a.session_title, a.format, a.type].filter(Boolean).join('\n').toLowerCase().includes(q);
  });
}

function filteredFiles(files) {
  const q = filesFilterText.trim().toLowerCase();
  if (!q) return files || [];
  return (files || []).filter((f) => String(f.path || '').toLowerCase().includes(q));
}

function updateFilesFilter(value) {
  filesFilterText = value || '';
  render();
  const e = $('#kn-files-filter');
  if (e) {
    e.focus();
    try { e.setSelectionRange(e.value.length, e.value.length); } catch {}
  }
}

function updateUploadFilter(value) {
  uploadFilterText = value || '';
  render();
  const e = $('#kn-file-filter');
  if (e) {
    e.focus();
    try { e.setSelectionRange(e.value.length, e.value.length); } catch {}
  }
}

async function copyText(text) {
  await navigator.clipboard.writeText(String(text || ''));
}

async function copyAsset(a) {
  if (!a) return;
  try {
    if (a.contentKind === 'image' && a.viewUrl && navigator.clipboard?.write && window.ClipboardItem) {
      const blob = await fetch(a.viewUrl).then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.blob();
      });
      const type = blob.type || a.type || 'image/png';
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      copyNotice = `Copied image: ${a.name || a.id}`;
    } else if ((a.contentKind === 'text' || a.kind === 'wiki') && a.viewUrl) {
      const text = await fetch(a.viewUrl).then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.text();
      });
      await copyText(text);
      copyNotice = `Copied contents: ${a.title || a.name || a.id}`;
    } else {
      await copyText(a.refText || a.composerText || a.id);
      copyNotice = `Copied reference: ${a.id}`;
    }
  } catch {
    await copyText(a.refText || a.composerText || a.viewUrl || a.id);
    copyNotice = `Copied reference: ${a.id}`;
  }
  render();
}

function insertAsset(a) {
  if (!a) return;
  window.dispatchEvent(new CustomEvent('aios:insert-reference', { detail: { text: a.composerText || a.refText || a.id } }));
}

function metaRows(rows) {
  return rows.filter(([, v]) => v != null && String(v) !== '').map(([k, v]) => `<div><span>${esc(k)}</span><code>${esc(v)}</code></div>`).join('');
}

async function openAssetDetail(a) {
  if (!a) return;
  let body = '';
  if (a.contentKind === 'image' && a.viewUrl) {
    body = `<img class="asset-detail-image" src="${esc(a.viewUrl)}" alt="${esc(a.title || a.name || a.id)}" />`;
  } else if ((a.contentKind === 'text' || a.kind === 'wiki') && a.viewUrl) {
    const text = await fetch(a.viewUrl).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    body = `<pre class="asset-detail-text">${esc(text || a.preview || '')}</pre>`;
  } else {
    body = `<div class="asset-detail-file">${esc(assetBadge(a))}</div>`;
  }
  const title = a.title || a.name || a.path || a.id;
  const overlay = document.createElement('div');
  overlay.className = 'asset-detail-backdrop';
  overlay.innerHTML = `
    <div class="asset-detail" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <button class="asset-detail-close" type="button" aria-label="Close">×</button>
      <h3>${esc(title)}</h3>
      <div class="asset-detail-body">${body}</div>
      <div class="asset-detail-meta">${metaRows([
        ['id', a.id],
        ['kind', a.kind],
        ['type', a.type || a.contentKind],
        ['format', a.format],
        ['size', a.size ? formatBytes(a.size) : ''],
        ['path', a.localPath || a.path],
        ['session', a.session_title || a.session_id],
        ['source', a.source],
        ['view', a.viewUrl],
        ['download', a.downloadUrl],
        ['reference', a.refText || a.composerText],
      ])}</div>
    </div>`;
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('.asset-detail-close').onclick = close;
  document.body.appendChild(overlay);
}

function render() {
  if (!host) return;
  if (!pid) { host.innerHTML = `<div class="kn-pane"><p class="kn-note">This session has no project, so there is no project knowledge to manage.</p></div>`; return; }
  if (!data) { host.innerHTML = `<div class="kn-pane"><p class="kn-note">Loading…</p></div>`; return; }
  const h = data.helpers || {};
  const ctx = data.ctx;
  const doc = ctx?.doc || '';
  const uploads = data.assets?.uploads || [];
  const visibleUploads = filteredUploads(uploads);
  const wikiAssets = data.assets?.wiki?.length ? data.assets.wiki : (data.pages || []).map((p) => ({
    id: `wiki:${p.path}`,
    kind: 'wiki',
    contentKind: 'text',
    path: p.path,
    title: p.title || p.path,
    source: p.source || '',
    size: p.bytes || 0,
    viewUrl: `api/project/${encodeURIComponent(pid)}/wiki/raw?path=${encodeURIComponent(p.path)}`,
    downloadUrl: `api/project/${encodeURIComponent(pid)}/wiki/raw?path=${encodeURIComponent(p.path)}&download=1`,
    refText: `[wiki:${p.path}] ${p.title || p.path}`,
    composerText: `[wiki:${p.path}] ${p.title || p.path}`,
  }));
  host.innerHTML = `
    <div class="kn-pane">
      <div class="kn-head">Project-level — applies to every session in <b>${esc(pname || pid)}</b>.</div>
      ${copyNotice ? `<div class="kn-copy-note">${esc(copyNotice)}</div>` : ''}

      <section class="kn-sec">
        <div class="kn-sec-head"><h3>Context</h3>
          <label class="kn-toggle"><input type="checkbox" id="kn-ctx-on" ${h.context_inject ? 'checked' : ''}> inject into launches</label>
        </div>
        <p class="kn-note">A shared CONTEXT.md (vocabulary + invariants) prepended to every launch in this project (as advisory data).</p>
        <textarea id="kn-ctx-doc" class="kn-doc" spellcheck="false" placeholder="(empty — Generate from the repo, or write it yourself)">${esc(doc)}</textarea>
        <div class="kn-row">
          <label class="kn-meta">model ${modelSelect('kn-ctx-model', data.models, h.context_model)}</label>
          <button class="btn sm" id="kn-ctx-gen">Generate from repo</button>
          <button class="btn sm" id="kn-ctx-save">Save</button>
        </div>
        <div class="kn-row"><span class="kn-meta">${ctx?.source ? esc(ctx.source) : 'not generated'}</span></div>
      </section>

      <section class="kn-sec">
        <div class="kn-sec-head"><h3>Files</h3><span class="kn-meta">${(() => { const t = (data.files || []).length; const v = filteredFiles(data.files).length; return filesFilterText.trim() ? `${v} of ${t}` : `${t}${data.filesTrunc ? '+' : ''}`; })()} in working tree</span></div>
        <p class="kn-note">Files the coding agent wrote or changed (newest first). Click to view; file paths in the terminal are also clickable.</p>
        ${(data.files || []).length ? `<input id="kn-files-filter" class="kn-files-search" type="search" placeholder="Filter by path…" value="${esc(filesFilterText)}" />` : ''}
        <ul class="kn-files">${filteredFiles(data.files).map(fileRow).join('') || `<li class="kn-note">${(data.files || []).length ? '(no files match the filter)' : '(nothing changed yet — files the agent writes show up here)'}</li>`}</ul>
      </section>

      <section class="kn-sec">
        <div class="kn-sec-head"><h3>Uploaded Files</h3><span class="kn-meta">${uploads.length} file${uploads.length === 1 ? '' : 's'}</span></div>
        <p class="kn-note">Files and pasted text/images uploaded in this project. Drag a card into the composer, or use Insert, to ask the coding agent about the same file id/path.</p>
        <div class="kn-file-filters">
          <input id="kn-file-filter" type="search" placeholder="Filter by name or path" value="${esc(uploadFilterText)}" />
          <select id="kn-file-type">${uploadTypeOptions(uploads)}</select>
        </div>
        <ul class="asset-cards">${assetRows(visibleUploads, uploads.length ? '(no matching files)' : '(no uploaded files yet)')}</ul>
      </section>

      <section class="kn-sec">
        <div class="kn-sec-head"><h3>Wiki</h3>
          <label class="kn-toggle"><input type="checkbox" id="kn-wiki-on" ${h.wiki_mcp ? 'checked' : ''}> serve to agents via MCP</label>
        </div>
        <p class="kn-note">A self-maintaining knowledge base (curated <code>docs/wiki/</code> + synthesized pages) agents query over MCP.</p>
        <ul class="asset-cards">${assetRows(wikiAssets, '(no pages yet — Rebuild, or they fall back to docs/wiki/)')}</ul>
        <div class="kn-row">
          <label class="kn-meta">model ${modelSelect('kn-wiki-model', data.models, h.wiki_model)}</label>
          <button class="btn sm" id="kn-wiki-rebuild">Rebuild pages</button>
        </div>
      </section>

      <section class="kn-sec">
        <div class="kn-sec-head"><h3>Lessons</h3>
          <label class="kn-toggle"><input type="checkbox" id="kn-les-on" ${h.lessons ? 'checked' : ''}> distil + serve</label>
        </div>
        <p class="kn-note">When a session closes, a cheap pass distils a failure-aware lesson from the diff + supervisor verdict. Only <b>verified, genuinely-new</b> ones (skill-fix, not adherence lapses) are served over MCP + injected at launch. <span class="kn-meta">active = served · candidate/adherence = held back (promote to serve).</span></p>
        <ul class="kn-lessons" style="list-style:none;padding:0;margin:0">${(data.lessons || []).map(lessonRow).join('') || '<li class="kn-note">(none yet — they appear as sessions in this project close)</li>'}</ul>
        <div class="kn-row"><label class="kn-meta">model ${modelSelect('kn-les-model', data.models, h.lessons_model)}</label></div>
      </section>

      <section class="kn-sec">
        <div class="kn-sec-head"><h3>Multi-session collaboration</h3>
          <label class="kn-toggle"><input type="checkbox" id="kn-iso-on" ${h.isolation ? 'checked' : ''}> isolate each session</label>
        </div>
        <p class="kn-note">Give every session on this project its own git <b>worktree + branch</b>, so concurrent agents never clobber each other's working tree; changes reach the live app by merging to main. <b>Off (default)</b> = sessions share one working tree and <b>you own merge/deploy</b> — leave it off if you have your own multi-session workflow. AIOS's autonomous integrate-&-deploy (when enabled) also requires this switch on.</p>
      </section>
    </div>`;
  wire();
}

function wire() {
  const ta = $('#kn-ctx-doc');
  if (ta) ta.oninput = () => { dirty = true; P.markDirty?.(); };
  const setHelper = (patch) => post(`api/project/${pid}/helpers`, patch).then((r) => { if (r?.helpers) data.helpers = r.helpers; });
  const onChg = (id, fn) => { const e = $('#' + id); if (e) e.onchange = fn; };
  const onClk = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
  onChg('kn-ctx-on', (e) => setHelper({ context_inject: e.target.checked }));
  onChg('kn-wiki-on', (e) => setHelper({ wiki_mcp: e.target.checked }));
  onChg('kn-ctx-model', (e) => setHelper({ context_model: e.target.value }));
  onChg('kn-wiki-model', (e) => setHelper({ wiki_model: e.target.value }));
  onChg('kn-les-on', (e) => setHelper({ lessons: e.target.checked }));
  onChg('kn-les-model', (e) => setHelper({ lessons_model: e.target.value }));
  onChg('kn-iso-on', (e) => setHelper({ isolation: e.target.checked })); // per-project multi-session master switch
  onChg('kn-file-type', (e) => { uploadFilterType = e.target.value || ''; render(); });
  const fileFilter = $('#kn-file-filter');
  if (fileFilter) fileFilter.oninput = (e) => updateUploadFilter(e.target.value);
  const filesFilter = $('#kn-files-filter');
  if (filesFilter) filesFilter.oninput = (e) => updateFilesFilter(e.target.value);
  const lesAct = async (lid, body, del) => {
    try {
      if (del) await api(`api/project/${pid}/lessons/${lid}`, { method: 'DELETE' });
      else await post(`api/project/${pid}/lessons/${lid}`, body);
      await load();
      render();
    } catch {}
  };
  host.querySelectorAll('[data-les-promote]').forEach((b) => (b.onclick = () => lesAct(b.dataset.lesPromote, { status: 'active' })));
  host.querySelectorAll('[data-les-demote]').forEach((b) => (b.onclick = () => lesAct(b.dataset.lesDemote, { status: 'demoted' })));
  host.querySelectorAll('[data-les-del]').forEach((b) => (b.onclick = () => lesAct(b.dataset.lesDel, null, true)));
  host.querySelectorAll('[data-copy-asset]').forEach((b) => (b.onclick = () => copyAsset(assetById(b.dataset.copyAsset))));
  host.querySelectorAll('[data-insert-asset]').forEach((b) => (b.onclick = () => insertAsset(assetById(b.dataset.insertAsset))));
  host.querySelectorAll('[data-open-asset]').forEach((b) => (b.onclick = () => openAssetDetail(assetById(b.dataset.openAsset))));
  // Files rows open in the session page's file viewer (same modal as terminal click-to-open).
  host.querySelectorAll('[data-open-file]').forEach((row) => (row.onclick = () => {
    window.dispatchEvent(new CustomEvent('aios:open-file', { detail: { path: row.dataset.openFile } }));
  }));
  host.querySelectorAll('[data-asset-id]').forEach((row) => {
    row.ondragstart = (e) => {
      const a = assetById(row.dataset.assetId);
      if (!a) return;
      const ref = a.composerText || a.refText || a.id;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-aios-reference', ref);
      e.dataTransfer.setData('text/plain', ref);
      if (a.viewUrl) e.dataTransfer.setData('text/uri-list', a.viewUrl);
    };
  });
  onClk('kn-ctx-save', async (e) => { const doc = $('#kn-ctx-doc')?.value || ''; e.target.disabled = true; try { await post(`api/project/${pid}/context`, { doc }); dirty = false; P.clearDirty?.(); await load(); render(); } catch { e.target.textContent = 'Save failed'; e.target.disabled = false; } });
  onClk('kn-ctx-gen', async (e) => { e.target.disabled = true; e.target.textContent = 'Generating…'; try { await post(`api/project/${pid}/context/generate`, {}); dirty = false; P.clearDirty?.(); await load(); render(); } catch { e.target.textContent = 'Generate failed'; e.target.disabled = false; } });
  onClk('kn-wiki-rebuild', async (e) => { e.target.disabled = true; e.target.textContent = 'Rebuilding…'; try { await post(`api/project/${pid}/wiki/rebuild`, {}); await load(); render(); } catch { e.target.textContent = 'Rebuild failed'; e.target.disabled = false; } });
}

export const panel = {
  async mount(el, papi) { P = papi; host = el; await load(); render(); },
  async update() { if (dirty || P?.isDirty?.()) return; await load(); render(); },
  unmount() { host = null; },
};
