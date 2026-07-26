// Dynamic model catalog — "scan" instead of hardcode. Authenticated subscription CLIs are the
// primary source, configured API providers refresh second, and each proxy port's GET /v1/models
// supplies the fleet fallback. The antigravity /admin/overview endpoint enriches fleet ids with
// display names / roles / recommended flags / live status. Results merge over the static seed in
// model_catalog.js, apply in-process, and persist to data/model_catalog.json so a restart boots with
// the last scan even when every upstream is down.
//
// The fleet gates /v1/models behind PROXY_API_KEY — fleetKey() (model_catalog.js) auto-reads
// it from the proxies' own launchd plists, no per-machine config. On machines without the
// fleet every probe just fails fast and the static seed stays in effect.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { route, json } from './server.js';
import { DATA_DIR } from './config.js';
import {
  PROXY_PROVIDERS,
  applyCatalog,
  catalogMeta,
  currentProviders,
  fleetKey,
  listProxyModels,
} from './model_catalog.js';
import { discoverCliModels } from './cli_model_discovery.js';
import { refreshProviderModels } from './model_providers.js';

const CATALOG_PATH = join(DATA_DIR, 'model_catalog.json');
const OVERVIEW_PORT = Number(process.env.AIOS_FLEET_OVERVIEW_PORT || 8791);
const FETCH_TIMEOUT_MS = 5000;
const RESCAN_INTERVAL_MS = Number(process.env.AIOS_MODEL_RESCAN_MS || 3600_000);

async function fetchJson(url, key) {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// claude-opus-4-8 -> "Claude Opus 4.8"; claude-fable-5 -> "Claude Fable 5";
// claude-3-5-haiku-latest -> "Claude 3.5 Haiku Latest". Joins consecutive numeric
// segments with '.' so version-ish ids read like the curated labels do.
export function prettyModelId(id) {
  const parts = String(id).split('-').filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && out.length && /^\d[\d.]*$/.test(out[out.length - 1])) out[out.length - 1] += '.' + p;
    else out.push(/^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1));
  }
  return out.join(' ');
}

async function scanProvider(seed, ov, key) {
  const port = Number(ov?.port || seed.port);
  const ovModels = new Map((ov?.models || []).map((m) => [m.id, m]));
  const seedModels = new Map((seed.models || []).map((m) => [m.id, m]));
  const live = await fetchJson(`http://127.0.0.1:${port}/v1/models`, key);
  const ids = Array.isArray(live?.data) ? live.data.filter((d) => d && d.id) : null;
  const models = ids?.length
    ? ids.map((d) => {
        const o = ovModels.get(d.id);
        const s = seedModels.get(d.id);
        return {
          id: d.id,
          label: o?.displayName || s?.label || d.display_name || prettyModelId(d.id),
          recommended: o ? !!o.recommended : !!s?.recommended,
          kind: o?.kind || s?.kind || 'chat',
          role: o?.role || s?.role || null,
        };
      })
    : [...seedModels.values()]; // port down -> keep what we knew, just mark it down
  return {
    proxy: seed.proxy,
    label: seed.label || seed.proxy,
    port,
    nativeFor: seed.nativeFor || [],
    up: !!ids?.length,
    deprecated: ov?.deprecated || seed.deprecated || null,
    // Preserve the provider's ordered recommendation list instead of reducing it to booleans.
    // This is the automatic "best current models" signal consumed by Supervisor defaults.
    recommended: Array.isArray(ov?.recommended)
      ? ov.recommended.filter((id) => typeof id === 'string' && id)
      : models.filter((model) => model.recommended).map((model) => model.id),
    models,
  };
}

export async function scanCatalog() {
  const key = await fleetKey();
  const overview = await fetchJson(`http://127.0.0.1:${OVERVIEW_PORT}/admin/overview`, key);
  const ovByProxy = new Map((overview?.providers || []).map((p) => [p.proxy, p]));

  // provider set: static seed order first, then current (previously scanned), then overview-only
  const seeds = new Map(PROXY_PROVIDERS.map((p) => [p.proxy, p]));
  for (const p of currentProviders()) if (!seeds.has(p.proxy)) seeds.set(p.proxy, p);
  for (const [proxy, p] of ovByProxy) {
    if (!seeds.has(proxy) && Number(p.port)) seeds.set(proxy, { proxy, label: proxy, port: p.port, nativeFor: [], models: [] });
  }

  // Builtin rows the user disabled on the Models page drop out of the scan entirely — their
  // models leave the catalog on the next apply, exactly like removing a user provider.
  let disabled = new Set();
  try { disabled = (await import('./model_providers.js')).builtinDisabled(); } catch {}
  return Promise.all([...seeds.values()].filter((s2) => !disabled.has(s2.proxy)).map((seed) => scanProvider(seed, ovByProxy.get(seed.proxy), key)));
}

export function mergeCliCatalog(providers, cliProviders = {}) {
  return providers.map((provider) => {
    const cli = Array.isArray(cliProviders[provider.proxy]) ? cliProviders[provider.proxy] : [];
    if (!cli.length) return provider;
    const merged = new Map();
    for (const model of cli) merged.set(model.id, model);
    for (const model of provider.models || []) if (!merged.has(model.id)) merged.set(model.id, model);
    // Subscription CLI order is authoritative. Its top/recommended models lead the provider/fleet
    // recommendations, with the latter retained as automatic fallbacks.
    const recommended = [...new Set([
      ...cli.filter((model) => model.recommended).map((model) => model.id),
      ...(provider.recommended || []),
    ])];
    return { ...provider, recommended, models: [...merged.values()] };
  });
}

let rescanInFlight = null;
async function performRescan() {
  const before = new Set(listProxyModels({ includeImages: true }).map((m) => m.id));
  // Required precedence: signed-in subscription CLIs, configured API providers, then fleet.
  const cli = await discoverCliModels();
  const apiProviders = await refreshProviderModels();
  const providers = mergeCliCatalog(await scanCatalog(), cli.providers);
  const scannedAt = new Date().toISOString();
  const ok = applyCatalog(providers, { scannedAt, source: 'auto' });
  const models = listProxyModels({ includeImages: true });
  const added = ok ? models.filter((m) => !before.has(m.id)).map((m) => ({ id: m.id, label: m.label })) : [];
  if (ok) {
    await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    await writeFile(CATALOG_PATH, JSON.stringify({ scannedAt, providers }, null, 2)).catch((e) =>
      console.error('[aios] model catalog not persisted:', e.message)
    );
  }
  return { ok, scannedAt, providerCount: providers.length, modelCount: models.length, added, cli: cli.sources, apiProviders };
}

export function rescanModels() {
  if (!rescanInFlight) rescanInFlight = performRescan().finally(() => { rescanInFlight = null; });
  return rescanInFlight;
}

export function modelsSummary() {
  const meta = catalogMeta();
  return { scannedAt: meta.scannedAt, source: meta.source, modelCount: listProxyModels({ includeImages: true }).length };
}

route('GET', '/api/models', (req, res) => {
  json(res, 200, { ok: true, ...catalogMeta(), providers: currentProviders(), models: listProxyModels({ includeImages: true }) });
});

route('POST', '/api/models/refresh', async (req, res) => {
  json(res, 200, await rescanModels());
});

// Boot: last persisted scan first (instant, works offline), then a fresh background scan.
(async () => {
  try {
    const saved = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
    if (applyCatalog(saved.providers, { scannedAt: saved.scannedAt, source: 'disk' }))
      console.log(`[aios] model catalog loaded from disk (${saved.scannedAt})`);
  } catch {}
  setTimeout(() => rescanModels().then(
    (r) => console.log(`[aios] model scan: ${r.modelCount} models${r.added.length ? `, +${r.added.length} new` : ''}`),
    (e) => console.error('[aios] model scan failed:', e.message)
  ), 3000);
  setInterval(() => rescanModels().catch(() => {}), RESCAN_INTERVAL_MS).unref();
})();
