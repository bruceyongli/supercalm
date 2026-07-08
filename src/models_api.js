// API model providers — routes for the Auth & Models page (src/model_providers.js is the store).
// Keys travel ONE way: in via POST, never out (list responses redact to key_set). Specific routes
// registered before any :id patterns (router matches in registration order).

import { route, json } from './server.js';
import { listProviders, getProvider, upsertProvider, deleteProvider, probeProvider, PROVIDER_KINDS } from './model_providers.js';
import { bus } from './bus.js';

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}
async function bodyJson(req) {
  try { return JSON.parse(await readBody(req) || '{}'); } catch { return {}; }
}

route('GET', '/api/models/providers', (req, res) => {
  json(res, 200, { ok: true, kinds: PROVIDER_KINDS, providers: listProviders() });
});

// Add / update. With probe:true (default) the provider is verified first and its live model list
// captured — a bad key/URL never lands in the registry silently.
route('POST', '/api/models/providers', async (req, res) => {
  const b = await bodyJson(req);
  try {
    const existing = b.id ? getProvider(b.id) : null;
    const apiKey = b.api_key || existing?.api_key || '';
    let models = Array.isArray(b.models) && b.models.length ? b.models : existing?.models || [];
    if (b.probe !== false) {
      const probe = await probeProvider({ kind: b.kind, base_url: b.base_url, api_key: apiKey });
      if (!probe.ok) return json(res, 400, { ok: false, error: `provider check failed: ${probe.error}` });
      if (probe.models.length) models = models.length ? models : probe.models;
    }
    const row = upsertProvider({ id: b.id || null, name: b.name, kind: b.kind, base_url: b.base_url, api_key: b.api_key, models, enabled: b.enabled });
    bus.emit('changed');
    return json(res, 200, { ok: true, provider: row });
  } catch (e) {
    return json(res, 400, { ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

route('POST', '/api/models/providers/:id/test', async (req, res, { id }) => {
  const p = getProvider(id);
  if (!p) return json(res, 404, { ok: false, error: 'no such provider' });
  const r = await probeProvider(p);
  return json(res, 200, { ok: r.ok, models: r.models.slice(0, 40), error: r.error });
});

route('DELETE', '/api/models/providers/:id', (req, res, { id }) => {
  deleteProvider(id);
  bus.emit('changed');
  return json(res, 200, { ok: true, deleted: id });
});
