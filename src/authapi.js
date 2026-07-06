// HTTP API for Supercalm-managed auth across providers (claude/codex/antigravity): overall status
// (claude's active mode + each provider's login), the dashboard OAuth login (start -> open
// authorize URL -> paste the code -> complete), logout, and manual refresh. Thin adapter over the
// standalone ./auth package + authmode.js; self-registers routes via server.js's route().

import { route, json, readJson } from './server.js';
import { listProviders, startLogin, completeLogin, logout, forceRefresh, status, getProvider } from './auth/index.js';
import { authStatus, probeProxy } from './authmode.js';

// Overall status: claude's active auth mode + proxy reachability + every provider's login state.
route('GET', '/api/auth/status', async (req, res) => {
  try {
    const base = await authStatus();
    const providers = await Promise.all(
      listProviders().map(async (p) => ({ ...p, ...(await status(p.id)) }))
    );
    json(res, 200, { ...base, providers });
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
    json(res, 200, await completeLogin(params.provider, code, body?.nonce));
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
    json(res, 200, await logout(params.provider));
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) });
  }
});

console.log('[aios] auth api active (claude/codex/antigravity)');
