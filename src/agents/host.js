import { readFile, readdir } from 'node:fs/promises';
import { join, basename, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from '../config.js';
import { route, json, readJson } from '../server.js';
import { bus } from '../bus.js';
import { now } from '../util.js';
import { getSession, getGrant, upsertGrant, deleteGrant, listEnabledGrants, GLOBAL_AGENT_SCOPE } from '../store.js';
import { mergePreviewProfileSecrets, redactPreviewConfig } from '../preview_profiles.js';
import { makeContext, HIGH_RISK_CAPS, CapabilityError } from './context.js';

// The agent host: a registry of panel agents (built-in + drop-in), one central tick scheduler that
// codifies the per-agent in-flight/timeout/SIGKILL discipline once, and the /api/agents* routes.
// Agent modules are passive — they export `meta` (manifest), optional `onTick(ctx)`, and optional
// `actions` ({name: (ctx, body) => result}). The host owns scheduling, capability enforcement plumbing,
// and HTTP; agents only ever touch `ctx`.

const TICK_MS = Number(process.env.AIOS_AGENT_TICK_MS || process.env.AIOS_SUPERVISOR_TICK_MS || 15000);
const INFLIGHT_TTL_MS = Number(process.env.AIOS_AGENT_INFLIGHT_TTL_MS || 300000);
const TICK_TIMEOUT_MS = Number(process.env.AIOS_AGENT_TICK_TIMEOUT_MS || 120000);
const BUILTIN_IDS = ['supervisor', 'map', 'usage', 'builder', 'knowledge', 'preflight'];
const AGENTS_DIR = join(DATA_DIR, 'agents');

const registry = new Map(); // id -> { meta, source, dir?, onTick?, actions?, appliesTo? }
const inflight = new Map(); // `${gid}:${agentId}` -> startedAt ms

function ikey(gid, agentId) {
  return `${gid}:${agentId}`;
}
function isInflight(gid, agentId) {
  const at = inflight.get(ikey(gid, agentId));
  if (!at) return false;
  if (now() - at > INFLIGHT_TTL_MS) {
    inflight.delete(ikey(gid, agentId));
    return false;
  }
  return true;
}

function registerModule(mod, { source, dir, metaOverride } = {}) {
  const meta = metaOverride || mod.meta;
  if (!meta || !meta.id) {
    console.error('[aios] agent module missing meta.id; skipped', dir || source);
    return;
  }
  registry.set(meta.id, {
    meta,
    source,
    dir: dir || null,
    onTick: typeof mod.onTick === 'function' ? mod.onTick : null,
    actions: mod.actions && typeof mod.actions === 'object' ? mod.actions : null,
    summary: typeof mod.summary === 'function' ? mod.summary : null,
    appliesTo: typeof meta.appliesTo === 'function' ? meta.appliesTo : typeof mod.appliesTo === 'function' ? mod.appliesTo : null,
  });
}

async function loadBuiltins() {
  for (const id of BUILTIN_IDS) {
    try {
      const mod = await import(`./${id}.js`);
      registerModule(mod, { source: 'builtin' });
    } catch (e) {
      console.error(`[aios] built-in agent '${id}' not loaded:`, e.message);
    }
  }
}

async function loadDropins() {
  let entries = [];
  try {
    entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  } catch {
    return; // no data/agents dir yet
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(AGENTS_DIR, ent.name);
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'agent.json'), 'utf8'));
      manifest.id = manifest.id || ent.name;
      let mod = {};
      try {
        mod = await import(pathToFileURL(join(dir, 'backend.js')).href + `?t=${now()}`);
      } catch {} // view-only drop-ins have no backend.js
      registerModule(mod, { source: 'dropin', dir, metaOverride: { ...mod.meta, ...manifest } });
    } catch (e) {
      console.error(`[aios] drop-in agent '${ent.name}' not loaded:`, e.message);
    }
  }
}

async function reload() {
  // re-scan drop-ins only (built-ins are static); keeps built-in registrations intact.
  for (const [id, rec] of registry) if (rec.source === 'dropin') registry.delete(id);
  await loadDropins();
  bus.emit('changed');
}

// ---------------------------------------------------------------------------
// registry view (drives the frontend tab bar + Agents-home)
// ---------------------------------------------------------------------------
function gidFor(meta, session_id) {
  return meta.scope === 'global' ? GLOBAL_AGENT_SCOPE : session_id;
}

// Some agent config holds secrets (e.g. the supervisor's gated-preview passcodes). NEVER ship the raw value
// to the browser / /api/state — swap it for boolean "*_set" markers the UI renders as "saved".
function redactConfig(cfg) {
  return redactPreviewConfig(cfg);
}

function viewAgent(rec, session_id) {
  const m = rec.meta;
  const gid = gidFor(m, session_id);
  const grant = getGrant(gid, m.id);
  const defaultEnabled = !!m.defaultEnabled;
  // A grant (if present) is authoritative — including an explicit OFF that overrides defaultEnabled —
  // so the Agents list checkbox and the visible tabs stay in sync (e.g. Graph/Usage read as enabled,
  // and can be toggled off). No grant -> fall back to the agent's defaultEnabled.
  const enabled = grant ? !!grant.enabled : defaultEnabled;
  let recommend = 0;
  try {
    recommend = Number(rec.appliesTo?.(getSession(session_id)) ?? m.recommend ?? 0) || 0;
  } catch {}
  const caps = m.capabilities || [];
  let data = null;
  try {
    data = rec.summary ? rec.summary(session_id) ?? null : null;
  } catch (e) {
    console.error(`[aios] agent '${m.id}' summary failed:`, e.message);
  }
  return {
    id: m.id,
    name: m.name || m.id,
    version: m.version || '0.0.0',
    description: m.description || '',
    kind: m.kind || 'agent',
    scope: m.scope || 'session',
    capabilities: caps,
    highRiskCaps: caps.filter((c) => HIGH_RISK_CAPS.has(c)),
    ui: m.ui || { tab: m.name || m.id },
    source: rec.source,
    hasBackend: !!(rec.onTick || rec.actions),
    actions: Object.keys(rec.actions || {}),
    defaultEnabled,
    active: enabled,
    grant: grant ? { enabled: grant.enabled, caps: grant.caps, config: redactConfig(grant.config) } : null,
    config: redactConfig({ ...(m.defaults || {}), ...(grant?.config || {}) }),
    recommend,
    running: isInflight(gid, m.id),
    data,
  };
}

function registryView(session_id) {
  return [...registry.values()]
    .map((rec) => viewAgent(rec, session_id))
    .sort((a, b) => (a.ui.order ?? 100) - (b.ui.order ?? 100) || a.name.localeCompare(b.name));
}

// Apply an enable/caps/config patch with the consent policy: explicit `caps` (from the consent UI)
// replace the granted set; on a bare enable, auto-grant low-risk declared caps only — high-risk
// (send-input/write-files/exec/manage-agents) stay off until the operator opts in.
function applyGrant(gid, rec, body) {
  const declared = rec.meta.capabilities || [];
  const existing = getGrant(gid, rec.meta.id);
  const patch = {};
  if (Array.isArray(body.caps)) {
    patch.caps = body.caps.filter((c) => declared.includes(c));
  } else if (body.enabled) {
    if (!existing) patch.caps = declared.filter((c) => !HIGH_RISK_CAPS.has(c));
  }
  if (body.enabled != null) patch.enabled = !!body.enabled;
  if (body.config != null && typeof body.config === 'object') {
    patch.config = mergePreviewProfileSecrets(existing?.config || {}, body.config);
  }
  // The generic Agents home enables high-risk caps conservatively. For Supervisor, that must not look
  // like Auto-pilot if send-input was not explicitly granted through the panel/consent controls — record
  // it as the Observe MODE (tri-state send authority) with the legacy observe_only mirror kept in sync,
  // so runtime (modeOf) and panel agree. The panel's own mode control is the path that grants send-input.
  if (rec.meta.id === 'supervisor' && body.enabled && !Array.isArray(body.caps)) {
    const nextCaps = patch.caps || existing?.caps || [];
    if (!nextCaps.includes('send-input')) patch.config = { ...(patch.config || {}), mode: 'observe', observe_only: true };
  }
  return upsertGrant(gid, rec.meta.id, patch);
}

// ---------------------------------------------------------------------------
// scheduler (one interval; per-agent in-flight + timeout + crash isolation)
// ---------------------------------------------------------------------------
async function runTick(rec, session_id) {
  const gid = gidFor(rec.meta, session_id);
  if (isInflight(gid, rec.meta.id)) return;
  inflight.set(ikey(gid, rec.meta.id), now());
  const ctx = makeContext(rec.meta, gid, { trigger: 'tick' });
  try {
    await Promise.race([
      rec.onTick(ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error('agent tick timeout')), TICK_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.error(`[aios] agent '${rec.meta.id}' tick error (${session_id}):`, e.message);
  } finally {
    inflight.delete(ikey(gid, rec.meta.id));
  }
}

function tick() {
  for (const grant of listEnabledGrants()) {
    const rec = registry.get(grant.agent_id);
    if (!rec || !rec.onTick) continue;
    if (grant.session_id === GLOBAL_AGENT_SCOPE) {
      runTick(rec, GLOBAL_AGENT_SCOPE);
      continue;
    }
    const s = getSession(grant.session_id);
    if (!s) continue;
    if (s.status === 'exited') {
      const exitedMs = Number(rec.meta.tickOnExitedMs || 0);
      const endedAt = Number(s.ended_at || s.last_activity || 0);
      if (!exitedMs || !endedAt || now() - endedAt > exitedMs) continue;
    }
    runTick(rec, grant.session_id);
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
// No-session catalog (manifests only; no per-session grants) — for debugging + non-session UIs.
route('GET', '/api/agents', (req, res) => {
  const agents = [...registry.values()].map((rec) => ({
    id: rec.meta.id,
    name: rec.meta.name || rec.meta.id,
    description: rec.meta.description || '',
    kind: rec.meta.kind || 'agent',
    scope: rec.meta.scope || 'session',
    capabilities: rec.meta.capabilities || [],
    source: rec.source,
    hasBackend: !!(rec.onTick || rec.actions),
    actions: Object.keys(rec.actions || {}),
    ui: rec.meta.ui || { tab: rec.meta.name || rec.meta.id },
  }));
  json(res, 200, { ok: true, agents });
});

route('GET', '/api/session/:id/agents', (req, res, { id: sid }) => {
  if (!getSession(sid)) return json(res, 404, { error: 'no such session' });
  json(res, 200, { ok: true, agents: registryView(sid) });
});

route('POST', '/api/session/:id/agents/:agentId', async (req, res, { id: sid, agentId }) => {
  if (!getSession(sid)) return json(res, 404, { error: 'no such session' });
  const rec = registry.get(agentId);
  if (!rec) return json(res, 404, { error: 'no such agent' });
  const body = await readJson(req);
  const gid = gidFor(rec.meta, sid);
  applyGrant(gid, rec, body);
  bus.emit('changed');
  json(res, 200, { ok: true, agent: viewAgent(rec, sid), agents: registryView(sid) });
});

route('POST', '/api/session/:id/agents/:agentId/:action', async (req, res, { id: sid, agentId, action }) => {
  if (!getSession(sid)) return json(res, 404, { error: 'no such session' });
  const rec = registry.get(agentId);
  if (!rec) return json(res, 404, { error: 'no such agent' });
  const fn = rec.actions?.[action];
  if (!fn) return json(res, 404, { error: 'no such action' });
  const gid = gidFor(rec.meta, sid);
  // Using an agent (running an action) implies consent to its low-risk caps (observe/think) so doc
  // generate + manual review work before the agent is formally enabled. High-risk caps still require
  // an explicit grant via the consent UI.
  if (!getGrant(gid, agentId)) {
    const declared = rec.meta.capabilities || [];
    upsertGrant(gid, agentId, { caps: declared.filter((c) => !HIGH_RISK_CAPS.has(c)) });
  }
  if (isInflight(gid, agentId)) return json(res, 409, { error: 'agent is busy' });
  const body = await readJson(req).catch(() => ({}));
  inflight.set(ikey(gid, agentId), now());
  try {
    const ctx = makeContext(rec.meta, gid, { trigger: 'manual', action });
    const result = await fn(ctx, body || {});
    bus.emit('changed');
    json(res, 200, { ok: true, result, agent: viewAgent(rec, sid), agents: registryView(sid) });
  } catch (e) {
    if (e instanceof CapabilityError || e.code === 'CAP_DENIED') {
      return json(res, 403, { error: e.message, capability: e.capability, reason: e.reason });
    }
    json(res, 500, { error: String(e.message || e) });
  } finally {
    inflight.delete(ikey(gid, agentId));
  }
});

route('GET', '/api/agents/:id/panel.js', async (req, res, { id }) => {
  const rec = registry.get(id);
  if (!rec || rec.source !== 'dropin' || !rec.dir) return json(res, 404, { error: 'no such drop-in agent' });
  try {
    const data = await readFile(join(rec.dir, 'panel.js'));
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'panel not found' });
  }
});

route('POST', '/api/agents/reload', async (req, res) => {
  await reload();
  json(res, 200, { ok: true, count: registry.size });
});

// Serve a preview screenshot captured by getEvidence({screenshot}). Shared evidence infra writes to
// data/supervisor/<sid>/<ts>.png; reviews/agents reference it by basename.
const SHOT_DIR = join(DATA_DIR, 'supervisor');
route('GET', '/api/session/:id/shot/:file', async (req, res, { id: sid, file }) => {
  if (!getSession(sid)) return json(res, 404, { error: 'no such session' });
  const name = basename(String(file || ''));
  if (!name || !name.endsWith('.png')) return json(res, 400, { error: 'bad screenshot name' });
  const dir = normalize(join(SHOT_DIR, sid));
  const target = normalize(join(dir, name));
  if (!target.startsWith(dir + '/')) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'screenshot not found' });
  }
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
(async () => {
  await loadBuiltins();
  await loadDropins();
  setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error('[aios] agent scheduler error', e.message);
    }
  }, TICK_MS);
  console.log(`[aios] agent host active (${registry.size} agents)`);
})();
