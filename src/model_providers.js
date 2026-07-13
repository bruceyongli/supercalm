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

import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync, mkdirSync } from 'node:fs';
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
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
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
  // Keyless is allowed (local/LAN endpoints often have no auth); the probe tells the user if the
  // endpoint actually requires one.
  if (!existing) data.providers.push(row);
  writeAll(data);
  return listProviders().find((p) => p.id === row.id);
}

// Built-in local proxies (the fleet, when present) presented AS provider rows — same section,
// same mental model as user-added endpoints. Live-derived from the scanned catalog (never stored:
// no key duplication; fleetKey() stays the auth). The registry file only remembers which builtins
// the user disabled.
export function listBuiltinProviders(currentProviders, modelsByProxy) {
  const disabled = new Set(readAll().builtin_disabled || []);
  return (currentProviders || []).map((p) => ({
    id: `builtin:${p.proxy}`,
    builtin: true,
    name: `${p.label} (local proxy)`,
    kind: 'openai',
    base_url: `http://127.0.0.1:${p.port}`,
    key_set: 'auto',
    enabled: !disabled.has(p.proxy),
    models: (modelsByProxy?.[p.proxy] || []).slice(0, 100),
  }));
}
export function setBuiltinEnabled(proxy, enabled) {
  const data = readAll();
  const set = new Set(data.builtin_disabled || []);
  if (enabled) set.delete(proxy); else set.add(proxy);
  data.builtin_disabled = [...set];
  writeAll(data);
  return { proxy, enabled };
}
export function builtinDisabled() {
  return new Set(readAll().builtin_disabled || []);
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
      ? { ...(api_key ? { 'x-api-key': api_key } : {}), 'anthropic-version': '2023-06-01' }
      : api_key ? { authorization: `Bearer ${api_key}` } : {};
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
    if (!p.enabled) continue; // keyless rows route too — call path sends auth only when a key exists
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

// ---- speech provider (STT + TTS) -----------------------------------------------------------------
// One OpenAI-compatible audio endpoint covers local AND remote voice: /v1/audio/transcriptions (STT)
// + /v1/audio/speech (TTS). Works with OpenAI, Groq (STT), and local servers that speak the same
// shape (speaches, Kokoro-FastAPI, whisper.cpp server, openedai-speech). Stored alongside the model
// providers (same chmod-600 file); key redacted on read like everything else. The Spark device (when
// configured via SPARK_IP/SPARK_HOST) stays primary; this is the everyone-else path.
export function getSpeech({ redact = true } = {}) {
  const sp = readAll().speech || null;
  if (!sp) return null;
  return redact ? { ...sp, api_key: undefined, key_set: !!sp.api_key } : sp;
}

export function setSpeech({ base_url, api_key, stt_model, tts_model, tts_voice, tts_instructions, enabled = true } = {}) {
  const data = readAll();
  const cur = data.speech || {};
  const next = {
    base_url: normalizeBase(base_url ?? cur.base_url, 'openai'),
    api_key: api_key !== undefined && api_key !== '' ? String(api_key) : cur.api_key || '',
    stt_model: String(stt_model ?? cur.stt_model ?? 'whisper-1').slice(0, 80),
    tts_model: String(tts_model ?? cur.tts_model ?? 'tts-1').slice(0, 80),
    tts_voice: String(tts_voice ?? cur.tts_voice ?? 'alloy').slice(0, 60),
    // Optional speaking-style instructions (OpenAI gpt-4o-mini-tts and newer accept `instructions`);
    // sent only when non-empty, so plain tts-1 / local servers never see an unknown param.
    tts_instructions: String(tts_instructions ?? cur.tts_instructions ?? '').slice(0, 300),
    enabled: enabled !== false,
    updated_at: now(),
  };
  if (!next.base_url) throw new Error('base_url required');
  // local servers often need no key — allow empty, but keep the field
  data.speech = next;
  writeAll(data);
  return getSpeech();
}

export function clearSpeech() {
  const data = readAll();
  delete data.speech;
  writeAll(data);
}

// ---- voice override (edit the ACTIVE Spark TTS/STT config from the UI) ----------------------------
// The env (data/aios.env: SPARK_IP/SPARK_HOST + AIOS_TTS_*) is the deployment default; this DB override
// takes precedence at runtime and hot-reloads, so a developer can edit host/engine/voice/instructions
// without hand-editing env + restarting (spark.js effectiveSpark() / tts.js voiceConfig() merge it over
// env). Delete = clear the override → revert to env. Only overridden keys persist; `sparkDisabled` mutes
// Spark (voice falls to the local/cloud/browser chain) without deleting the override.
const VOICE_OVERRIDE_KEYS = ['ip', 'host', 'ttsEngine', 'ttsVoice', 'ttsInstruct'];
export function getVoiceOverride() {
  const v = readAll().voice || null;
  if (!v) return null;
  return { spark: v.spark || {}, sparkDisabled: !!v.sparkDisabled };
}
export function setVoiceOverride(patch = {}) {
  const data = readAll();
  const cur = data.voice || {};
  const spark = { ...(cur.spark || {}) };
  for (const k of VOICE_OVERRIDE_KEYS) {
    if (patch[k] === undefined) continue;
    const val = String(patch[k] ?? '').trim().slice(0, 200);
    if (val) spark[k] = val; else delete spark[k]; // blank clears just that field → re-inherit env
  }
  const next = { ...cur, spark, updated_at: now() };
  if (patch.sparkDisabled !== undefined) next.sparkDisabled = !!patch.sparkDisabled;
  data.voice = next;
  writeAll(data);
  return getVoiceOverride();
}
export function clearVoiceOverride() {
  const data = readAll();
  delete data.voice;
  writeAll(data);
}

// Probe: synthesize a one-word clip (the only check that proves TTS actually works; /v1/models is
// optional on audio servers). Returns {ok, tts, contentType, error}.
export async function probeSpeech({ base_url, api_key, tts_model = 'tts-1', tts_voice = 'alloy' } = {}) {
  const base = normalizeBase(base_url, 'openai');
  try {
    const r = await fetch(base + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(api_key ? { authorization: `Bearer ${api_key}` } : {}) },
      body: JSON.stringify({ model: tts_model, input: 'ok', voice: tts_voice, response_format: 'mp3' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `TTS HTTP ${r.status}: ${t.slice(0, 160)}` };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) return { ok: false, error: 'TTS returned no audio' };
    return { ok: true, tts: true, bytes: buf.length, contentType: r.headers.get('content-type') || '' };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}
