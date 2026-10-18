// Dynamic model catalog — "scan" instead of hardcode. Authenticated subscription CLIs are the
// primary source, configured API providers refresh second, and each proxy port's
// GET /v1/models?latest=1 supplies the fleet fallback. The antigravity /admin/overview endpoint enriches fleet ids with
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
import { fetchInventoryJson, scanProvider, discoverySeeds } from './model_inventory.js';
export { prettyModelId } from './model_inventory.js';

const CATALOG_PATH = join(DATA_DIR, 'model_catalog.json');
const OVERVIEW_PORT = Number(process.env.AIOS_FLEET_OVERVIEW_PORT || 8791);
const RESCAN_INTERVAL_MS = Number(process.env.AIOS_MODEL_RESCAN_MS || 3600_000);

export async function scanCatalog() {
  const key = await fleetKey({ refresh: true });
  const { value: overview } = await fetchInventoryJson(`http://127.0.0.1:${OVERVIEW_PORT}/admin/overview`, key);
  const overviewProviders = (Array.isArray(overview?.providers) ? overview.providers : []).filter(p => p?.proxy);
  const ovByProxy = new Map(overviewProviders.map((p) => [p.proxy, p]));

  // provider set: static seed order first, then current (previously scanned), then overview-only
  const seeds = discoverySeeds(PROXY_PROVIDERS, currentProviders(), overviewProviders);

  // Builtin rows the user disabled on the Models page drop out of the scan entirely — their
  // models leave the catalog on the next apply, exactly like removing a user provider.
  let disabled = new Set();
  try { disabled = (await import('./model_providers.js')).builtinDisabled(); } catch {}
  return Promise.all(seeds.filter((s2) => !disabled.has(s2.proxy)).map((seed) => scanProvider(seed, ovByProxy.get(seed.proxy), key)));
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
  const failures = providers.filter(p => p.scanError).map(p => ({ provider: p.proxy, error: p.scanError, retained: !!p.up }));
  const degraded = providers.every(p => p.reachable === false) || providers.some(p => p.stale && p.up);
  return { ok, scannedAt, providerCount: providers.length, modelCount: models.length, added, cli: cli.sources, apiProviders, failures, degraded };
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
  // Failed discovery retries promptly but with a bounded backoff, not an hourly empty picker or
  // a tight authentication loop. Never retry simply because an unused, never-seen provider is absent.
  let retryTimer, attempts = 0;
  async function scheduledScan() {
    clearTimeout(retryTimer);
    let degraded = true;
    try {
      const r = await rescanModels();
      console.log(`[aios] model scan: ${r.modelCount} models${r.added.length ? `, +${r.added.length} new` : ''}${r.failures.length ? `; ${JSON.stringify(r.failures)}` : ''}`);
      degraded = r.degraded;
    } catch (e) { console.error('[aios] model scan failed:', e.message); }
    if (degraded && attempts < 3) retryTimer = setTimeout(scheduledScan, [60_000, 120_000, 300_000][attempts++]);
    else if (!degraded) attempts = 0;
    retryTimer?.unref();
  }
  setTimeout(scheduledScan, 3000).unref();
  setInterval(() => { attempts = 0; void scheduledScan(); }, RESCAN_INTERVAL_MS).unref();
})();
