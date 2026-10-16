// Read-only, bounded host accounting. No process environments, command lines or signals are exposed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, freemem, totalmem, loadavg, platform } from 'node:os';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const exec = promisify(execFile);
const MiB = 1024 ** 2;
async function command(file, args) {
  return (await exec(file, args, { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * MiB,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })).stdout;
}
export function memoryBytes(value) {
  const m = String(value || '').match(/^([\d.]+)([BKMGTP]?)/i);
  return m ? Number(m[1]) * 1024 ** Math.max(0, 'BKMGTP'.indexOf(m[2].toUpperCase() || 'B')) : null;
}
export function parseProcesses(text) {
  return String(text).split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) return [];
    const args = m[5];
    let name = /Google Chrome\.app\//.test(args) ? 'Google Chrome' : basename(args.split(/\s/)[0]).slice(0, 80);
    const module = /^python[\d.]*$/.test(name) && args.match(/\s-m\s+([a-zA-Z_][\w.]{0,100})(?=\s|$)/)?.[1];
    if (module) name += ` (${module})`;
    return [{ pid: +m[1], ppid: +m[2], cpu_percent: +m[3], rss_bytes: +m[4] * 1024, name, args }];
  });
}
export function parseFootprints(text) {
  const values = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+[BKMGTP]?[+-]?)\s*$/i);
    if (m) values.set(+m[1], memoryBytes(m[2]));
  }
  return values;
}
export function parseMacMemory(text) {
  const pressure = Number(String(text).match(/memorystatus_vm_pressure_level:\s*(\d+)/)?.[1]);
  const swap = String(text).match(/used\s*=\s*([\d.]+[BKMGTP])/i)?.[1];
  return { memory_pressure: ({ 1: 'normal', 2: 'warning', 4: 'critical' })[pressure] || 'unknown',
    swap_used_bytes: memoryBytes(swap) };
}
export function hostLevel(host) {
  if (host.memory_pressure === 'critical') return 'critical';
  if (host.memory_pressure === 'warning' || host.load_average?.[0] >= host.cores * 1.5 || host.cpu_busy_percent >= 95) return 'warning';
  return host.memory_pressure === 'unknown' ? 'unknown' : 'healthy';
}

// A pressure read is much cheaper than process accounting and is shared by concurrent launches.
export function createHostSampler({ run = command, osPlatform = platform(), clock = Date.now,
  cpuInfo = cpus, memoryTotal = totalmem, memoryFree = freemem, loads = loadavg,
  read = readFile, ttl = 10_000 } = {}) {
  let cached = null, flight = null, previous = null;
  async function sample() {
    if (cached && clock() - cached.checked_at < ttl) return cached;
    if (flight) return flight;
    flight = (async () => {
      const info = cpuInfo(), totals = info.reduce((sum, c) => {
        sum.idle += c.times.idle; sum.total += Object.values(c.times).reduce((a, b) => a + b, 0); return sum;
      }, { idle: 0, total: 0 });
      const delta = previous && totals.total - previous.total;
      const host = { cores: info.length || 1, total_memory_bytes: memoryTotal(), free_memory_bytes: memoryFree(),
        load_average: loads(), cpu_busy_percent: delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (totals.idle - previous.idle) / delta))) : null,
        memory_pressure: 'unknown', swap_used_bytes: null, checked_at: clock() };
      previous = totals;
      try {
        if (osPlatform === 'darwin') Object.assign(host, parseMacMemory(await run('/usr/sbin/sysctl', ['kern.memorystatus_vm_pressure_level', 'vm.swapusage'])));
        else if (osPlatform === 'linux') {
          const text = await read('/proc/meminfo', 'utf8');
          const kb = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
          const available = kb('MemAvailable');
          host.available_memory_bytes = Number.isFinite(available) ? available : null;
          host.swap_used_bytes = kb('SwapTotal') - kb('SwapFree');
          if (Number.isFinite(available)) host.memory_pressure = available < Math.min(256 * MiB, host.total_memory_bytes * .03)
            ? 'critical' : available < host.total_memory_bytes * .1 ? 'warning' : 'normal';
        }
      } catch { /* unavailable is unknown, never zero or permission to kill anything */ }
      host.level = hostLevel(host);
      cached = host; return host;
    })().finally(() => { flight = null; });
    return flight;
  }
  sample.peek = () => cached && clock() - cached.checked_at < ttl ? cached : null;
  return sample;
}
export const sampleHostResources = createHostSampler();
export function assertResourceHeadroom(host) {
  // Load and swap history alone are NOT evidence of current memory exhaustion.
  if (host?.memory_pressure !== 'critical') return;
  const error = new Error('Host memory pressure is critical. New sessions are temporarily blocked; open Health → CPU & memory to review active workloads. Existing sessions are not stopped.');
  error.code = 'host-memory-critical'; error.status = 503; throw error;
}

export function accountResources({ processes, sessions = [], projects = [], panes = '', services = '', footprints = new Map() }) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const byId = new Map(sessions.map(s => [s.id, s]));
  const projectNames = new Map(projects.map(p => [p.id, p.name]));
  const byTmux = new Map(sessions.filter(s => s.tmux).map(s => [s.tmux, s]));
  const roots = new Map(), serviceRoots = new Map();
  for (const line of panes.split('\n')) {
    const [name, pid] = line.trim().split('|');
    if (byTmux.has(name) && Number(pid) > 1) roots.set(+pid, byTmux.get(name));
  }
  for (const line of services.split('\n')) {
    const m = line.match(/^(\d+)\s+\S+\s+(\S+)$/);
    if (m && +m[1] > 1) serviceRoots.set(+m[1], m[2]);
  }
  const ancestors = p => {
    const chain = [], seen = new Set();
    while (p && p.pid > 1 && !seen.has(p.pid) && chain.length < 100) {
      seen.add(p.pid); chain.push(p); p = byPid.get(p.ppid);
    }
    return chain;
  };
  const groups = new Map();
  for (const process of processes) {
    if (process.pid <= 1) continue;
    const chain = ancestors(process);
    let session = chain.map(p => roots.get(p.pid)).find(Boolean), ownership = session ? 'pane' : null;
    const service = chain.map(p => serviceRoots.get(p.pid)).find(Boolean);
    // A daemon service is distinct from the session which once installed it. Otherwise use managed
    // storage/worktree provenance to recover detached jobs (and children lacking the path themselves).
    if (!session && !service) {
      for (const parent of chain) {
        const ids = [...parent.args.matchAll(/\/(?:session-storage|session-artifacts|worktrees\/[^/\s]+)\/(s_[a-zA-Z0-9_-]+)(?=\/|[\s'"]|$)/g)]
          .map(m => m[1]).filter(id => byId.has(id));
        if (new Set(ids).size === 1) { session = byId.get(ids[0]); ownership = 'managed-path'; break; }
      }
    }
    const root = chain.at(-1) || process;
    const key = session ? `session:${session.id}` : service ? `service:${service}` : `process:${root.pid}`;
    if (!groups.has(key)) groups.set(key, {
      id: key, kind: session ? 'session' : service ? 'service' : 'unattributed',
      session_id: session?.id || null, title: session?.title || service || root.name,
      project: session ? projectNames.get(session.project_id) || 'No project' : null,
      status: session?.status || null, cpu_percent: 0, rss_bytes: 0, footprint_bytes: 0,
      footprint_processes: 0, process_count: 0, detached_count: 0, processes: [],
    });
    const group = groups.get(key), footprint = footprints.get(process.pid) ?? null;
    group.cpu_percent += process.cpu_percent; group.rss_bytes += process.rss_bytes;
    group.process_count++; if (ownership === 'managed-path') group.detached_count++;
    if (footprint !== null) { group.footprint_bytes += footprint; group.footprint_processes++; }
    group.processes.push({ pid: process.pid, ppid: process.ppid, name: process.name, cpu_percent: process.cpu_percent,
      rss_bytes: process.rss_bytes, footprint_bytes: footprint, ownership: ownership || (service ? 'service' : 'unattributed') });
  }
  const rows = [...groups.values()];
  for (const row of rows) {
    row.cpu_percent = Math.round(row.cpu_percent * 10) / 10;
    if (!row.footprint_processes) row.footprint_bytes = null;
    row.processes.sort((a, b) => b.cpu_percent - a.cpu_percent || (b.footprint_bytes ?? b.rss_bytes) - (a.footprint_bytes ?? a.rss_bytes));
  }
  rows.sort((a, b) => b.cpu_percent - a.cpu_percent || (b.footprint_bytes ?? b.rss_bytes) - (a.footprint_bytes ?? a.rss_bytes));
  return rows;
}

export function createResourceInventory({ sessions = () => [], projects = () => [], run = command,
  sampleHost = sampleHostResources, osPlatform = platform(), clock = Date.now, ttl = 30_000, tmux = '/opt/homebrew/bin/tmux' } = {}) {
  let cache = null, flight = null, lastAttempt = -Infinity, failure = null;
  async function refresh() {
    if (flight) return flight;
    if (clock() - lastAttempt < ttl) return cache;
    lastAttempt = clock();
    flight = (async () => {
      const errors = [];
      const optional = (label, promise) => promise.catch(() => { errors.push(`${label} unavailable`); return ''; });
      // Bounded system commands; never walk /proc per process or spawn one lsof per session.
      const [host, ps, panes, services, top] = await Promise.all([
        sampleHost(), run('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,args=']),
        optional('Session ownership', run(tmux, ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'])),
        osPlatform === 'darwin' ? optional('Service ownership', run('/bin/launchctl', ['list'])) : '',
        osPlatform === 'darwin' ? optional('Memory footprint', run('/usr/bin/top', ['-l', '1', '-n', '10000', '-stats', 'pid,mem'])) : '',
      ]);
      const groups = accountResources({ processes: parseProcesses(ps), sessions: sessions(), projects: projects(), panes, services, footprints: parseFootprints(top) });
      cache = { checked_at: clock(), host, groups, errors }; failure = null; return cache;
    })().catch(() => { failure = 'Resource sampling failed; retaining the last successful sample.'; return cache; })
      .finally(() => { flight = null; });
    return flight;
  }
  return {
    get() {
      if (clock() - lastAttempt >= ttl) void refresh();
      return { ...cache, state: flight ? 'sampling' : cache ? 'ready' : 'unavailable',
        stale: !!cache && clock() - cache.checked_at > ttl * 2, error: failure };
    },
    refresh,
  };
}
