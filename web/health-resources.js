import { api, escapeHtml } from './common.js';
import { formatDiskBytes } from './health-storage.js';

const esc = value => escapeHtml(String(value ?? ''));
const pct = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : 'measuring…';
const bytes = value => value == null ? 'unknown' : formatDiskBytes(value);
const memory = row => row.footprint_bytes == null ? `${formatDiskBytes(row.rss_bytes)} RSS` : `${formatDiskBytes(row.footprint_bytes)} footprint`;

export function resourceTable(groups = []) {
  if (!groups.length) return '<p class="health-meta">No processes attributed in this sample.</p>';
  return `<table class="health-table resource-table"><thead><tr><th>Workload</th><th>CPU</th><th>Memory</th></tr></thead><tbody>${groups.map(g => `<tr>
    <td>${g.session_id ? `<a href="session?id=${encodeURIComponent(g.session_id)}">${esc(g.project)} · ${esc(g.title)}</a>` : `<b>${esc(g.title)}</b>`}
      <div class="health-meta">${esc(g.status || (g.kind === 'service' ? 'Host service' : 'Not assigned to a session'))} · ${g.process_count} processes${g.detached_count ? ` · ${g.detached_count} detached (managed-path evidence)` : ''}</div>
      <details data-resource-group="${esc(g.id)}"><summary>Process details</summary>${g.processes.map(p => `<div class="health-meta">PID ${p.pid} · ${esc(p.name)} · ${pct(p.cpu_percent)} · ${memory(p)}${p.ownership === 'managed-path' ? ' · detached' : ''}</div>`).join('')}</details></td>
    <td>${pct(g.cpu_percent)}</td><td>${memory(g)}${g.footprint_processes && g.footprint_processes !== g.process_count ? '<div class="health-meta">Partial footprint sample</div>' : ''}</td>
  </tr>`).join('')}</tbody></table>`;
}

export function mountHealthResources(host) {
  let stopped = false, busy = false, timer, renderedAt;
  host.innerHTML = `<section class="health-section storage-section resource-section">
    <div class="storage-heading"><h2>CPU & memory</h2><button data-resource-refresh>Refresh statistics</button></div>
    <p data-resource-status role="status">Measuring host and session resources…</p>
    <div data-resource-overview></div>
    <p class="health-meta">CPU: 100% = one core. macOS footprint includes compressed memory; RSS does not. Process totals can share memory and are not physical RAM totals. Samples are shared and cached for 30 seconds.</p>
    <h3>Sessions</h3><div data-resource-sessions></div>
    <details data-resource-services><summary>Host services & other processes</summary><div data-resource-other></div></details>
    <p class="health-meta">New sessions are blocked only at critical memory pressure. Existing sessions, recovery and host services are not stopped automatically. Session links open their normal controls. Detached jobs may need separate cleanup; ownership here is diagnostic, not permission to kill.</p>
  </section>`;
  const status = host.querySelector('[data-resource-status]'), refresh = host.querySelector('[data-resource-refresh]');
  async function load() {
    if (stopped || busy) return;
    clearTimeout(timer); busy = true; refresh.disabled = true;
    let delay = 30_000;
    try {
      const data = await api('api/product/resources');
      if (stopped) return;
      if (data.state === 'sampling') delay = 2000;
      status.textContent = `${data.checked_at ? `Measured ${new Date(data.checked_at).toLocaleTimeString()}` : 'Waiting for a resource sample'}${data.stale ? ' · stale' : ''}${data.state === 'sampling' ? ' · refreshing' : ''}${data.error ? ` · ${data.error}` : ''}${data.errors?.length ? ` · ${data.errors.join('; ')}` : ''}`;
      if (data.checked_at && renderedAt !== data.checked_at) {
        renderedAt = data.checked_at;
        const open = new Set([...host.querySelectorAll('[data-resource-group][open]')].map(d => d.dataset.resourceGroup));
        const h = data.host;
        host.querySelector('[data-resource-overview]').innerHTML = `<div class="storage-capacity"><b class="${h.level === 'critical' ? 'health-warn' : h.level === 'warning' ? 'health-info' : ''}">${esc(h.level)} · ${pct(h.cpu_busy_percent)} host CPU</b>
          <span>${h.cores} cores · load ${h.load_average.map(n => n.toFixed(1)).join(' / ')}</span></div>
          <div class="health-meta">RAM ${bytes(h.total_memory_bytes)} · memory pressure ${esc(h.memory_pressure)} · swap ${bytes(h.swap_used_bytes)}</div>`;
        host.querySelector('[data-resource-sessions]').innerHTML = resourceTable((data.groups || []).filter(g => g.kind === 'session'));
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
