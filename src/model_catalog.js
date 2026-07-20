import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const AIOS_PORT = Number(process.env.AIOS_PORT || 8793);

export const AIOS_CLI_PROXY_BASE =
  process.env.AIOS_CLI_PROXY_BASE || `http://127.0.0.1:${AIOS_PORT}/api/cli-proxy`;
export const AIOS_CLI_PROXY_V1_BASE = `${AIOS_CLI_PROXY_BASE}/v1`;
export const AIOS_PROXY_API_KEY = process.env.AIOS_PROXY_API_KEY || 'sk-aios-via-proxy';

function parseDotenvKey(text, names) {
  const wanted = new Set(names);
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !wanted.has(m[1])) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  return '';
}

async function readDevVarsProxyKey() {
  const names = ['LOCAL_PROVIDER_PROXY_KEY', 'PROXY_API_KEY', 'AIOS_PROXY_KEY'];
  for (const file of [join(homedir(), '.dev.vars'), join(homedir(), 'proxy', '.dev.vars')]) {
    const key = parseDotenvKey(await readFile(file, 'utf8').catch(() => ''), names);
    if (key) return key;
  }
  return '';
}

// The proxy fleet gates every endpoint behind its PROXY_API_KEY. Supercalm can read the
// local shared key from ~/.dev.vars (LOCAL_PROVIDER_PROXY_KEY), from the proxy
// fleet's .dev.vars/launchd plist, or from an explicit Supercalm env override. Falls
// back to the dummy key only if no local key is discoverable. Cached after the
// first read — lazy, no I/O at import time.
let fleetKeyCache;
export async function fleetKey() {
  if (process.env.AIOS_PROXY_KEY) return process.env.AIOS_PROXY_KEY;
  if (process.env.LOCAL_PROVIDER_PROXY_KEY) return process.env.LOCAL_PROVIDER_PROXY_KEY;
  if (fleetKeyCache !== undefined) return fleetKeyCache;
  const devVarsKey = await readDevVarsProxyKey();
  if (devVarsKey) return (fleetKeyCache = devVarsKey);
  try {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    for (const f of await readdir(dir)) {
      if (!/proxy.*\.plist$/.test(f)) continue;
      const xml = await readFile(join(dir, f), 'utf8').catch(() => '');
      const m = xml.match(/<key>PROXY_API_KEY<\/key>\s*<string>([^<]+)<\/string>/);
      if (m) return (fleetKeyCache = m[1].trim());
    }
  } catch {}
  return (fleetKeyCache = AIOS_PROXY_API_KEY);
}

export const MODEL_ALIASES = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
};

const CODEX_FAST_MODELS = new Set(['gpt-5.5', 'gpt-5.4']);

export const PROXY_PROVIDERS = [
  {
    proxy: 'antigravity',
    label: 'Antigravity',
    port: 8791,
    nativeFor: ['agy'],
    models: [
      { id: 'gemini-pro-agent', label: 'Gemini 3.1 Pro (High)', recommended: true },
      { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
      { id: 'gemini-3-flash-agent', label: 'Gemini 3.5 Flash (High)', recommended: true },
      { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Medium)' },
      { id: 'gemini-3.5-flash-extra-low', label: 'Gemini 3.5 Flash (Low)' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
      { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', kind: 'image' },
    ],
  },
  {
    proxy: 'codex',
    label: 'Codex',
    port: 8788,
    nativeFor: ['codex'],
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', recommended: true, pinned: true }, // operator pick 2026-07-20
      { id: 'gpt-5.5', label: 'GPT-5.5', recommended: true },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', recommended: true },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
      { id: 'gpt-5.2', label: 'GPT-5.2' },
      // NB no 'codex-auto-review' here: it's a FLEET-side routing alias, not a model the codex CLI
      // can run natively — seeding it leaked a dead option into fleet-less pickers (E2E finding #1).
      // Fleet machines still get it: the live scan lists it from /v1/models and re-adds it.
    ],
  },
  {
    proxy: 'claude',
    label: 'Claude',
    port: 8789,
    nativeFor: ['claude'],
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5', recommended: true, pinned: true }, // operator pick 2026-07-20
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', recommended: true },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', recommended: true },
      { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
    ],
  },
  {
    proxy: 'aliyun',
    label: 'Aliyun',
    port: 8790,
    nativeFor: [],
    models: [
      // Operator picks (2026-07-20): Aliyun's top two. NB qwen3.8-max-preview currently returns 403
      // from the fleet proxy — an ACCOUNT entitlement (enable it on the Aliyun console); glm-5.2 is
      // verified working via passthrough. Listed so they're selectable the moment access exists.
      { id: 'qwen3.8-max-preview', label: 'Qwen3.8-Max (preview)', recommended: true, pinned: true },
      { id: 'glm-5.2', label: 'GLM-5.2', recommended: true, pinned: true },
      { id: 'qwen3.7-max', label: 'Qwen3.7-Max' },
      { id: 'qwen3.6-plus', label: 'Qwen3.6-Plus' },
      { id: 'qwen3.6-flash', label: 'Qwen3.6-Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'glm-5.1', label: 'GLM-5.1' },
      { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
      { id: 'qwen-image-2.0-pro', label: 'Qwen-Image 2.0 Pro', kind: 'image' },
      { id: 'wan2.7-image-pro', label: 'Wan2.7 Image Pro', kind: 'image' },
    ],
  },
  {
    proxy: 'gemini',
    label: 'Gemini',
    port: 8787,
    nativeFor: [],
    models: [
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)', recommended: true },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (preview)' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.5-computer-use-preview-10-2025', label: 'Gemini 2.5 Computer Use' },
    ],
  },
  {
    proxy: 'spark',
    label: 'Spark',
    port: 8792,
    nativeFor: [],
    models: [{ id: 'qwen36-a3b-nvfp4-marlin', label: 'Qwen3.6-35B-A3B (NVFP4)' }],
  },
];

// Live catalog state. Seeded from the static PROXY_PROVIDERS above; model_scan.js replaces it
// with what the proxy fleet actually serves right now (applyCatalog), so new models — e.g. a
// fresh claude release the fleet already knows — become selectable without a code change.
let PROVIDERS = PROXY_PROVIDERS;
let CATALOG_META = { scannedAt: null, source: 'static' };
let PROVIDER_BY_PROXY = new Map();
let ROUTES_BY_ID = new Map();

function rebuildIndex() {
  PROVIDER_BY_PROXY = new Map(PROVIDERS.map((p) => [p.proxy, p]));
  ROUTES_BY_ID = new Map();
  for (const p of PROVIDERS) {
    for (const m of p.models) {
      if (!ROUTES_BY_ID.has(m.id)) ROUTES_BY_ID.set(m.id, { ...m, proxy: p.proxy, providerLabel: p.label, port: p.port });
    }
  }
  for (const [alias, concrete] of Object.entries(MODEL_ALIASES)) {
    const route = ROUTES_BY_ID.get(concrete);
    if (route) ROUTES_BY_ID.set(alias, { ...route, id: alias, upstreamModel: concrete, label: route.label });
  }
}
rebuildIndex();

export function currentProviders() {
  return PROVIDERS;
}

export function catalogMeta() {
  return CATALOG_META;
}

export function applyCatalog(providers, meta = {}) {
  const clean = (Array.isArray(providers) ? providers : [])
    .filter((p) => p && p.proxy && Number(p.port) && Array.isArray(p.models))
    .map((p) => ({
      proxy: String(p.proxy),
      label: p.label || p.proxy,
      port: Number(p.port),
      nativeFor: Array.isArray(p.nativeFor) ? p.nativeFor : [],
      up: p.up !== false,
      deprecated: p.deprecated || null,
      models: p.models
        .filter((m) => m && m.id)
        .map((m) => ({
          id: String(m.id),
          label: m.label || String(m.id),
          recommended: !!m.recommended,
          kind: m.kind || 'chat',
          role: m.role || null,
        })),
    }));
  if (!clean.length || !clean.some((p) => p.models.length)) return false;
  // OPERATOR PINS: seed entries marked pinned:true persist through rescans even when the provider's
  // /v1/models omits them (verified-passthrough or awaiting-entitlement models, 2026-07-20 picks).
  for (const p of clean) {
    const seed = PROXY_PROVIDERS.find((sp) => sp.proxy === p.proxy);
    if (!seed) continue;
    const pinned = seed.models.filter((m) => m.pinned);
    if (!pinned.length) continue;
    const have = new Map(p.models.map((m) => [m.id, m]));
    for (const pin of pinned) {
      const existing = have.get(pin.id);
      if (existing) { existing.pinned = true; existing.recommended = true; } // the scan lists it — the pin outranks stale scan flags
      else p.models.unshift({ id: pin.id, label: pin.label || pin.id, recommended: true, kind: pin.kind || 'chat', role: pin.role || null, pinned: true });
    }
  }
  PROVIDERS = clean;
  CATALOG_META = { scannedAt: meta.scannedAt || new Date().toISOString(), source: meta.source || 'scan' };
  rebuildIndex();
  return true;
}

// liveOnly: skip providers whose last scan found the port unreachable (scanProvider marks `up:false`;
// a fleet-less install marks EVERY fleet provider down on its first scan). Pickers that offer models to
// RUN pass liveOnly — offering a down provider's model is a guaranteed failure (first-time-user report:
// "showed all models, and most are not available"). Admin/label surfaces keep the full catalog.
// `top`: cap the SELECTABLE list at the best N chat models per provider (recommended first, then the
// provider's own order — the fleet operator curates that order). 0 = uncapped; routing/resolution
// callers must stay uncapped or running sessions on older models would stop resolving.
export function listProxyModels({ providers = null, includeImages = false, liveOnly = false, top = 0 } = {}) {
  const allow = providers ? new Set(providers) : null;
  return PROVIDERS
    .filter((p) => !allow || allow.has(p.proxy))
    .filter((p) => !liveOnly || p.up !== false)
    .flatMap((p) => {
      let models = p.models.filter((m) => includeImages || (m.kind || 'chat') !== 'image');
      if (top > 0) {
        const chat = models.filter((m) => (m.kind || 'chat') === 'chat');
        // operator pins > recommended > the fleet's own order; dedupe BEFORE slicing or a model in
        // two tiers eats a slot (sol is pinned AND recommended -> codex offered one model, not two).
        const ranked = [...new Map([...chat.filter((m) => m.pinned), ...chat.filter((m) => m.recommended), ...chat].map((m) => [m.id, m])).keys()];
        const keep = new Set(ranked.slice(0, top));
        models = models.filter((m) => (m.kind || 'chat') !== 'chat' || keep.has(m.id));
      }
      return models
        .map((m) => {
          // "Claude / Claude Opus 4.8" -> "Claude / Opus 4.8" (drop the redundant prefix)
          const short = String(m.label || m.id).replace(new RegExp(`^${p.label}\\s+`, 'i'), '');
          return {
            id: m.id,
            label: `${p.label} / ${short}`,
            modelLabel: m.label,
            provider: p.proxy,
            providerLabel: p.label,
            port: p.port,
            recommended: !!m.recommended,
            kind: m.kind || 'chat',
            supportsFast: p.proxy === 'codex' && CODEX_FAST_MODELS.has(m.id),
          };
        });
    })
    // user API providers ride every listing (panel pickers, /api/models) unless a fleet filter excludes them
    .concat((!allow || allow.has('api')) ? userRoutes().map((r) => ({
      id: r.id,
      label: `${r.providerLabel} / ${r.model}`,
      modelLabel: r.model,
      provider: 'api',
      providerLabel: r.providerLabel,
      port: null,
      recommended: false,
      kind: 'chat',
      supportsFast: false,
    })) : []);
}

export function toolModels(tool) {
  if (tool === 'agy') return listProxyModels({ providers: ['antigravity'], top: 2 }); // agy-native — its CLI login serves these

  // Alias entries replace their concrete targets (don't ALSO list claude-opus-4-8 when
  // "opus" maps to it — duplicate rows with near-identical labels confuse the picker).
  const seen = new Set(tool === 'claude' ? Object.values(MODEL_ALIASES) : []);
  // Alias labels follow the catalog (e.g. "opus" shows whatever claude-opus-* it maps to today).
  const nativeAliases =
    tool === 'claude'
      ? Object.entries(MODEL_ALIASES).map(([alias, concrete]) => {
          const m = ROUTES_BY_ID.get(concrete);
          const short = (m?.label || concrete).replace(/^Claude\s+/i, '');
          return { id: alias, label: `Claude / ${short}` };
        })
      : [];
  // The tool's own provider leads as ONE contiguous section (aliases + the rest of its
  // models, e.g. Fable 5 / Opus 4.7 right under the opus alias), then everything else.
  // The own-provider section is NOT live-gated: those ids ride the CLI's own login (claude
  // --model / codex -c model=) and work with zero fleet. Cross-provider models REQUIRE the
  // bridge → a reachable fleet port, so `rest` is live-gated — a fresh fleet-less install
  // offers exactly what its CLIs can actually run instead of the whole static seed.
  const native =
    tool === 'codex'
      ? listProxyModels({ providers: ['codex'], top: 2 })
      : tool === 'claude'
        ? [...nativeAliases, ...listProxyModels({ providers: ['claude'], top: 2 })]
        : [];
  const ownProvider = tool === 'codex' ? 'codex' : tool === 'claude' ? 'claude' : null;
  const rest = listProxyModels({ liveOnly: true, top: 2 }).filter((m) => m.provider !== ownProvider); // operator rule (2026-07-20): only each provider's top two are offered
  return [...native, ...rest].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// User API-provider routes (model_providers.js pushes these — push, not pull, to avoid a cycle).
// Consulted FIRST in routeForModel: a user-added model id wins over a fleet id of the same name,
// and "<provider-name>/<model>" always addresses the user provider explicitly.
const USER_ROUTES = new Map();
export function registerUserRoutes(routes = []) {
  USER_ROUTES.clear();
  for (const r of routes) {
    USER_ROUTES.set(r.id, r);
    USER_ROUTES.set(`${String(r.providerLabel || 'api').toLowerCase().replace(/\s+/g, '-')}/${r.id}`, r);
  }
}
export function userRoutes() {
  return [...new Set(USER_ROUTES.values())];
}

export function routeForModel(model) {
  const raw = String(model || '').trim();
  const userHit = USER_ROUTES.get(raw);
  if (userHit) return { ...userHit };
  const prefixed = raw.match(/^([A-Za-z0-9_-]+)[:/](.+)$/);
  if (prefixed && PROVIDER_BY_PROXY.has(prefixed[1])) {
    const provider = PROVIDER_BY_PROXY.get(prefixed[1]);
    return {
      proxy: provider.proxy,
      providerLabel: provider.label,
      port: provider.port,
      id: raw,
      model: prefixed[2],
      label: prefixed[2],
    };
  }
  const route = ROUTES_BY_ID.get(raw) || ROUTES_BY_ID.get(MODEL_ALIASES[raw]);
  if (route) return { ...route, model: route.upstreamModel || route.id };

  const fallback = PROVIDER_BY_PROXY.get(process.env.AIOS_DEFAULT_PROXY || 'antigravity') || PROVIDERS[0];
  return {
    proxy: fallback.proxy,
    providerLabel: fallback.label,
    port: Number(process.env.AIOS_DEFAULT_PROXY_PORT || fallback.port),
    id: raw,
    model: raw,
    label: raw,
  };
}

export function modelDisplayLabel(model) {
  const raw = String(model || '').trim();
  if (!raw) return null;
  const match = toolModels('claude').find((m) => m.id === raw) || listProxyModels({ includeImages: true }).find((m) => m.id === raw);
  if (match) return match.label;
  const route = routeForModel(raw);
  return route.providerLabel && route.label ? `${route.providerLabel} / ${route.label}` : raw;
}

export function isNativeModel(tool, model) {
  if (!model) return false;
  const route = routeForModel(model);
  return (PROVIDER_BY_PROXY.get(route.proxy)?.nativeFor || []).includes(tool);
}

export function modelSupportsFast(model) {
  if (!model) return false;
  const route = routeForModel(model);
  return route.proxy === 'codex' && CODEX_FAST_MODELS.has(route.model || route.id);
}

export function needsCodexBridge(model) {
  return !!model && !isNativeModel('codex', model);
}

function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Foreign (non-codex-native) models REQUIRE the proxy bridge. `viaProxy` ALSO forces it for codex's own
// native models (gpt-5.x) — so a session can run gpt-5.5 through the fleet's ChatGPT account (e.g. when
// the operator's personal Codex usage limit is hit) instead of the native ~/.codex login.
export function codexProviderArgs(model, viaProxy = false) {
  if (!viaProxy && !needsCodexBridge(model)) return [];
  const provider = `{name=${tomlString('Supercalm Proxy')},base_url=${tomlString(AIOS_CLI_PROXY_V1_BASE)},env_key=${tomlString('AIOS_PROXY_API_KEY')},wire_api=${tomlString('responses')}}`;
  return ['-c', 'model_provider=aios_proxy', '-c', `model_providers.aios_proxy=${provider}`];
}

export function toolEnv(tool, model, viaProxy = false) {
  if (tool === 'codex' && (viaProxy || needsCodexBridge(model))) return { AIOS_PROXY_API_KEY };
  return {};
}

export function cleanModelId(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 160 || /[\r\n]/.test(s)) return null;
  return s;
}
