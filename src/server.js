import http from 'node:http';
import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PORT, HOST, WEB_DIR, VERSION, TOOLS, TOOL_IDS, DEFAULT_AUTONOMY, AUTONOMY_LEVELS } from './config.js';
import { bus } from './bus.js';
import * as store from './store.js';
import { now, id } from './util.js';
import { modelDisplayLabel, modelSupportsFast } from './model_catalog.js';
import { flags, setFlags, flagLocks, FLAG_KEYS, FLAG_DEFS } from './flags.js';
import { confinedPath } from './static_path.js';
import { tierOf, queueTier, QUEUE_TIER_ORDER } from './agents/supervisor/engagement.js';

// Resilience: an "OS" daemon must not die from one stray error. Log and keep running.
process.on('unhandledRejection', (e) => console.error('[aios] unhandledRejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[aios] uncaughtException:', e?.stack || e));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.error('[aios] received', sig); process.exit(0); });
process.on('SIGHUP', () => console.error('[aios] received SIGHUP (ignored)'));

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const gzipAsync = promisify(gzipCb);
// Compress sizeable text responses when the client accepts it. Matters a lot on relayed
// tailnet links (DERP): /api/state is ~67KB raw vs ~8KB gzipped, xterm.js 283KB vs ~70KB.
// res.req is the native back-reference, so json()'s signature stays (res, code, obj).
const GZIP_MIN = 1024;
function acceptsGzip(res) {
  return /\bgzip\b/.test(res.req?.headers?.['accept-encoding'] || '');
}
export function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}
function sendCompressed(res, code, body, headers) {
  if (typeof body === 'string') body = Buffer.from(body);
  if (body.length < GZIP_MIN || !acceptsGzip(res)) return send(res, code, body, headers);
  gzipAsync(body).then(
    (zipped) => send(res, code, zipped, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' }),
    () => send(res, code, body, headers) // compression failure -> plain
  );
}
export function json(res, code, obj) {
  sendCompressed(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
}
export function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const routes = [];
export function route(method, path, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' +
      path.replace(/:[A-Za-z0-9_]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '/?$'
  );
  routes.push({ method, rx, keys, handler });
}

// ---------------------------------------------------------------------------
// SSE: dashboard live updates
// ---------------------------------------------------------------------------
const sseClients = new Set();
function sse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  const client = { res };
  sseClients.add(client);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  const done = () => {
    clearInterval(ping);
    sseClients.delete(client);
  };
  req.on('close', done);
  res.on('error', done); // abrupt client disconnect -> async EPIPE/ECONNRESET; swallow it
}
function broadcast(type, data = {}) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try {
      c.res.write(line);
    } catch {
      sseClients.delete(c);
    }
  }
}
bus.on('changed', () => broadcast('changed'));
bus.on('event', (e) => broadcast('event', e));
bus.on('session-status', (e) => broadcast('session-status', e));

// ---------------------------------------------------------------------------
// state snapshot
// ---------------------------------------------------------------------------
let _touchCache = { at: 0, map: new Map() };
export function buildState() {
  const projects = store.listProjects();
  const sessions = store.listSessions();
  const byId = new Map(projects.map((p) => [p.id, p]));
  // Engagement tier per session (attention governor): newest operator touch (message or launch),
  // grouped query cached ~10s — buildState runs per poll tick.
  if (Date.now() - _touchCache.at > 10_000) _touchCache = { at: Date.now(), map: store.lastOperatorTouchBySession() };
  const touch = _touchCache.map;
  const decorate = (s) => {
    const fastCapable = s.tool === 'codex' && modelSupportsFast(s.model || TOOLS[s.tool]?.model);
    const tier = tierOf({ lastTouch: Math.max(touch.get(s.id) || 0, Number(s.started_at) || 0) });
    return {
      ...s,
      tier,
      fastMode: fastCapable && !!s.fast_mode,
      fastCapable,
      project: s.project_id ? byId.get(s.project_id) || null : null,
      toolLabel: TOOLS[s.tool]?.label || s.tool,
      toolColor: TOOLS[s.tool]?.color || '#8b949e',
      modelLabel: (TOOLS[s.tool]?.models || []).find((m) => m.id === s.model)?.label || modelDisplayLabel(s.model) || TOOLS[s.tool]?.modelLabel || null,
    };
  };
  const all = sessions.map(decorate);
  // the "needs you" queue: waiting AND not LLM-judged as still-working. Tiered by engagement
  // (blocking > fresh > stale) so an abandoned session's asks can't crowd out live work.
  const queue = all
    .filter((s) => s.status === 'waiting' && s.category !== 'working')
    .map((s) => ({ ...s, queueTier: queueTier({ tier: s.tier, category: s.category }) }))
    .sort((a, b) => (QUEUE_TIER_ORDER[a.queueTier] ?? 1) - (QUEUE_TIER_ORDER[b.queueTier] ?? 1));
  return {
    ok: true,
    time: now(),
    version: VERSION,
    tools: TOOL_IDS.map((id) => ({
      id,
      label: TOOLS[id].label,
      color: TOOLS[id].color,
      model: TOOLS[id].model,
      modelLabel: TOOLS[id].modelLabel,
      models: TOOLS[id].models || [],
      efforts: TOOLS[id].efforts,
      defaultEffort: TOOLS[id].defaultEffort,
      fastMode: !!TOOLS[id].fastMode,
      orchestrations: TOOLS[id].orchestrations || [],
      defaultOrchestration: TOOLS[id].defaultOrchestration ?? null,
    })),
    defaults: { autonomy: DEFAULT_AUTONOMY },
    autonomyLevels: AUTONOMY_LEVELS,
    flags: flags(),
    projects,
    sessions: all,
    queue,
    counts: {
      waiting: queue.filter((s) => s.queueTier !== 'stale').length,
      stale: queue.filter((s) => s.queueTier === 'stale').length,
      working: all.filter((s) => s.status === 'working').length,
      live: all.filter((s) => s.status !== 'exited').length,
    },
  };
}

// ---------------------------------------------------------------------------
// core routes (more are registered by feature modules)
// ---------------------------------------------------------------------------
route('GET', '/healthz', (req, res) => json(res, 200, { ok: true, service: 'aios', version: VERSION, time: now() }));
route('GET', '/api/state', (req, res) => json(res, 200, buildState()));
// Release version (single source: package.json, read at boot). no-store so the new-version toast
// (web/version-badge.js) always sees the live value rather than a heuristically-cached response.
route('GET', '/api/version', (req, res) => { res.setHeader('cache-control', 'no-store'); json(res, 200, { version: VERSION }); });

// Feature-flag kill-switches (launch-path features default OFF). GET reports effective flags + which
// are env-locked; POST persists a patch to data/feature_flags.json (env overrides still win on read).
route('GET', '/api/flags', (req, res) => json(res, 200, { ok: true, flags: flags(), locks: flagLocks(), defs: FLAG_DEFS }));
route('POST', '/api/flags', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  const patch = {};
  for (const k of FLAG_KEYS) if (k in b) patch[k] = b[k] === true || b[k] === 1 || b[k] === '1';
  json(res, 200, { ok: true, flags: setFlags(patch), locks: flagLocks() });
});
route('GET', '/api/events', (req, res) => sse(req, res));

route('GET', '/api/projects', (req, res) => json(res, 200, store.listProjects()));
route('POST', '/api/projects', async (req, res) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim();
  const path = String(b.path || '').trim();
  if (!name || !path) return json(res, 400, { error: 'name and path are required' });
  if (!path.startsWith('/')) return json(res, 400, { error: 'path must be absolute (e.g. /home/you/code/project)' });
  const existing = store.getProjectByPath(path);
  if (existing) return json(res, 200, existing);
  const p = store.createProject({ id: id('p'), name, path });
  bus.emit('changed');
  json(res, 201, p);
});
route('DELETE', '/api/projects/:id', (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  if (store.liveSessionsForProject(pid) > 0) return json(res, 409, { error: 'project has live sessions — kill them first' });
  store.deleteProject(pid);
  bus.emit('changed');
  json(res, 200, { ok: true });
});

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/session') p = '/session.html';
  if (p === '/records') p = '/records.html';
  if (p === '/decisions') p = '/decisions.html';
  if (p === '/auth') p = '/auth.html';
  if (p === '/usage') p = '/usage.html';
  if (p === '/health') p = '/health.html';
  const file = confinedPath(WEB_DIR, p);
  if (!file) return send(res, 403, 'forbidden');
  try {
    const data = await readFile(file);
    const ext = extname(file);
    // App code (html/js/css/manifest, excluding vendored libs) must revalidate so a
    // deploy reaches phones on the next reload — without this, no cache headers were
    // sent and Safari heuristically cached stale JS (e.g. an old voicemode.js). Vendored
    // libs + icons/fonts are immutable enough to cache for a day.
    const appCode = !p.startsWith('/vendor/') && /\.(html|js|css|webmanifest)$/.test(file);
    // App code: no-store so a deploy always reaches the client on the next load. (no-cache only
    // means "revalidate", which iOS Safari / a Home-Screen PWA don't reliably honor on a soft
    // refresh → stale JS.) Vendored libs + icons stay cacheable.
    const textLike = /\.(html|js|css|webmanifest|svg|json|map)$/.test(file);
    (textLike ? sendCompressed : send)(res, 200, data, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': appCode ? 'no-store' : 'max-age=86400',
    });
  } catch {
    send(res, 404, 'not found');
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Supercalm is reachable directly on :8793 AND under a /aios path on 443 (Tailscale Serve
  // --set-path=/aios). Strip the optional /aios prefix so routing + static serving are
  // identical either way. (The frontend uses <base href="/aios/"> + relative URLs, so even
  // direct :8793 requests arrive prefixed — and a 443 path-proxy already strips it once.)
  url.pathname = url.pathname.replace(/^\/aios(?=\/|$)/, '') || '/';
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return await r.handler(req, res, params, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url);
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[aios] handler error', req.method, url.pathname, err);
    if (!res.headersSent) json(res, 500, { error: String(err?.message || err) });
    else res.end();
  }
});

// Feature modules register their routes by importing { route } from here.
// Fire-and-forget (NOT top-level await) AFTER `routes` is initialized: this
// avoids a hang in any one module's async boot from blocking server.listen,
// and avoids "unsettled top-level await" tearing the process down.
for (const mod of ['./sessions.js', './detect.js', './spark.js', './push.js', './hooks.js', './mcp.js', './project_graph.js', './lessons.js', './playbook_api.js', './doctrine_api.js', './update_check.js', './agents/supervisor/project_memory.js', './pm_api.js', './models_api.js', './snippets.js', './tts.js', './voice.js', './records.js', './authapi.js', './usage.js', './model_proxy.js', './model_scan.js', './tool_updates.js', './product_health.js', './agents/host.js']) {
  import(mod).catch((e) => console.error(`[aios] ${mod} not loaded:`, e.message));
}

// Tailscale Serve pools keep-alive connections to this backend. Node's default
// keepAliveTimeout (5s) FINs those idle pooled connections constantly; Serve's side
// lingers half-closed (CLOSE_WAIT piling up inside tailscaled, observed 100+), which
// can starve tailscaled of fds — symptom: established SSE streams keep updating but
// NEW page loads through the tailnet hang. Outlive Serve's idle pool (90s) instead.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000; // must exceed keepAliveTimeout

server.on('error', (e) => {
  console.error('[aios] server error:', e.message);
  if (e.code === 'EADDRINUSE') process.exit(1); // fatal: let the supervisor restart
});
server.listen(PORT, HOST, () => {
  console.log(`[aios] listening on http://${HOST}:${PORT}`);
});
