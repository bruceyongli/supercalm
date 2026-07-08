// Supercalm-side adapter: decide WHERE a claude session's auth comes from, per launch. This is the
// only auth glue that's Supercalm-specific (it knows about the proxy fleet + session launching); the
// actual login/refresh/serving lives in the standalone ./auth package. Order:
//   1. AIOS_CLAUDE_BASE_URL set to a URL  -> use it verbatim (pin a specific proxy)
//   2. AIOS_CLAUDE_BASE_URL == ''         -> force the CLI's own ~/.claude login
//   3. (unset) external proxy reachable   -> route through it          (host today)
//   4. (unset) Supercalm has its own login     -> route through the local shim (auth/shim.js)
//   5. (unset) otherwise                  -> the CLI's own ~/.claude login
// Supercalm only becomes the refresher (shim + refresh loop) in mode 4 — when no proxy is present —
// so it never races the proxy on the shared rotating refresh token.

import { loggedIn, status, ensureShim, shimUrl, shimRunning, startRefreshLoop } from './auth/index.js';
import { AIOS_CLI_PROXY_BASE, fleetKey, modelDisplayLabel, routeForModel } from './model_catalog.js';

const PIN = process.env.AIOS_CLAUDE_BASE_URL; // undefined | '' | url
const PROXY_URL = process.env.AIOS_CLAUDE_PROXY_URL || 'http://127.0.0.1:8789';
const PROBE_TTL_MS = Number(process.env.AIOS_PROXY_PROBE_TTL || 45_000);

// Token the claude CLI presents to its base URL. Supercalm's own cli-proxy ignores it, but a
// PIN pointed straight at a fleet port needs the real fleet key (the fleet checks it).
async function sessionToken() {
  return process.env.AIOS_CLAUDE_KEY || fleetKey();
}

const probeCache = new Map();

async function probeUrl(url, { force = false } = {}) {
  const now = Date.now();
  const cached = probeCache.get(url);
  if (!force && cached && now - cached.at < PROBE_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1200) });
    ok = res.status > 0;
  } catch {
    ok = false;
  }
  probeCache.set(url, { ok, at: now });
  return ok;
}

async function claudeGatewayEnv(baseUrl, { model = null, route = null } = {}) {
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: await sessionToken(),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };
  if (model && route?.proxy !== 'claude') {
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = model;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = modelDisplayLabel(model) || model;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = route?.providerLabel
      ? `Supercalm routed model via ${route.providerLabel}`
      : 'Supercalm routed model';
  }
  return env;
}

// Is the external proxy endpoint for this model up? Cached so we don't probe every launch.
export async function probeProxy({ force = false, model = null } = {}) {
  if (model) {
    const r = routeForModel(model);
    return probeUrl(`http://127.0.0.1:${r.port}/v1/models`, { force });
  }
  return probeUrl(PROXY_URL + '/', { force });
}

import { listProviders as listApiProviders } from './model_providers.js';

// Resolve the env to inject into a claude tmux launch + the mode label.
export async function resolveClaudeEnv({ model = null } = {}) {
  if (PIN !== undefined) {
    if (PIN === '') return { env: {}, mode: 'cli' };
    return { env: await claudeGatewayEnv(PIN, { model, route: model ? routeForModel(model) : null }), mode: 'pinned' };
  }
  const route = model ? routeForModel(model) : null;
  if (route && route.proxy !== 'claude') {
    return { env: await claudeGatewayEnv(AIOS_CLI_PROXY_BASE, { model, route }), mode: 'proxy' };
  }
  if (await probeProxy({ model })) {
    return { env: await claudeGatewayEnv(AIOS_CLI_PROXY_BASE, { model, route }), mode: 'proxy' };
  }
  if (await loggedIn('claude')) {
    let url = shimUrl();
    try {
      url = await ensureShim();
      startRefreshLoop('claude'); // Supercalm owns refresh only here (no proxy to contend with)
    } catch (e) {
      console.error('[aios] claude shim failed to start:', e.message);
    }
    return { env: await claudeGatewayEnv(url, { model, route }), mode: 'aios' };
  }
// 4.5) a user-configured anthropic-kind API provider (Auth & Models page): serve claude sessions
  // directly from it — the no-fleet, no-OAuth path most external users start with. api.anthropic.com
  // needs only the key (the CLI's default base); custom bases get ANTHROPIC_BASE_URL too.
  const prov = apiProviderForClaude();
  if (prov) {
    const env = { ANTHROPIC_API_KEY: prov.api_key };
    if (!/api\.anthropic\.com$/.test(new URL(prov.base_url).hostname)) env.ANTHROPIC_BASE_URL = prov.base_url;
    return { env, mode: 'api' };
  }
  return { env: {}, mode: 'cli' };
}

function apiProviderForClaude() {
  try {
    return listApiProviders({ redact: false }).find((p) => p.enabled && p.kind === 'anthropic' && p.api_key) || null;
  } catch { return null; }
}

// claude auth mode (for the status badge), without launching anything.
export async function claudeMode() {
  const proxyUp = await probeProxy();
  if (PIN !== undefined) return { mode: PIN === '' ? 'cli' : 'pinned', proxyUp };
  if (proxyUp) return { mode: 'proxy', proxyUp };
  if (await loggedIn('claude')) return { mode: 'aios', proxyUp };
  if (apiProviderForClaude()) return { mode: 'api', proxyUp };
  return { mode: 'cli', proxyUp };
}

// Overall auth status for the dashboard: claude's active mode + every provider's login state.
export async function authStatus() {
  const { mode, proxyUp } = await claudeMode();
  return {
    mode,
    proxyUp,
    pinned: PIN || null,
    shimRunning: shimRunning(),
    shimUrl: shimUrl(),
    proxyUrl: PROXY_URL,
    cliProxyUrl: AIOS_CLI_PROXY_BASE,
    login: await status('claude'), // back-compat: claude login details
  };
}
