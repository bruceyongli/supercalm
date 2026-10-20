import { route, json, readJson } from './server.js';
import { VERSION, DATA_DIR, TMUX } from './config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now } from './util.js';
import { listProjects, listSessions, getSession, getProject } from './store.js';
import { authStatus } from './authmode.js';
import { listProviders, status as providerStatus } from './auth/index.js';
import { projectGraphSummary } from './project_graph_core.js';
import { storageInventory, databaseStorage, storageComponents, measureStoragePath } from './disk_storage.js';
import { archiveStorageSummary } from './artifact_archive.js';
import { currentDiskCapacity } from './disk_pressure.js';
import { planStorageCleanup, executeStorageCleanup } from './disk_cleanup.js';
import { bus } from './bus.js';
import { createResourceInventory } from './resource_usage.js';
import { createSessionDiskUsage, sessionResourceSummary } from './session_resource_summary.js';

const resources = createResourceInventory({ sessions: listSessions, projects: listProjects, tmux: TMUX, ttl: 15_000 });
const sessionDisks = createSessionDiskUsage({ measure: measureStoragePath });
function diskRows(sessions) {
  return sessionDisks.get(sessions.map(s => {
    const project = getProject(s.project_id);
    return { id: s.id, paths: storageComponents(s, project)
      .filter(c => c.kind !== 'worktree' || c.path !== project?.path).map(c => c.path) };
  }));
}
route('GET', '/api/product/resources', (req, res) => {
  const snapshot = resources.get();
  const sessions = (snapshot.groups || []).filter(g => g.session_id).map(g => getSession(g.session_id)).filter(Boolean);
  json(res, 200, { ...snapshot, capacity: currentDiskCapacity(), session_disk: diskRows(sessions) });
});
// Small, bounded projection for the rail: no process trees, project source scans or per-row requests.
route('GET', '/api/product/resources/sessions', (req, res, _params, url) => {
  const ids = [...new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean))];
  if (ids.length > 80 || ids.some(id => !/^s_[a-zA-Z0-9_-]+$/.test(id))) return json(res, 400, { error: 'Select up to 80 valid sessions' });
  const sessions = ids.map(id => getSession(id)).filter(Boolean), snapshot = resources.get();
  json(res, 200, { checked_at: snapshot.checked_at || null, state: snapshot.state,
    stale: !!snapshot.stale || !!snapshot.error, sessions: sessionResourceSummary(snapshot, sessions, diskRows(sessions)) });
});
let lastResourceAlert = 0;
async function monitorResources() {
  const snapshot = await resources.refresh();
  if (snapshot?.host?.level !== 'critical' || Date.now() - lastResourceAlert < 30 * 60_000) return;
  lastResourceAlert = Date.now();
  bus.emit('notify', { title: 'Supercalm: critical memory pressure',
    body: 'New session launches are blocked. Open Health → CPU, memory & disk to review workloads. Existing sessions are kept.',
    url: 'health', tag: 'memory-pressure' });
}
const resourceTimer = setInterval(monitorResources, 60_000);
resourceTimer.unref();
const firstResourceCheck = setTimeout(monitorResources, 8000);
firstResourceCheck.unref();

function withTimeout(label, promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

function sessionCounts(sessions) {
  return {
    total: sessions.length,
    live: sessions.filter((s) => s.status !== 'exited').length,
    waiting: sessions.filter((s) => s.status === 'waiting').length,
    working: sessions.filter((s) => s.status === 'working').length,
    exited: sessions.filter((s) => s.status === 'exited').length,
  };
}

async function authSnapshot() {
  const base = await withTimeout('auth', authStatus(), 5000);
  const providers = await withTimeout(
    'auth providers',
    // Health/Projects need the credential state, not a deep CLI subprocess probe. Antigravity's
    // `agy models` verification can take seconds and remains available on Auth and at launch time.
    Promise.all(listProviders().map(async (p) => ({ ...p, ...(await providerStatus(p.id, { includeExtra: false })) }))),
    6000
  );
  return {
    mode: base.mode || 'unknown',
    proxyUp: !!base.proxyUp,
    proxyUrl: base.proxyUrl || '',
    providers: providers.map((p) => ({
      id: p.id,
      label: p.label,
      loggedIn: !!p.loggedIn,
      proxyLoggedIn: p.proxyLoggedIn,
      cliLoggedIn: p.cliLoggedIn,
      expiresInSec: p.expiresInSec ?? null,
      account: p.account || null,
    })),
  };
}

const GRAPH_SNAPSHOT_CACHE_MS = Math.max(1000, Number(process.env.AIOS_GRAPH_SNAPSHOT_CACHE_MS || 15000));
let graphSnapshotCache = null;
let graphSnapshotFlight = null;

async function graphSnapshots(projects, { force = false } = {}) {
  const key = projects.map((p) => `${p.id}:${p.path}`).join('\n');
  if (!force && graphSnapshotCache?.key === key && now() - graphSnapshotCache.at < GRAPH_SNAPSHOT_CACHE_MS) {
    return graphSnapshotCache.rows;
  }
  if (graphSnapshotFlight?.key === key) return graphSnapshotFlight.promise;
  const promise = Promise.all(projects.map(async (p) => {
    try {
      const s = await projectGraphSummary(p);
      return {
        project_id: p.id,
        name: p.name,
        path: p.path,
        lifecycle: p.lifecycle || 'persistent',
        owner_session_id: p.owner_session_id || null,
        auto_delete_folder: !!p.auto_delete_folder,
        ok: !!s.ok,
        status: s.meta?.status || 'missing',
        stale: !!s.staleness?.stale,
        stale_reasons: s.staleness?.reasons || [],
        indexed_at: s.meta?.indexed_at || null,
        indexed_head: s.meta?.indexed_head || null,
        counts: s.counts || {},
      };
    } catch (e) {
      return { project_id: p.id, name: p.name, path: p.path, lifecycle: p.lifecycle || 'persistent', owner_session_id: p.owner_session_id || null, auto_delete_folder: !!p.auto_delete_folder, ok: false, status: 'error', stale: true, stale_reasons: [String(e.message || e).slice(0, 120)], counts: {} };
    }
  })).then((rows) => {
    rows.sort((a, b) => Number(b.name === 'aios') - Number(a.name === 'aios') || a.name.localeCompare(b.name));
    graphSnapshotCache = { key, at: now(), rows };
    return rows;
  });
  graphSnapshotFlight = { key, promise };
  try { return await promise; }
  finally { if (graphSnapshotFlight?.promise === promise) graphSnapshotFlight = null; }
}

function issueList({ auth, graphs }) {
  const issues = [];
  if (!auth) issues.push({ severity: 'warn', area: 'auth', message: 'auth status unavailable' });
  else {
    if (auth.mode === 'proxy' && !auth.proxyUp) issues.push({ severity: 'warn', area: 'auth', message: 'proxy mode selected but proxy is not reachable' });
    for (const p of auth.providers || []) {
      const agyPartial = p.id === 'antigravity' && (p.proxyLoggedIn || p.cliLoggedIn);
      if (!p.loggedIn && !agyPartial) issues.push({ severity: 'warn', area: 'auth', message: `${p.label || p.id} is not logged in` });
    }
  }
  const aiosGraph = (graphs || []).find((g) => g.name === 'aios');
  if (!aiosGraph) issues.push({ severity: 'info', area: 'graph', message: 'Supercalm project graph is not available' });
  else if (!aiosGraph.ok) issues.push({ severity: 'warn', area: 'graph', message: 'Supercalm project graph is not indexed' });
  else if (aiosGraph.stale) issues.push({ severity: 'info', area: 'graph', message: `Supercalm project graph is stale: ${aiosGraph.stale_reasons.join(', ')}` });
  return issues;
}

route('GET', '/api/product/health', async (req, res, _params, url) => {
  const projects = listProjects();
  const sessions = listSessions();
  const [authResult, graphs] = await Promise.all([
    authSnapshot().catch((e) => ({ error: String(e.message || e) })),
    graphSnapshots(projects, { force: url.searchParams.get('fresh') === '1' }),
  ]);
  const auth = authResult?.error ? null : authResult;
  const issues = issueList({ auth, graphs });
  const disk = currentDiskCapacity();
  const resource = resources.get();
  if (resource.host && !resource.stale && ['warning', 'critical'].includes(resource.host.level)) {
    issues.push({ severity: resource.host.level === 'critical' ? 'warn' : 'info', area: 'resources',
      message: `Host load ${resource.host.load_average[0].toFixed(1)} on ${resource.host.cores} cores; memory pressure ${resource.host.memory_pressure}. ${resource.host.level === 'critical' ? 'New session launches are blocked.' : 'Review CPU & memory before starting heavy work.'}` });
  }
  if (disk.level === 'warning' || disk.level === 'critical') issues.push({ severity: disk.level === 'critical' ? 'warn' : 'info',
    area: 'disk', message: `${(disk.available_bytes / 1024 ** 3).toFixed(1)} GiB available${disk.level === 'critical' ? ' — new agents are blocked until space is freed' : ' — review stopped-session cleanup'}` });
  json(res, 200, {
    ok: issues.every((i) => i.severity !== 'warn'),
    version: VERSION,
    time: now(),
    uptime_sec: Math.round(process.uptime()),
    sessions: sessionCounts(sessions),
    projects: { total: projects.length },
    auth,
    auth_error: authResult?.error || null,
    graphs,
    disk,
    resources: { checked_at: resource.checked_at || null, stale: resource.stale, host: resource.host || null },
    issues,
  });
});

route('GET', '/api/product/storage', async (req, res, _params, url) => {
  json(res, 200, { ...storageInventory.get({ refresh: url.searchParams.get('fresh') === '1' }),
    remote_storage: await archiveStorageSummary().catch(() => ({ error: 'Archive index unavailable' })) });
});
// Cheap live capacity polling does not serialize the inventory or start a directory scan.
route('GET', '/api/product/storage/capacity', async (req, res) => {
  json(res, 200, { capacity: currentDiskCapacity(), database: databaseStorage(),
    remote_storage: await archiveStorageSummary().catch(() => ({ error: 'Archive index unavailable' })) });
});
route('POST', '/api/product/storage/plan', async (req, res) => {
  try { const body = await readJson(req); json(res, 200, await planStorageCleanup(body.sessions, body.mode)); }
  catch (error) { json(res, error.status || 400, { error: String(error.message || error), code: error.code }); }
});
route('POST', '/api/product/storage/cleanup', async (req, res) => {
  try { const body = await readJson(req); json(res, 200, await executeStorageCleanup(body.plan_id, body.confirm === true)); }
  catch (error) { json(res, error.status || 400, { error: String(error.message || error), code: error.code }); }
});

let pressureLevel = 'healthy', lastPressureNotify = 0;
const pressureStatePath = join(DATA_DIR, 'disk-pressure-alert.json');
try {
  const saved = JSON.parse(readFileSync(pressureStatePath, 'utf8'));
  if (['warning', 'critical'].includes(saved.level) && Number.isFinite(saved.at) && saved.at <= Date.now()) {
    pressureLevel = saved.level; lastPressureNotify = saved.at;
  }
} catch {}
function monitorDisk() {
  const disk = currentDiskCapacity();
  if (disk.level === 'healthy') return;
  if (disk.level === 'unknown') return;
  if ((disk.level === 'critical' && pressureLevel !== 'critical') || Date.now() - lastPressureNotify > 6 * 60 * 60_000) {
    pressureLevel = disk.level; lastPressureNotify = Date.now();
    try { writeFileSync(pressureStatePath, JSON.stringify({ level: pressureLevel, at: lastPressureNotify }) + '\n', { mode: 0o600 }); } catch {}
    bus.emit('notify', { title: disk.level === 'critical' ? 'Supercalm: disk critically low' : 'Supercalm: disk space warning',
      body: `${(disk.available_bytes / 1024 ** 3).toFixed(1)} GiB available. Open Health to review and clean stopped sessions.`,
      url: 'health', tag: 'disk-pressure' });
    bus.emit('event', { type: 'disk-pressure', disk });
  }
}
const diskMonitorTimer = setInterval(monitorDisk, 60_000);
diskMonitorTimer.unref();
// Allow the ordinary push module to subscribe before the first low-space alert.
const firstDiskCheck = setTimeout(monitorDisk, 5000);
firstDiskCheck.unref();

console.log('[aios] product health api active');
