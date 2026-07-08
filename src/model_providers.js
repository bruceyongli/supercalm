// User-configured API model providers — the "I don't run a local proxy fleet" path.
// Most users have an Anthropic/OpenAI(-compatible) API key, not a localhost fleet on 8787-8792.
// This registry lets them add providers on the Auth & Models page; models from here merge into the
// live catalog, `routeForModel` resolves to them, and every internal model consumer (supervisor,
// doctrine, triage, migration, boundary) routes through the same seam (agents/model.js callOnce
// understands base-URL routes). Claude sessions can also ride an anthropic-kind provider
// (authmode.js mode 'api') when no fleet/login is available.
//
// Storage: data/model_providers.json, chmod 600 (holds API keys). Keys are NEVER returned by list
// APIs (redacted to key_set booleans) and never logged.

import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { id as genId, now } from './util.js';
import { registerUserRoutes } from './model_catalog.js';

const FILE = join(DATA_DIR, 'model_providers.json');
export const PROVIDER_KINDS = ['openai', 'anthropic'];

let _cache = null;

function readAll() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(readFileSync(FILE, 'utf8')); } catch { _cache = { providers: [] }; }
  if (!Array.isArray(_cache.providers)) _cache = { providers: [] };
  return _cache;
}
function writeAll(data) {
  _cache = data;
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, FILE);
  syncRoutes();
}

export function normalizeBase(url, kind) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return kind === 'anthropic' ? 'https://api.anthropic.com' : '';
  if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  // store WITHOUT a trailing /v1 — the transport adds protocol paths itself
  u = u.replace(/\/v1$/, '');
  return u;
}

export function listProviders({ redact = true } = {}) {
  const rows = readAll().providers;
  if (!redact) return rows;
  return rows.map((p) => ({ ...p, api_key: undefined, key_set: !!p.api_key }));
}
export function getProvider(id) {
  return readAll().providers.find((p) => p.id === id) || null;
}

export function upsertProvider({ id = null, name, kind, base_url, api_key, models = [], enabled = true }) {
  if (!PROVIDER_KINDS.includes(kind)) throw new Error('kind must be openai|anthropic');
  const data = readAll();
  const existing = id ? data.providers.find((p) => p.id === id) : null;
  const row = existing || { id: 'prov_' + genId(), created_at: now() };
  row.name = String(name || '').slice(0, 60) || (kind === 'anthropic' ? 'Anthropic API' : 'OpenAI-compatible API');
  row.kind = kind;
  row.base_url = normalizeBase(base_url, kind);
  if (api_key !== undefined && api_key !== '') row.api_key = String(api_key);
  row.models = [...new Set((models || []).map((m) => String(m).trim()).filter(Boolean))].slice(0, 60);
  row.enabled = enabled !== false;
  row.updated_at = now();
  if (!row.base_url) throw new Error('base_url required');
  if (!row.api_key) throw new Error('api_key required');
  if (!existing) data.providers.push(row);
  writeAll(data);
  return listProviders().find((p) => p.id === row.id);
}

export function deleteProvider(id) {
  const data = readAll();
  data.providers = data.providers.filter((p) => p.id !== id);
  writeAll(data);
}

// Probe: list the provider's models with its own protocol. Returns {ok, models[], error}.
export async function probeProvider({ kind, base_url, api_key }) {
  const base = normalizeBase(base_url, kind);
  try {
    const headers = kind === 'anthropic'
      ? { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${api_key}` };
    const r = await fetch(base + '/v1/models', { headers, signal: AbortSignal.timeout(12000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j?.error?.message || `HTTP ${r.status}`, models: [] };
    const models = (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 100);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200), models: [] };
  }
}

// Routes for the catalog: exact model-id resolution + a "<providerName>/<model>" prefixed form for
// collisions with fleet ids. Pushed into model_catalog (push, not pull — no import cycle).
export function providerRoutes() {
  const routes = [];
  for (const p of readAll().providers) {
    if (!p.enabled || !p.api_key) continue;
    for (const m of p.models || []) {
      const route = {
        proxy: 'api', kind: p.kind, providerId: p.id, providerLabel: p.name,
        base: p.base_url, key: p.api_key, id: m, model: m, label: `${m} (${p.name})`,
      };
      routes.push(route);
    }
  }
  return routes;
}

export function syncRoutes() {
  try { registerUserRoutes(providerRoutes()); } catch {}
}

// register at boot
syncRoutes();
