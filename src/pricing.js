// Model pricing — OPTIONAL cost stats from a user-configurable price manifest URL.
// Design (operator, 2026-07-09): users who want cost stats point at any price manifest — their
// own endpoint, the community LiteLLM file, an openhand-models.json-style feed, or one click on
// the Supercalm-hosted list (versioned in the repo, free CDN via raw.githubusercontent, PR-able).
// If a provider's own /v1/models already carries prices, those win for that provider's models.
// No URL configured = no cost stats anywhere (tokens only) — entirely skippable.
//
// Three manifest shapes auto-detected, normalized to USD per 1M tokens:
//  A. LiteLLM model_prices_and_context_window.json: { "<id>": { input_cost_per_token, ... } }
//  B. openhand-models.json: { models: [ { id, pricing: { token: { unit:"per_1m_tokens", input, output, cached_input } } } ] }
//  C. native (ours, docs/model-prices.json): { models: { "<id>": { input, output, cached } }, unit: "per_1m_tokens" }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

const CACHE_PATH = join(DATA_DIR, 'model_prices.json');
export const SUPERCALM_PRICES_URL = process.env.AIOS_PRICES_URL_DEFAULT
  || 'https://raw.githubusercontent.com/bruceyongli/supercalm/main/docs/model-prices.json';
const REFRESH_MS = Number(process.env.AIOS_PRICES_REFRESH_MS || 24 * 3600_000);

let cache = null; // { url, fetched_at, source_kind, prices: { id: {in, out, cached} } }
try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch {}

function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }

// -> { id: { in, out, cached } } in USD per 1M tokens, or null if the shape is unrecognized.
export function parseManifest(j) {
  if (!j || typeof j !== 'object') return null;
  const out = {};
  if (Array.isArray(j.models)) { // B: openhand-style
    for (const m of j.models) {
      const t = m?.pricing?.token;
      if (!m?.id || !t) continue;
      const scale = /per_1k/.test(String(t.unit || 'per_1m_tokens')) ? 1000 : 1;
      const inp = num(t.input), outp = num(t.output);
      if (inp == null && outp == null) continue;
      out[m.id] = { in: inp != null ? inp * scale : null, out: outp != null ? outp * scale : null, cached: num(t.cached_input) != null ? num(t.cached_input) * scale : null };
    }
    return Object.keys(out).length ? { kind: 'openhand', prices: out } : null;
  }
  if (j.models && typeof j.models === 'object') { // C: native
    const scale = /per_1k/.test(String(j.unit || 'per_1m_tokens')) ? 1000 : 1;
    for (const [id, p] of Object.entries(j.models)) {
      const inp = num(p?.input), outp = num(p?.output);
      if (inp == null && outp == null) continue;
      out[id] = { in: inp != null ? inp * scale : null, out: outp != null ? outp * scale : null, cached: num(p?.cached) != null ? num(p.cached) * scale : null };
    }
    return Object.keys(out).length ? { kind: 'native', prices: out } : null;
  }
  // A: LiteLLM — a flat map of id -> per-TOKEN costs
  for (const [id, p] of Object.entries(j)) {
    if (!p || typeof p !== 'object') continue;
    const inp = num(p.input_cost_per_token), outp = num(p.output_cost_per_token);
    if (inp == null && outp == null) continue;
    out[id] = { in: inp != null ? inp * 1e6 : null, out: outp != null ? outp * 1e6 : null, cached: num(p.cache_read_input_token_cost) != null ? num(p.cache_read_input_token_cost) * 1e6 : null };
  }
  return Object.keys(out).length ? { kind: 'litellm', prices: out } : null;
}

export async function refreshPrices(url) {
  const u = String(url || cache?.url || '').trim();
  if (!u) return { ok: false, error: 'no pricing url configured' };
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const parsed = parseManifest(await r.json());
    if (!parsed) return { ok: false, error: 'unrecognized manifest shape (want LiteLLM / openhand-models / native)' };
    cache = { url: u, fetched_at: Date.now(), source_kind: parsed.kind, prices: parsed.prices };
    try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch {}
    return { ok: true, source_kind: parsed.kind, count: Object.keys(parsed.prices).length, fetched_at: cache.fetched_at };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

export function clearPricing() {
  cache = null;
  try { writeFileSync(CACHE_PATH, 'null'); } catch {}
}

export function pricingStatus() {
  return cache?.prices
    ? { configured: true, url: cache.url, source_kind: cache.source_kind, count: Object.keys(cache.prices).length, fetched_at: cache.fetched_at }
    : { configured: false };
}

// Manifest lookup consumed by usage_pricing.priceRuleFor — the USER's manifest overrides the
// compiled RULES for exact ids (bare or provider-prefixed); unknown ids fall back to RULES.
export function manifestPriceFor(modelId) {
  if (!cache?.prices) return null;
  const id = String(modelId || '');
  const bare = id.includes('/') ? id.split('/').pop() : id;
  const hit = cache.prices[id] || cache.prices[bare] || null;
  if (!hit) return null;
  return hit; // { in, out, cached } — USD per 1M tokens, same unit as usage_pricing RULES
}

// test seam (suite only): inject a parsed cache without network.
export function __testSetCache(c) { cache = c; }

// Daily refresh while configured (fire-and-forget; a failed refresh keeps the last good cache).
setInterval(() => { if (cache?.url) refreshPrices().catch(() => {}); }, REFRESH_MS).unref?.();
