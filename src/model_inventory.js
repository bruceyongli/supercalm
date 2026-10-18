// Read-only fleet discovery, independent of server startup so failure/recovery can be exercised
// against isolated HTTP fixtures. A failed probe is not an authoritative replacement inventory.
import { normalizeReasoningEfforts } from './model_catalog.js';

export function prettyModelId(id) {
  const out = [];
  for (const part of String(id).split('-').filter(Boolean)) {
    if (/^\d+$/.test(part) && out.length && /^\d[\d.]*$/.test(out.at(-1))) out[out.length - 1] += '.' + part;
    else out.push(/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1));
  }
  return out.join(' ');
}

export async function fetchInventoryJson(url, key, { fetcher = fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetcher(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { await res.body?.cancel(); return { error: `HTTP ${res.status}` }; }
    try { return { value: await res.json() }; } catch { return { error: 'Invalid JSON inventory' }; }
  } catch (error) {
    // Never persist response bodies, credentials, or arbitrary upstream error text in the catalog.
    return { error: /timeout|abort/i.test(error?.name) ? 'Inventory request timed out' : 'Inventory connection failed' };
  }
}

export async function scanProvider(seed, overview, key, options = {}) {
  const port = Number(overview?.port || seed.port), at = new Date().toISOString();
  const base = `http://127.0.0.1:${port}/v1/models`;
  let result = await fetchInventoryJson(`${base}?latest=1`, key, options);
  let inventoryFilter = 'latest';
  const valid = value => Array.isArray(value?.data) && value.data.every(m => m && typeof m.id === 'string' && m.id.trim());
  if (!valid(result.value)) {
    const filteredError = result.error || 'Invalid model inventory';
    result = await fetchInventoryJson(base, key, options);
    inventoryFilter = null;
    if (!valid(result.value)) return {
      ...seed, port, up: !!seed.lastSuccessfulAt || seed.up === true, reachable: false, stale: true,
      lastAttemptAt: at, scanError: result.error || filteredError,
      // Preserve all model IDs, aliases, recommendations and capabilities from the last good scan.
      models: seed.models || [],
    };
  }
  const prior = new Map((seed.models || []).map(m => [m.id, m]));
  const ovModels = new Map((Array.isArray(overview?.models) ? overview.models : []).filter(m => m?.id).map(m => [m.id, m]));
  const models = result.value.data.map(d => {
    const o = ovModels.get(d.id), s = prior.get(d.id);
    return { id: d.id, label: o?.displayName || d.display_name || s?.label || prettyModelId(d.id),
      recommended: o?.recommended ?? d.recommended ?? !!s?.recommended,
      vision: d.capabilities?.image_input ?? o?.capabilities?.image_input ?? s?.vision,
      efforts: normalizeReasoningEfforts(d.supported_reasoning_efforts || d.supportedReasoningEfforts || d.reasoning_efforts
        || d.supported_reasoning_levels || d.efforts || o?.efforts || o?.reasoning_efforts || s?.efforts),
      kind: o?.kind || d.kind || s?.kind || 'chat', role: o?.role || s?.role || null };
  });
  const ids = new Set(models.map(m => m.id));
  const recommended = (Array.isArray(overview?.recommended) ? overview.recommended : []).filter(id => ids.has(id));
  return { proxy: seed.proxy, label: seed.label || seed.proxy, port, nativeFor: seed.nativeFor || [],
    up: true, reachable: true, stale: false, lastAttemptAt: at, lastSuccessfulAt: at, scanError: null, inventoryFilter,
    aliases: seed.proxy === 'spark' ? (result.value.x_proxy_inventory?.aliases || seed.aliases || {}) : {},
    deprecated: overview?.deprecated || seed.deprecated || null,
    recommended: [...new Set([...models.filter(m => m.recommended && !recommended.includes(m.id)).map(m => m.id),
      ...recommended, ...models.filter(m => m.recommended).map(m => m.id)])], models };
}

export function discoverySeeds(staticProviders, previousProviders, overviewProviders = []) {
  const seeds = new Map(staticProviders.map(p => [p.proxy, p]));
  // Previous discoveries replace the static seed, including for builtins. Otherwise a single failed
  // scan rolls every current Claude model back to the old hardcoded versions.
  for (const p of previousProviders) seeds.set(p.proxy, p);
  for (const p of overviewProviders) if (!seeds.has(p.proxy) && Number(p.port)) {
    seeds.set(p.proxy, { proxy: p.proxy, label: p.proxy, port: p.port, nativeFor: [], models: [] });
  }
  return [...seeds.values()];
}
