import { api, escapeHtml } from './common.js';
import { formatDiskBytes } from './health-storage.js';

const esc = value => escapeHtml(String(value ?? ''));
const pct = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : 'measuring…';
const bytes = value => value == null ? 'unknown' : formatDiskBytes(value);
const memory = row => row.footprint_bytes == null ? `${formatDiskBytes(row.rss_bytes)} RSS` : `${formatDiskBytes(row.footprint_bytes)} footprint`;

export function resourceTable(groups = [], disks = null) {
  if (!groups.length) return '<p class="health-meta">No processes attributed in this sample.</p>';
  const byId = new Map((disks || []).map(d => [d.id, d]));
  const diskCell = g => {
    const d = byId.get(g.session_id);
    return `<td title="Session-owned allocated blocks; shared project source excluded${d?.disk_checked_at ? `; measured ${esc(new Date(d.disk_checked_at).toLocaleTimeString())}` : ''}">${bytes(d?.disk_bytes)}${d?.disk_stale ? '<div class="health-meta">stale</div>' : d?.disk_pending ? '<div class="health-meta">updating…</div>' : ''}</td>`;
  };
  return `<table class="health-table resource-table${disks ? ' resource-with-disk' : ''}"><thead><tr><th>Workload</th><th>CPU</th><th>Memory</th>${disks ? '<th>Disk</th>' : ''}</tr></thead><tbody>${groups.map(g => `<tr>
    <td>${g.session_id ? `<a href="session?id=${encodeURIComponent(g.session_id)}">${esc(g.project)} · ${esc(g.title)}</a>` : `<b>${esc(g.title)}</b>`}
      <div class="health-meta">${esc(g.status || (g.kind === 'service' ? 'Host service' : 'Not assigned to a session'))} · ${g.process_count} processes${g.detached_count ? ` · ${g.detached_count} detached (managed-path evidence)` : ''}</div>
      <details data-resource-group="${esc(g.id)}"><summary>Process details</summary>${g.processes.map(p => `<div class="health-meta">PID ${p.pid} · ${esc(p.name)} · ${pct(p.cpu_percent)} · ${memory(p)}${p.ownership === 'managed-path' ? ' · detached' : ''}</div>`).join('')}</details></td>
    <td>${pct(g.cpu_percent)}</td><td>${memory(g)}${g.footprint_processes && g.footprint_processes !== g.process_count ? '<div class="health-meta">Partial footprint sample</div>' : ''}</td>${disks ? diskCell(g) : ''}
  </tr>`).join('')}</tbody></table>`;
}

export function mountHealthResources(host) {
  let stopped = false, busy = false, timer, renderedAt;
  host.innerHTML = `<section class="health-section storage-section resource-section">
    <div class="storage-heading"><h2>CPU, memory & disk</h2><button data-resource-refresh>Refresh statistics</button></div>
    <p data-resource-status role="status">Measuring host and session resources…</p>
    <div data-resource-overview></div>
    <div data-resource-disk></div>
    <p class="health-meta">CPU: 100% = one core. macOS footprint includes compressed memory; RSS does not. Process totals can share memory and are not physical RAM totals. CPU/memory refresh about every 15 seconds; session disk sizes are measured in the background, at most once a minute.</p>
    <h3>Sessions</h3><div data-resource-sessions></div>
    <details data-resource-services><summary>Host services & other processes</summary><div data-resource-other></div></details>
    <p class="health-meta">New sessions are blocked only at critical memory pressure. Existing sessions, recovery and host services are not stopped automatically. Session links open their normal controls. Detached jobs may need separate cleanup; ownership here is diagnostic, not permission to kill.</p>
  </section>`;
  const status = host.querySelector('[data-resource-status]'), refresh = host.querySelector('[data-resource-refresh]');
  async function load() {
    if (stopped || busy) return;
    clearTimeout(timer); busy = true; refresh.disabled = true;
    let delay = 15_000;
    try {
      const data = await api('api/product/resources');
      if (stopped) return;
      if (data.state === 'sampling') delay = 2000;
      else if (data.session_disk?.some(d => d.disk_pending && d.disk_bytes == null)) delay = 5000;
      status.textContent = `${data.checked_at ? `Measured ${new Date(data.checked_at).toLocaleTimeString()}` : 'Waiting for a resource sample'}${data.stale ? ' · stale' : ''}${data.state === 'sampling' ? ' · refreshing' : ''}${data.error ? ` · ${data.error}` : ''}${data.errors?.length ? ` · ${data.errors.join('; ')}` : ''}`;
      const capacity = data.capacity;
      if (capacity) {
        const percent = capacity.total_bytes > 0 ? Math.max(0, Math.min(100, (1 - capacity.available_bytes / capacity.total_bytes) * 100)) : null;
        host.querySelector('[data-resource-disk]').innerHTML = `<div class="resource-disk-head"><b>Host disk</b><span>${bytes(capacity.available_bytes)} available / ${bytes(capacity.total_bytes)}</span></div>
          ${percent != null ? `<meter class="resource-disk-meter" min="0" max="100" low="80" high="90" optimum="0" value="${percent}" aria-label="Host disk capacity occupied">${percent.toFixed(0)}%</meter>` : ''}
          <div class="health-meta">${percent == null ? 'Capacity unavailable' : `${percent.toFixed(0)}% used / reserved`} · <a href="#health-storage">Project usage & cleanup ↓</a></div>`;
      }
      const signature = `${data.checked_at}:${JSON.stringify(data.session_disk || [])}`;
      if (data.checked_at && renderedAt !== signature) {
        renderedAt = signature;
        const open = new Set([...host.querySelectorAll('[data-resource-group][open]')].map(d => d.dataset.resourceGroup));
        const h = data.host;
        host.querySelector('[data-resource-overview]').innerHTML = `<div class="storage-capacity"><b class="${h.level === 'critical' ? 'health-warn' : h.level === 'warning' ? 'health-info' : ''}">${esc(h.level)} · ${pct(h.cpu_busy_percent)} host CPU</b>
          <span>${h.cores} cores · load ${h.load_average.map(n => n.toFixed(1)).join(' / ')}</span></div>
          <div class="health-meta">RAM ${bytes(h.total_memory_bytes)} · memory pressure ${esc(h.memory_pressure)} · swap ${bytes(h.swap_used_bytes)}</div>`;
        host.querySelector('[data-resource-sessions]').innerHTML = resourceTable((data.groups || []).filter(g => g.kind === 'session'), data.session_disk || []);
        host.querySelector('[data-resource-other]').innerHTML = resourceTable((data.groups || []).filter(g => g.kind !== 'session'));
        for (const detail of host.querySelectorAll('[data-resource-group]')) detail.open = open.has(detail.dataset.resourceGroup);
      }
    } catch (error) { if (!stopped) status.textContent = `Resource statistics unavailable: ${error.message}. Previous sample retained.`; }
    finally {
      busy = false;
      if (!stopped) { refresh.disabled = false; timer = setTimeout(() => { if (!document.hidden) load(); }, delay); }
    }
  }
  const onVisible = () => { if (!document.hidden) load(); };
  refresh.addEventListener('click', load);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  load();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
}
