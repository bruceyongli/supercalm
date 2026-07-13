// API model providers — routes for the Auth & Models page (src/model_providers.js is the store).
// Keys travel ONE way: in via POST, never out (list responses redact to key_set). Specific routes
// registered before any :id patterns (router matches in registration order).

import { route, json } from './server.js';
import { listProviders, getProvider, upsertProvider, deleteProvider, probeProvider, PROVIDER_KINDS, getSpeech, setSpeech, clearSpeech, probeSpeech, listBuiltinProviders, setBuiltinEnabled, getVoiceOverride, setVoiceOverride, clearVoiceOverride } from './model_providers.js';
import { currentProviders, listProxyModels } from './model_catalog.js';
import { pricingStatus, refreshPrices, clearPricing, SUPERCALM_PRICES_URL } from './pricing.js';
import { bus } from './bus.js';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { DATA_DIR, SPARK } from './config.js';
import { voiceConfig } from './tts.js';
import { effectiveSpark, sparkEnabled } from './spark.js';
import { db } from './store.js';

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}
async function bodyJson(req) {
  try { return JSON.parse(await readBody(req) || '{}'); } catch { return {}; }
}

route('GET', '/api/models/providers', (req, res) => {
  // builtin = the local proxy fleet presented as provider rows (operator: one section, one mental
  // model — subscription auth up top, every model ENDPOINT lives here). Live-derived, key auto.
  const byProxy = {};
  for (const m of listProxyModels({ includeImages: true })) (byProxy[m.provider] = byProxy[m.provider] || []).push(m.id); // entries key the proxy as .provider
  json(res, 200, {
    ok: true, kinds: PROVIDER_KINDS, providers: listProviders(),
    builtin: listBuiltinProviders(currentProviders(), byProxy),
    speech: getSpeech(), spark_configured: !!SPARK.ip,
    spark: (() => {
      const eff = effectiveSpark(); const vc = voiceConfig(); const overridden = Object.keys(getVoiceOverride()?.spark || {});
      // Editor prefills the EFFECTIVE config (env or override) so "the info is there" (operator) — the
      // Settings page is authenticated + it's the operator's own infra. `overridden` tells the UI which
      // fields are a saved override vs inherited from data/aios.env (per-field FROM ENV / OVERRIDDEN badge).
      return { configured: !!eff.ip, enabled: sparkEnabled(), envHost: SPARK.host, host: eff.host,
        ip: eff.ip, port: eff.port,
        sttModel: getSpeech()?.stt_model || 'whisper-1', ttsEngine: vc.ttsEngine, ttsVoice: vc.ttsVoice, ttsInstruct: vc.ttsInstruct,
        localTtsPort: vc.localTtsPort, localVoice: vc.localVoice, backend: vc.backend,
        source: overridden.length ? 'override' : 'env', overridden };
    })(),
    pricing: { ...pricingStatus(), suggested_url: SUPERCALM_PRICES_URL },
  });
});

// First-run setup flag (design handoff onboarding contract): finishing the wizard sets it; a box
// that already runs sessions is grandfathered complete so onboarding never hijacks a live install.
route('GET', '/api/setup', (req, res) => {
  try {
    const { existsSync, readFileSync } = require('node:fs');
    const f = join(DATA_DIR, 'setup.json');
    let complete = false;
    try { complete = !!JSON.parse(readFileSync(f, 'utf8')).complete; } catch {}
    if (!complete) {
      const n = db.prepare('SELECT count(*) c FROM sessions').get()?.c || 0;
      if (n > 0) complete = true; // grandfathered
    }
    json(res, 200, { ok: true, complete });
  } catch (e) { json(res, 200, { ok: true, complete: true }); }
});
route('POST', '/api/setup', async (req, res) => {
  const { writeFileSync } = require('node:fs');
  writeFileSync(join(DATA_DIR, 'setup.json'), JSON.stringify({ complete: true, at: Date.now() }));
  json(res, 200, { ok: true, complete: true });
});

// Built-in local proxy rows: enable/disable only (they are discovered, not stored).
route('POST', '/api/models/providers/builtin/:proxy', async (req, res, { proxy }) => {
  const b = await bodyJson(req);
  const r = setBuiltinEnabled(String(proxy), b.enabled !== false);
  bus.emit('changed');
  json(res, 200, { ok: true, ...r });
});

// Pricing manifest (optional): set a URL (or one-click the Supercalm-hosted list), refresh, or
// clear to skip cost stats entirely. Providers whose own API carries prices override per-model.
route('GET', '/api/models/pricing', (req, res) => json(res, 200, { ok: true, ...pricingStatus(), suggested_url: SUPERCALM_PRICES_URL }));
route('POST', '/api/models/pricing', async (req, res) => {
  const b = await bodyJson(req);
  const r = await refreshPrices(String(b.url || SUPERCALM_PRICES_URL));
  json(res, r.ok ? 200 : 400, r);
});
route('POST', '/api/models/pricing/refresh', async (req, res) => json(res, 200, await refreshPrices()));
route('DELETE', '/api/models/pricing', (req, res) => { clearPricing(); json(res, 200, { ok: true, configured: false }); });

// Speech (STT/TTS) provider — one OpenAI-compatible audio endpoint, local or remote.
route('POST', '/api/models/speech', async (req, res) => {
  const b = await bodyJson(req);
  try {
    if (b.probe !== false) {
      const cur = getSpeech({ redact: false });
      const probe = await probeSpeech({
        base_url: b.base_url ?? cur?.base_url,
        api_key: (b.api_key !== undefined && b.api_key !== '') ? b.api_key : cur?.api_key,
        tts_model: b.tts_model ?? cur?.tts_model,
        tts_voice: b.tts_voice ?? cur?.tts_voice,
      });
      if (!probe.ok) return json(res, 400, { ok: false, error: `speech check failed: ${probe.error}` });
    }
    const row = setSpeech(b);
    bus.emit('changed');
    return json(res, 200, { ok: true, speech: row });
  } catch (e) {
    return json(res, 400, { ok: false, error: String(e.message || e).slice(0, 200) });
  }
});
route('DELETE', '/api/models/speech', (req, res) => {
  clearSpeech();
  bus.emit('changed');
  return json(res, 200, { ok: true });
});

// Voice override — edit the ACTIVE Spark config (host/engine/voice/instructions) or mute it ("use"),
// hot-reloaded over the env defaults. DELETE clears the override → reverts to data/aios.env.
route('POST', '/api/models/voice', async (req, res) => {
  const b = await bodyJson(req);
  try {
    const ov = setVoiceOverride(b);
    bus.emit('changed');
    return json(res, 200, { ok: true, voice: ov });
  } catch (e) {
    return json(res, 400, { ok: false, error: String(e.message || e).slice(0, 200) });
  }
});
route('DELETE', '/api/models/voice', (req, res) => {
  clearVoiceOverride();
  bus.emit('changed');
  return json(res, 200, { ok: true });
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
