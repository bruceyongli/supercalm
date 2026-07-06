// Provider registry for the standalone auth package. One entry per CLI whose login Supercalm can
// drive from its dashboard, faithfully matching the proxy fleet's flows so a credential minted
// here is a DROP-IN for the proxy (same file paths + scopes + on-disk shape). Independent
// re-implementation of ~/proxy/{claude,codex,antigravity}/src/oauthLogin.js (read-only ref;
// that fleet is off-limits to edit). Pure config + flow functions — NO file I/O or caching
// (that's store.js), NO Supercalm-server coupling. Each provider is a dashboard "paste" flow: the
// browser lands on a localhost/callback page that won't load, and the user copies the `code`.

import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeAgyCli } from './agy_cli.js';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function newPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  return { verifier, challenge, state };
}

function decodeJwt(token) {
  const seg = String(token).split('.')[1];
  if (!seg) throw new Error('malformed JWT');
  const pad = seg.length % 4 ? '='.repeat(4 - (seg.length % 4)) : '';
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8'));
}

// Pull the auth `code` (+ `state`) out of a pasted bare code, CODE#STATE, query string, or full URL.
function parseCodeState(input) {
  const s = String(input ?? '').trim();
  if (!s) return { code: '', state: '' };
  if (s.includes('://') || s.includes('code=')) {
    try {
      const u = new URL(s.includes('://') ? s : `http://x/?${s.replace(/^\?/, '')}`);
      const code = u.searchParams.get('code');
      if (code) return { code, state: u.searchParams.get('state') ?? '' };
    } catch {
      const m = /[?&]code=([^&\s]+)/.exec(s);
      if (m) return { code: decodeURIComponent(m[1]), state: '' };
    }
  }
  const [code, state = ''] = s.split('#');
  return { code, state };
}

async function postToken(url, params, json = false) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(params) : new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('token endpoint returned non-JSON');
  }
}

const env = (k, d) => process.env[k] ?? d;

// ── claude (Anthropic OAuth, PKCE, JSON token body) ─────────────────────────────────
const claude = {
  id: 'claude',
  label: 'Claude Code',
  color: '#d08770',
  pkce: true,
  // Supercalm shares the proxy's credential path + scopes so ONE login serves Supercalm sessions AND the
  // proxy. Respect the proxy's own env overrides (CLAUDE_CREDS_*); AIOS_* still wins for a split.
  credPath:
    env('AIOS_CLAUDE_CREDS_FILE') ??
    env('CLAUDE_CREDS_FILE') ??
    join(env('AIOS_CLAUDE_CREDS_DIR') ?? env('CLAUDE_CREDS_DIR') ?? join(homedir(), '.claude-proxy'), 'oauth_creds.json'),
  serves: 'claude', // an Anthropic shim serves sessions this token (claude can't take a creds-file path cleanly)
  refreshable: true,
  clientId: env('CLAUDE_OAUTH_CLIENT_ID', '9d1c250a-e61b-44d9-88ed-5944d1962f5e'),
  scope: env('CLAUDE_OAUTH_SCOPE', 'org:create_api_key user:profile user:inference'),
  authorizeUrl: env('CLAUDE_OAUTH_AUTHORIZE_URL', 'https://claude.com/cai/oauth/authorize'),
  tokenUrl: env('CLAUDE_OAUTH_TOKEN_URL', 'https://platform.claude.com/v1/oauth/token'),
  redirectUri: env('CLAUDE_OAUTH_REDIRECT_URI', 'https://platform.claude.com/oauth/code/callback'),
  buildAuthUrl({ challenge, state }) {
    const p = new URLSearchParams({
      code: 'true', client_id: this.clientId, response_type: 'code', redirect_uri: this.redirectUri,
      scope: this.scope, code_challenge: challenge, code_challenge_method: 'S256', state,
    });
    return `${this.authorizeUrl}?${p}`;
  },
  parse: parseCodeState,
  async exchange(code, { verifier, state }) {
    const tok = await postToken(this.tokenUrl, {
      grant_type: 'authorization_code', code, redirect_uri: this.redirectUri,
      client_id: this.clientId, code_verifier: verifier, state,
    }, true);
    if (!tok.access_token || !tok.refresh_token) throw new Error('missing access/refresh token');
    return this.toCred(tok);
  },
  async refresh(cred) {
    const c = cred.claudeAiOauth;
    const tok = await postToken(this.tokenUrl, { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: this.clientId });
    return this.toCred(tok, cred);
  },
  toCred(tok, prev) {
    const p = prev?.claudeAiOauth || {};
    return { claudeAiOauth: {
      accessToken: tok.access_token ?? p.accessToken,
      refreshToken: tok.refresh_token ?? p.refreshToken,
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
      scopes: tok.scope ? tok.scope.split(' ') : (p.scopes || this.scope.split(' ')),
      subscriptionType: tok.subscription_type ?? tok.account?.subscription_type ?? p.subscriptionType ?? null,
    } };
  },
  accessToken: (cred) => cred?.claudeAiOauth?.accessToken,
  expiresAt: (cred) => cred?.claudeAiOauth?.expiresAt,
  status(cred) {
    const c = cred?.claudeAiOauth;
    if (!c?.accessToken) return { loggedIn: false };
    return { loggedIn: true, expiresAt: c.expiresAt || null, scopes: c.scopes || [], subscriptionType: c.subscriptionType || null, account: c.subscriptionType || null };
  },
};

// ── codex (ChatGPT OAuth, PKCE, form token body) ────────────────────────────────────
const codex = {
  id: 'codex',
  label: 'Codex',
  color: '#88c0d0',
  pkce: true,
  // ~/.codex/auth.json IS the Codex CLI default — so a login here works for codex sessions AND
  // the proxy directly; both refresh it themselves (OpenAI tokens tolerate sharing) → Supercalm is
  // login-only here (refreshable:false, no shim).
  credPath: env('AIOS_CODEX_AUTH_FILE') ?? join(env('CODEX_HOME') ?? join(homedir(), '.codex'), 'auth.json'),
  serves: null,
  refreshable: false,
  clientId: env('CODEX_OAUTH_CLIENT_ID', 'app_EMoamEEZ73f0CkXaXp7hrann'),
  scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  authorizeUrl: env('CODEX_OAUTH_AUTHORIZE_URL', 'https://auth.openai.com/oauth/authorize'),
  tokenUrl: env('CODEX_OAUTH_TOKEN_URL', 'https://auth.openai.com/oauth/token'),
  redirectUri: env('CODEX_OAUTH_REDIRECT_URI', 'http://localhost:1455/auth/callback'),
  buildAuthUrl({ challenge, state }) {
    const p = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri, scope: this.scope,
      code_challenge: challenge, code_challenge_method: 'S256', id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true', state, originator: 'codex_cli_rs',
    });
    return `${this.authorizeUrl}?${p}`;
  },
  parse: (input) => ({ code: parseCodeState(input).code, state: '' }),
  async exchange(code, { verifier }, prev) {
    const tok = await postToken(this.tokenUrl, {
      grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, client_id: this.clientId, code_verifier: verifier,
    });
    if (!tok.access_token || !tok.refresh_token) throw new Error('missing access/refresh token');
    const accountId = tok.id_token ? this._accountId(tok.id_token) : null;
    if (!accountId) throw new Error('could not derive account_id from id_token');
    // preserve a real OPENAI_API_KEY if the existing file had one
    const OPENAI_API_KEY = prev && 'OPENAI_API_KEY' in prev ? prev.OPENAI_API_KEY : null;
    return { OPENAI_API_KEY, tokens: { id_token: tok.id_token, access_token: tok.access_token, refresh_token: tok.refresh_token, account_id: accountId }, last_refresh: new Date().toISOString() };
  },
  _accountId(idToken) {
    try {
      const a = decodeJwt(idToken)['https://api.openai.com/auth'] ?? {};
      return a.chatgpt_account_id ?? a.organization_id ?? null;
    } catch { return null; }
  },
  accessToken: (cred) => cred?.tokens?.access_token,
  expiresAt: (cred) => { try { return decodeJwt(cred.tokens.access_token).exp * 1000; } catch { return null; } },
  status(cred) {
    const t = cred?.tokens;
    if (!t?.access_token) return { loggedIn: false };
    let expiresAt = null, account = t.account_id || null;
    try { expiresAt = decodeJwt(t.access_token).exp * 1000; } catch {}
    return { loggedIn: true, expiresAt, account, scopes: [] };
  },
};

// ── antigravity (Google OAuth, client_secret, NO PKCE, form token body) ─────────────
const antigravity = {
  id: 'antigravity',
  label: 'Antigravity',
  color: '#b48ead',
  pkce: false,
  // Supercalm can mint the proxy credential because that flow is stable and file-backed. The `agy` CLI
  // keeps its own session in native keyring or its SSH token store; its private on-disk store is not
  // the Gemini CLI oauth_creds.json shape, so status is verified by probing `agy` itself.
  credPath: env('AIOS_AG_CREDS_FILE') ?? join(env('AG_CREDS_DIR') ?? join(homedir(), '.antigravity-proxy'), 'oauth_creds.json'),
  get extraCredPaths() { return []; },
  serves: null,
  refreshable: false,
  clientId: env('AG_CLIENT_ID', ''),
  clientSecret: env('AG_CLIENT_SECRET', ''),
  scope: [
    'openid',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ].join(' '),
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userinfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json',
  redirectUri: env('AG_REDIRECT_URI', 'http://localhost:51121/oauth-callback'),
  buildAuthUrl({ state }) {
    const p = new URLSearchParams({
      access_type: 'offline', client_id: this.clientId, prompt: 'consent', redirect_uri: this.redirectUri,
      response_type: 'code', scope: this.scope, state,
    });
    return `${this.authorizeUrl}?${p}`;
  },
  parse: (input) => ({ code: parseCodeState(input).code, state: '' }),
  async exchange(code) {
    const tok = await postToken(this.tokenUrl, {
      code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code',
    });
    if (!tok.refresh_token) throw new Error('no refresh_token (code expired/reused — generate a fresh link)');
    if (!tok.id_token) throw new Error('no id_token returned — generate a fresh Antigravity login link and approve the OpenID consent');
    let email = null;
    try {
      const r = await fetch(this.userinfoUrl, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (r.ok) email = (await r.json()).email ?? null;
    } catch {}
    const expiry = Date.now() + (tok.expires_in ?? 3600) * 1000;
    const scope = tok.scope || this.scope;
    return {
      cred: { access_token: tok.access_token, refresh_token: tok.refresh_token, expiry, email },
      scopes: scope.split(/\s+/).filter(Boolean),
    };
  },
  accessToken: (cred) => cred?.access_token,
  expiresAt: (cred) => cred?.expiry ?? null,
  status(cred) {
    if (!cred?.access_token) return { loggedIn: false };
    return { loggedIn: true, expiresAt: cred.expiry || null, account: cred.email || null, scopes: [] };
  },
  async extraStatus(extras, cred) {
    const cli = await probeAgyCli();
    return {
      loggedIn: !!cred?.access_token && cli.loggedIn,
      proxyLoggedIn: !!cred?.access_token,
      cliLoggedIn: cli.loggedIn,
      cliStatus: cli.message,
      cliStatusDetail: cli.detail,
      cliCheckedAt: cli.checkedAt,
    };
  },
};

export const PROVIDERS = { claude, codex, antigravity };
export const PROVIDER_IDS = Object.keys(PROVIDERS);
export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown auth provider: ${id}`);
  return p;
}
