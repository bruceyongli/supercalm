import { api, escapeHtml, isInteracting } from './common.js';

const esc = value => escapeHtml(String(value ?? ''));
export function formatDiskBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return '—';
  const n = Number(bytes);
  for (const [unit, scale] of [['TiB', 1024 ** 4], ['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024]])
    if (n >= scale) return `${(n / scale).toFixed(1)} ${unit}`;
  return `${Math.round(n)} B`;
}

export function mountHealthStorage(host) {
  let stopped = false, timer = null, capacityTimer = null, capacityBusy = false, busy = false, data = null, renderedAt = null, mode = 'disposable', project = '', shown = 30;
  const selected = new Set();
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  host.innerHTML = `<section class="health-section storage-section">
    <div class="storage-heading"><h2>Disk usage</h2><button data-storage-refresh>Refresh statistics</button></div>
    <div data-storage-overview>Reading disk capacity…</div>
    <details data-storage-projects><summary>Project usage</summary><div data-storage-project-table></div></details>
    <details><summary>Largest sessions (including protected running sessions)</summary><div data-storage-largest></div></details>
    <h3>Stopped-session cleanup</h3>
    <p class="health-meta">Nothing is deleted automatically. Running/recovering sessions and project source folders are protected. Saved outputs and uploads are kept unless explicitly selected.</p>
    <div class="storage-controls"><label>Project <select data-storage-project><option value="">All projects</option></select></label>
      <label>Action <select data-storage-mode><option value="disposable">Clean temp files & terminal logs</option>
        <option value="outputs">Also clean outputs, uploads & safe worktrees</option><option value="delete">Delete killed sessions & their AIOS files</option></select></label>
      <button data-storage-select>Select eligible (up to 100)</button><button data-storage-clean disabled>Clean selected (0)</button></div>
    <p data-storage-selection class="health-meta"></p>
    <div data-storage-list>Scanning session storage in the background…</div>
    <button data-storage-more hidden>Show more sessions</button>
    <p data-storage-result role="status"></p>
    <p class="health-meta">Native CLI histories are retained. Deleted SQLite records free reusable database pages, not immediate database file space. Allocated blocks are estimates; APFS clones may share physical storage.</p>
  </section>`;
  const overview = host.querySelector('[data-storage-overview]'), list = host.querySelector('[data-storage-list]');
  const clean = host.querySelector('[data-storage-clean]'), refresh = host.querySelector('[data-storage-refresh]');
  const result = host.querySelector('[data-storage-result]'), filter = host.querySelector('[data-storage-project]');
  const more = host.querySelector('[data-storage-more]');
  function allowed(s) { return s.cleanable && (mode !== 'delete' || s.deletable); }
  function updateButton() {
    clean.disabled = busy || !selected.size; clean.textContent = `Clean selected (${selected.size})`;
    const selectedRows = (data?.sessions || []).filter(s => selected.has(s.id));
    host.querySelector('[data-storage-selection]').textContent = !selectedRows.length ? '' : mode === 'disposable'
      ? `Selected temp/logs only: approximately ${formatDiskBytes(selectedRows.reduce((n, s) => n + s.disposable_bytes, 0))}. Total occupied is not the cleanup amount; outputs, worktrees and conversation records stay.`
      : 'Exact cleanup files and estimate are shown in the preview. Native CLI history and dirty/unmerged worktrees are retained.';
  }
  function renderList() {
    if (!data) return;
    const sessions = (data.sessions || []).filter(s => s.cleanable && (!project || s.project_id === project)
      && (mode === 'delete' || (mode === 'disposable' ? s.disposable_bytes : s.bytes) > 0));
    for (const id of selected) if (!(data.sessions || []).some(s => s.id === id && allowed(s))) selected.delete(id);
    list.innerHTML = sessions.length ? `<table class="health-table storage-table"><thead><tr><th>Select</th><th>Session</th><th>Total occupied</th><th>Temp/logs only</th><th>Saved outputs</th></tr></thead><tbody>${sessions.slice(0, shown).map(s => `<tr>
      <td><input type="checkbox" data-storage-session="${esc(s.id)}" aria-label="Select ${esc(s.title)}" ${selected.has(s.id) ? 'checked' : ''} ${allowed(s) ? '' : 'disabled'}></td>
      <td><a href="session?id=${encodeURIComponent(s.id)}">${esc(s.title)}</a><div class="health-meta">${esc(s.project)} · ${esc(s.reason)}${mode === 'delete' && !s.deletable ? ' · not deletable' : ''}</div>
        <details><summary class="health-meta">Storage details</summary>${(s.components || []).filter(c => c.exclusive_bytes || c.error).map(c => `<div class="storage-path"><b>${esc(c.label)} · ${formatDiskBytes(c.exclusive_bytes)}</b><div>${esc(c.path)}</div>${c.error ? `<span class="health-warn">${esc(c.error)}</span>` : ''}</div>`).join('')}</details></td>
      <td>${formatDiskBytes(s.bytes)}</td><td>${formatDiskBytes(s.disposable_bytes)}</td><td>${formatDiskBytes(s.output_bytes)}${s.worktree_bytes ? `<div class="health-meta">worktree ${formatDiskBytes(s.worktree_bytes)}</div>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : `<p class="health-meta">${data.state === 'scanning' ? 'Scanning in the background…' : 'No stopped sessions match this filter.'}</p>`;
    list.querySelectorAll('[data-storage-session]').forEach(input => input.addEventListener('change', () => {
      input.checked ? selected.add(input.dataset.storageSession) : selected.delete(input.dataset.storageSession); updateButton();
    }));
    more.hidden = sessions.length <= shown; updateButton();
  }
  function renderOverview() {
    const disk = data.capacity || {};
    const hasInventory = Number.isFinite(data.scanned_at);
    const db = data.database;
    overview.innerHTML = `<div class="storage-capacity"><b class="${disk.level === 'critical' ? 'health-warn' : disk.level === 'warning' ? 'health-info' : 'health-ok'}">${formatDiskBytes(disk.available_bytes)} available</b>
      <span>of ${formatDiskBytes(disk.total_bytes)} · ${esc(disk.level || 'unknown')}</span></div>
      <div class="health-meta">${data.state === 'scanning' ? `Scanning ${data.progress?.scanned || 0}/${data.progress?.total || 0} storage scopes…` : `Last measured ${data.scanned_at ? new Date(data.scanned_at).toLocaleString() : 'not yet'}`} · stopped-session temp/logs ${hasInventory ? formatDiskBytes(data.disposable_bytes) : 'measuring…'}${hasInventory && data.state === 'scanning' ? ' (previous scan)' : ''}</div>
      ${db && !db.error ? `<div class="health-meta">SQLite file ${formatDiskBytes(db.file_bytes)} · ${formatDiskBytes(db.reusable_bytes)} reusable inside the database, not free disk space${db.wal_bytes ? ` · WAL ${formatDiskBytes(db.wal_bytes)}` : ''}.</div>` : ''}
      ${disk.level === 'critical' ? '<p class="health-warn">New and resumed agents are blocked to preserve disk headroom. Existing agents are not killed.</p>' : ''}
      ${data.errors?.length ? `<p class="health-info">${data.errors.length} locations could not be measured; totals are incomplete.</p>` : ''}${data.error ? `<p class="health-warn">${esc(data.error)}</p>` : ''}`;
  }
  async function refreshCapacity() {
    if (stopped || capacityBusy) return;
    clearTimeout(capacityTimer); capacityBusy = true;
    try {
      if (busy || !data || document.hidden) return;
      const next = await api('api/product/storage/capacity');
      if (stopped || !data) return;
      if ((next.capacity?.checked_at || 0) >= (data.capacity?.checked_at || 0)) {
        data = { ...data, ...next }; renderOverview();
      }
    } catch { /* Inventory polling retains its explicit error/retry path. */ }
    finally { capacityBusy = false; if (!stopped) capacityTimer = setTimeout(refreshCapacity, 10_000); }
  }
  function render() {
    renderedAt = data.scanned_at;
    filter.innerHTML = `<option value="">All projects</option>${(data.projects || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}`;
    filter.value = project;
    host.querySelector('[data-storage-project-table]').innerHTML = `<table class="health-table"><thead><tr><th>Project</th><th>Source</th><th>Sessions</th><th>Stopped temp/logs</th></tr></thead><tbody>${(data.projects || []).map(p => `<tr><td><b>${esc(p.name)}</b><div class="storage-path health-meta">${esc(p.path)}</div><div class="health-meta">${p.session_count} sessions · ${p.stopped_count} stopped</div></td><td>${formatDiskBytes(p.source_bytes)}</td><td>${formatDiskBytes(p.session_bytes)}</td><td>${formatDiskBytes(p.disposable_bytes)}</td></tr>`).join('')}</tbody></table>
      <p class="health-meta">Shared/unattributed storage: ${(data.shared || []).filter(r => r.exclusive_bytes).map(r => `${esc(r.label)} ${formatDiskBytes(r.exclusive_bytes)}`).join(' · ') || 'measuring…'}</p>`;
    host.querySelector('[data-storage-largest]').innerHTML = (data.sessions || []).slice(0, 15).map(s =>
      `<div class="health-row"><a href="session?id=${encodeURIComponent(s.id)}">${esc(s.project)} · ${esc(s.title)}</a><span>${formatDiskBytes(s.bytes)} · ${esc(s.status)}${s.cleanable ? '' : ' · protected'}</span></div>`).join('');
    renderList();
  }
  async function load(force = false) {
    if (stopped || busy) return;
    clearTimeout(timer); refresh.disabled = true;
    try {
      const next = await api(`api/product/storage${force ? '?fresh=1' : ''}`);
      if (stopped) return;
      const changed = next.scanned_at !== renderedAt || !data;
      data = data?.capacity?.checked_at > next.capacity?.checked_at ? { ...next, capacity: data.capacity, database: data.database } : next;
      renderOverview();
      // Progress updates never replace the selectable list and erase focus/expanded details.
      if (changed && (!renderedAt || !isInteracting(host))) render();
    } catch (error) { if (!stopped) result.textContent = `Disk statistics failed: ${error.message}`; }
    finally { if (!stopped) { refresh.disabled = false; timer = setTimeout(() => load(), data?.state === 'scanning' ? 2000 : 60_000); } }
  }
  refresh.addEventListener('click', () => load(true));
  filter.addEventListener('change', () => { project = filter.value; shown = 30; renderList(); });
  host.querySelector('[data-storage-mode]').addEventListener('change', event => { mode = event.target.value; renderList(); });
  more.addEventListener('click', () => { shown += 30; renderList(); });
  host.querySelector('[data-storage-select]').addEventListener('click', () => {
    for (const s of (data?.sessions || []).filter(s => allowed(s) && (!project || s.project_id === project)
      && (mode === 'delete' || (mode === 'disposable' ? s.disposable_bytes : s.bytes) > 0))) {
      if (selected.size >= 100) break; selected.add(s.id);
    }
    renderList();
  });
  clean.addEventListener('click', async () => {
    if (busy || !selected.size) return;
    busy = true; clearTimeout(timer); updateButton(); result.textContent = 'Checking stopped state, paths and worktree safety…';
    let dialog;
    try {
      const plan = await post('api/product/storage/plan', { sessions: [...selected], mode });
      if (stopped) return;
      result.textContent = '';
      dialog = document.createElement('dialog'); dialog.className = 'storage-confirm';
      dialog.innerHTML = `<h2>Confirm ${plan.mode === 'delete' ? 'session deletion' : 'cleanup'}</h2><p>${plan.sessions.length} sessions · approximately ${formatDiskBytes(plan.estimated_bytes)}</p>
        <p>Kept: ${plan.preserved.map(esc).join(', ')}.</p><div class="storage-confirm-paths">${plan.sessions.map(s => `<details><summary>${esc(s.project)} · ${esc(s.title)}</summary>${s.targets.map(t => `<div class="storage-path">${esc(t.label)} · ${formatDiskBytes(t.bytes)}<br>${esc(t.path)}</div>`).join('')}${s.retained.map(esc).join('<br>')}</details>`).join('')}</div>
        <label><input type="checkbox" data-confirm-irreversible> I understand the selected files${plan.mode === 'delete' ? ' and AIOS conversation records' : ''} cannot be recovered by AIOS.</label>
        <div class="storage-confirm-actions"><button data-cancel>Cancel</button><button data-confirm disabled>Confirm cleanup</button></div>`;
      document.body.appendChild(dialog); dialog.showModal();
      const accepted = await new Promise(resolve => {
        dialog.querySelector('[data-confirm-irreversible]').addEventListener('change', event => { dialog.querySelector('[data-confirm]').disabled = !event.target.checked; });
        dialog.querySelector('[data-confirm]').addEventListener('click', () => resolve(true));
        dialog.querySelector('[data-cancel]').addEventListener('click', () => resolve(false));
        dialog.addEventListener('cancel', () => resolve(false), { once: true });
        dialog.addEventListener('close', () => resolve(false), { once: true });
      });
      dialog.remove(); dialog = null;
      if (!accepted || stopped) return;
      result.textContent = 'Cleaning the confirmed selection…';
      const outcome = await post('api/product/storage/cleanup', { plan_id: plan.id, confirm: true });
      if (stopped) return;
      const failed = outcome.results.filter(r => !r.ok);
      const change = outcome.net_available_change_bytes;
      const net = Number.isFinite(change) ? `Disk net change during cleanup: ${change >= 0 ? '+' : '−'}${formatDiskBytes(Math.abs(change))}; ${formatDiskBytes(outcome.capacity_after?.available_bytes)} available afterward. ` : '';
      result.textContent = `${outcome.results.length - failed.length} cleaned · estimated removed file blocks ${formatDiskBytes(outcome.estimated_bytes)}. ${net}${failed.map(r => `${r.id}: ${r.error}${r.partial ? ` (already removed: ${r.removed_paths.join(', ')})` : ''}`).join(' ')} ${outcome.note || ''}`;
      selected.clear(); data = null; renderedAt = null;
    } catch (error) { if (!stopped) result.textContent = `Cleanup not completed: ${error.message}`; }
    finally { dialog?.remove(); busy = false; if (!stopped) { updateButton(); load(); } }
  });
  const onVisible = () => { if (!document.hidden) refreshCapacity(); };
  window.addEventListener('focus', onVisible); document.addEventListener('visibilitychange', onVisible);
  capacityTimer = setTimeout(refreshCapacity, 10_000);
  load();
  return () => {
    stopped = true; clearTimeout(timer); clearTimeout(capacityTimer);
    window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible);
    document.querySelectorAll('.storage-confirm').forEach(dialog => { dialog.close(); dialog.remove(); });
  };
}
