// HTTP API for Supercalm-managed auth across providers (claude/codex/antigravity): overall status
// (claude's active mode + each provider's login), the dashboard OAuth login (start -> open
// authorize URL -> paste the code -> complete), logout, and manual refresh. Thin adapter over the
// standalone ./auth package + authmode.js; self-registers routes via server.js's route().

import { route, json, readJson } from './server.js';
import { listProviders, startLogin, completeLogin, logout, forceRefresh, status, getProvider } from './auth/index.js';
import { authStatus, probeProxy } from './authmode.js';

// Overall status: claude's active auth mode + proxy reachability + every provider's login state.
// Stale-while-revalidate: the provider probes are slow (`agy models` alone runs ~4s) and made EVERY
// /api/auth/status call — the settings/auth pages' first paint — stall ~5s. Serve the last snapshot
// instantly and refresh in the background; login/logout/refresh invalidate so changes show promptly.
const AUTH_STATUS_TTL_MS = Number(process.env.AIOS_AUTH_STATUS_TTL_MS || 30000);
let authStatusCache = { ts: 0, data: null };
let authStatusInflight = null;
function refreshAuthStatus() {
  if (authStatusInflight) return authStatusInflight;
  authStatusInflight = (async () => {
    const base = await authStatus();
    const providers = await Promise.all(
      listProviders().map(async (p) => ({ ...p, ...(await status(p.id)) }))
    );
    authStatusCache = { ts: Date.now(), data: { ...base, providers } };
  })().finally(() => { authStatusInflight = null; });
  return authStatusInflight;
}
function invalidateAuthStatus() { authStatusCache = { ts: 0, data: authStatusCache.data }; }

route('GET', '/api/auth/status', async (req, res) => {
  try {
    if (!authStatusCache.data) await refreshAuthStatus();
    else if (Date.now() - authStatusCache.ts > AUTH_STATUS_TTL_MS) refreshAuthStatus().catch(() => {});
    json(res, 200, authStatusCache.data);
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

route('POST', '/api/auth/probe', async (req, res) => {
  json(res, 200, { proxyUp: await probeProxy({ force: true }) });
});

// Begin a login: mint the authorize URL to open in a browser.
route('POST', '/api/auth/:provider/start', async (req, res, params) => {
  try {
    getProvider(params.provider); // validate
    json(res, 200, startLogin(params.provider));
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) });
  }
});

// Finish a login: exchange the pasted code for tokens, persist to the proxy-shared path.
route('POST', '/api/auth/:provider/complete', async (req, res, params) => {
  try {
    const body = await readJson(req);
    const code = String(body?.code || '').trim();
    if (!code) return json(res, 400, { error: 'missing code' });
    const done = await completeLogin(params.provider, code, body?.nonce);
    invalidateAuthStatus();
    json(res, 200, done);
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) });
  }
});

// Manual refresh — only meaningful for refreshable providers (claude) Supercalm owns. When the proxy
// is present it owns the shared credential's refresh, so defer to avoid racing the rotating token.
route('POST', '/api/auth/:provider/refresh', async (req, res, params) => {
  try {
    const p = getProvider(params.provider);
    if (!p.refreshable) return json(res, 400, { error: `${p.id} refresh is managed by its CLI/proxy` });
    if (params.provider === 'claude' && (await probeProxy())) {
      return json(res, 200, { ok: true, deferred: true, note: 'proxy is active and owns refresh' });
    }
    await forceRefresh(params.provider);
    invalidateAuthStatus();
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) });
  }
});

// Logout. Guard claude when the proxy is active + shares this file: deleting it would break the
// proxy, so refuse and point the user at the proxy dashboard.
route('POST', '/api/auth/:provider/logout', async (req, res, params) => {
  try {
    getProvider(params.provider);
    if (params.provider === 'claude' && (await probeProxy())) {
      return json(res, 409, { error: 'the proxy is active and shares this credential — manage it via the proxy dashboard so the proxy keeps working' });
    }
    const out = await logout(params.provider);
    invalidateAuthStatus();
    json(res, 200, out);
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) });
  }
});

// Pre-warm the snapshot off the boot path so even the FIRST settings/auth page load paints instantly.
setTimeout(() => refreshAuthStatus().catch(() => {}), 3000);

console.log('[aios] auth api active (claude/codex/antigravity)');
