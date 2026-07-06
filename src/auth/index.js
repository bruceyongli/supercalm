// Public surface of the standalone auth package. Self-contained: depends only on its own
// providers/store/shim — NO Supercalm server/config coupling, so it can later be promoted to a
// standalone daemon and consumed by the proxy/CLIs unchanged. Supercalm uses it in-process today
// (authmode.js decides WHEN it's the active owner; this package is the owner mechanics).

import { PROVIDERS, PROVIDER_IDS, getProvider, newPkce } from './providers.js';
import * as store from './store.js';

export { PROVIDER_IDS, getProvider } from './providers.js';
export { getAccessToken, forceRefresh, loggedIn, status, logout, startRefreshLoop } from './store.js';
export { ensureShim, baseUrl as shimUrl, shimRunning } from './shim.js';

export function listProviders() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return { id, label: p.label, color: p.color, serves: p.serves, refreshable: p.refreshable, account: null };
  });
}

// pending login flows: nonce -> { pid, pkce, at }. Short-lived one-shot paste flows; reap >15min.
const pending = new Map();
function reap() {
  const cut = Date.now() - 15 * 60_000;
  for (const [k, v] of pending) if (v.at < cut) pending.delete(k);
}

// Begin a login: mint PKCE/state, return the authorize URL to open in a browser.
export function startLogin(pid) {
  reap();
  const p = getProvider(pid);
  const pkce = newPkce(); // {verifier, challenge, state} — antigravity ignores verifier/challenge
  pending.set(pkce.state, { pid, pkce, at: Date.now() });
  return { nonce: pkce.state, authorizeUrl: p.buildAuthUrl(pkce) };
}

// Finish a login: exchange the pasted CODE (or CODE#STATE / full URL) for tokens, persist them.
export async function completeLogin(pid, input, nonce) {
  const p = getProvider(pid);
  const { code, state } = p.parse(input);
  if (!code) throw new Error('no authorization code provided');
  let entry = (state && pending.get(state)) || (nonce && pending.get(nonce));
  if (!entry) {
    const mine = [...pending.values()].filter((e) => e.pid === pid);
    if (mine.length === 1) entry = mine[0];
  }
  if (!entry || entry.pid !== pid) throw new Error('no matching login in progress — click "Log in" again');
  const prev = await store.readCred(pid).catch(() => null);
  const exchanged = await p.exchange(code, entry.pkce, prev);
  const cred = exchanged?.cred || exchanged;
  await store.writeCred(pid, cred);
  for (const extra of exchanged?.extraCreds || []) await store.writeCredAt(extra.path, extra.cred);
  pending.delete(entry.pkce.state);
  return { ok: true, ...(await store.status(pid)) };
}
