import { api } from './common.js';

const metrics = [['cpu', 'CPU'], ['memory', 'RAM'], ['disk', 'Disk']];
export function resourceLineHtml() {
  return `<span class="dk-sess-res" aria-label="Resource usage not yet measured">${metrics.map(([key, label]) =>
    `<span class="dk-res-metric" data-resource="${key}"><span class="dk-res-label">${label}</span><span class="dk-res-value">—</span></span>`).join('')}</span>`;
}
export function compactBytes(value) {
  if (!Number.isFinite(value)) return '—';
  for (const [label, scale] of [['T', 1024 ** 4], ['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]]) {
    if (value >= scale) return `${value / scale < 10 ? (value / scale).toFixed(1).replace(/\.0$/, '') : Math.round(value / scale)}${label}`;
  }
  return `${Math.round(value)}B`;
}
const cpuText = n => !Number.isFinite(n) ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k%` : `${n < 10 ? +n.toFixed(1) : Math.round(n)}%`;
const age = (at, now) => at ? `${Math.max(0, Math.floor((now - at) / 1000))}s ago` : 'not yet measured';

export function updateResourceLine(line, row, { now = Date.now(), unavailable = false } = {}) {
  if (!line) return;
  const stale = unavailable || !!row?.stale || (!!row?.checked_at && now - row.checked_at > 45_000);
  const diskStale = unavailable || !!row?.disk_stale || (!!row?.disk_checked_at && now - row.disk_checked_at > 120_000);
  const values = { cpu: cpuText(row?.cpu_percent), memory: compactBytes(row?.memory_bytes), disk: compactBytes(row?.disk_bytes) };
  const descriptions = {
    cpu: `CPU ${values.cpu}; 100% = one core; ${age(row?.checked_at, now)}${stale ? '; stale' : ''}`,
    memory: `Memory ${values.memory} (${row?.memory_kind === 'footprint' ? 'macOS footprint, including compressed memory' : 'resident memory / RSS'}${row?.memory_partial ? '; partial sample' : ''}); ${age(row?.checked_at, now)}${stale ? '; stale' : ''}`,
    disk: `Disk ${values.disk}; session logs, temp files, outputs, uploads, worktree and bound native history; shared project source excluded. Binary K/M/G/T units. ${age(row?.disk_checked_at, now)}${row?.disk_pending ? '; measuring in background' : ''}${diskStale ? '; stale' : ''}${row?.disk_error ? '; measurement incomplete' : ''}`,
  };
  for (const [key] of metrics) {
    const metric = line.querySelector(`[data-resource="${key}"]`), value = metric?.querySelector('.dk-res-value');
    if (!value) continue;
    if (value.textContent !== values[key]) value.textContent = values[key];
    metric.title = descriptions[key];
    metric.classList.toggle('is-stale', key === 'disk' ? diskStale : stale);
  }
  line.setAttribute('aria-label', Object.values(descriptions).join('. '));
}

// One request for visible rail rows, independent of the session-status render loop. Resource ticks
// only patch value spans: no row replacement/reordering, pulse restarts, or change to attention state.
export function mountSessionResources(container, { request = api, interval = 15_000 } = {}) {
  const cache = new Map();
  let stopped = false, suspended = false, busy = false, timer, soon, lastRequest = 0, unavailable = false;
  const visible = el => {
    const rect = el.getBoundingClientRect();
    return !document.hidden && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
      && rect.right > 0 && rect.left < innerWidth && !el.closest('details:not([open])');
  };
  const rows = () => [...container.querySelectorAll('[data-dk-sess]')].filter(visible).slice(0, 80);
  function paint() {
    for (const el of container.querySelectorAll('[data-dk-sess]')) {
      updateResourceLine(el.querySelector('.dk-sess-res'), cache.get(el.dataset.sid), { unavailable });
    }
  }
  async function poll() {
    if (stopped || suspended || busy) return;
    clearTimeout(timer);
    const shown = rows();
    if (!shown.length) { timer = setTimeout(poll, interval); return; }
    busy = true; lastRequest = Date.now();
    let delay = interval;
    try {
      const data = await request(`api/product/resources/sessions?ids=${encodeURIComponent(shown.map(el => el.dataset.sid).join(','))}`);
      if (stopped) return;
      unavailable = !!data.stale;
      for (const row of data.sessions || []) cache.set(row.id, row);
      // Bound retained metadata when visiting many sessions in a long-lived SPA.
      while (cache.size > 256) cache.delete(cache.keys().next().value);
      paint();
      if (data.state === 'sampling') delay = 2000;
      else if (data.sessions?.some(s => s.disk_pending && s.disk_bytes == null)) delay = 5000;
    } catch { if (!stopped) { unavailable = true; paint(); } }
    finally { busy = false; if (!stopped && !suspended) timer = setTimeout(poll, delay); }
  }
  function refresh() {
    if (stopped || suspended) return;
    paint(); clearTimeout(soon);
    soon = setTimeout(() => {
      if (rows().some(el => !cache.has(el.dataset.sid)) || Date.now() - lastRequest >= interval) void poll();
    }, 200);
  }
  const side = container.closest('.dk-side');
  const onHide = () => { suspended = true; clearTimeout(timer); clearTimeout(soon); };
  const onShow = () => { suspended = false; refresh(); };
  side?.addEventListener('scroll', refresh, { passive: true });
  container.addEventListener('toggle', refresh, true);
  window.addEventListener('resize', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('pagehide', onHide);
  const bodyObserver = new MutationObserver(refresh);
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  refresh();
  return { refresh, stop() {
    stopped = true; clearTimeout(timer); clearTimeout(soon); bodyObserver.disconnect();
    side?.removeEventListener('scroll', refresh); container.removeEventListener('toggle', refresh, true);
    window.removeEventListener('resize', refresh); document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', onShow);
    window.removeEventListener('pagehide', onHide);
  } };
}
