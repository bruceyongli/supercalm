import { route, json } from './server.js';
import { VERSION } from './config.js';
import { now } from './util.js';
import { listProjects, listSessions } from './store.js';
import { authStatus } from './authmode.js';
import { listProviders, status as providerStatus } from './auth/index.js';
import { projectGraphSummary } from './project_graph_core.js';

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
    Promise.all(listProviders().map(async (p) => ({ ...p, ...(await providerStatus(p.id)) }))),
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

async function graphSnapshots(projects) {
  const rows = await Promise.all(projects.map(async (p) => {
    try {
      const s = await projectGraphSummary(p);
      return {
        project_id: p.id,
        name: p.name,
        path: p.path,
        ok: !!s.ok,
        status: s.meta?.status || 'missing',
        stale: !!s.staleness?.stale,
        stale_reasons: s.staleness?.reasons || [],
        indexed_at: s.meta?.indexed_at || null,
        indexed_head: s.meta?.indexed_head || null,
        counts: s.counts || {},
      };
    } catch (e) {
      return { project_id: p.id, name: p.name, path: p.path, ok: false, status: 'error', stale: true, stale_reasons: [String(e.message || e).slice(0, 120)], counts: {} };
    }
  }));
  return rows.sort((a, b) => Number(b.name === 'aios') - Number(a.name === 'aios') || a.name.localeCompare(b.name));
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

route('GET', '/api/product/health', async (req, res) => {
  const projects = listProjects();
  const sessions = listSessions();
  const [authResult, graphs] = await Promise.all([
    authSnapshot().catch((e) => ({ error: String(e.message || e) })),
    graphSnapshots(projects),
  ]);
  const auth = authResult?.error ? null : authResult;
  const issues = issueList({ auth, graphs });
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
    issues,
  });
});

console.log('[aios] product health api active');
