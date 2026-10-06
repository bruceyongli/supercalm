import { route, json, readJson } from './server.js';
import { VERSION, DATA_DIR } from './config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now } from './util.js';
import { listProjects, listSessions } from './store.js';
import { authStatus } from './authmode.js';
import { listProviders, status as providerStatus } from './auth/index.js';
import { projectGraphSummary } from './project_graph_core.js';
import { storageInventory, databaseStorage } from './disk_storage.js';
import { currentDiskCapacity } from './disk_pressure.js';
import { planStorageCleanup, executeStorageCleanup } from './disk_cleanup.js';
import { bus } from './bus.js';

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
    issues,
  });
});

route('GET', '/api/product/storage', (req, res, _params, url) => {
  json(res, 200, storageInventory.get({ refresh: url.searchParams.get('fresh') === '1' }));
});
// Cheap live capacity polling does not serialize the inventory or start a directory scan.
route('GET', '/api/product/storage/capacity', (req, res) => {
  json(res, 200, { capacity: currentDiskCapacity(), database: databaseStorage() });
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
