// Credential persistence + token lifecycle for the auth package. Atomic chmod-600 files at each
// provider's proxy-shared path. For `refreshable` providers (claude) it does single-flight,
// defensive refresh (re-read + recheck before spending the rotating single-use refresh token, so
// a concurrent writer that already rotated it is adopted rather than racing). codex/antigravity
// are login-only here (their CLI/proxy own refresh) → we read + write, never refresh.

import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { getProvider } from './providers.js';

const EXPIRY_SKEW_MS = 5 * 60_000;

const cache = new Map(); // pid -> { cred, at }
const inFlight = new Map(); // pid -> Promise

export async function readCred(pid) {
  const p = getProvider(pid);
  let raw;
  try {
    raw = await fs.readFile(p.credPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const cred = JSON.parse(raw);
    return p.accessToken(cred) ? cred : null;
  } catch {
    return null;
  }
}

export async function writeCred(pid, cred) {
  const p = getProvider(pid);
  await writeCredAt(p.credPath, cred);
  cache.set(pid, { cred, at: Date.now() });
  return cred;
}

export async function writeCredAt(path, cred) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  await fs.rename(tmp, path);
  return cred;
}

function isExpired(p, cred) {
  const exp = p.expiresAt(cred);
  if (typeof exp !== 'number') return true;
  return Date.now() + EXPIRY_SKEW_MS >= exp;
}

function refreshOnce(pid, { force = false } = {}) {
  if (inFlight.has(pid)) return inFlight.get(pid);
  const p = getProvider(pid);
  const job = (async () => {
    const cred = await readCred(pid);
    if (!cred) throw new Error(`${pid}: not logged in`);
    if (!p.refreshable) return cred; // login-only providers never refresh here
    if (!force && !isExpired(p, cred)) {
      cache.set(pid, { cred, at: Date.now() });
      return cred;
    }
    const updated = await p.refresh(cred);
    return writeCred(pid, updated);
  })().finally(() => inFlight.delete(pid));
  inFlight.set(pid, job);
  return job;
}

// Current valid access token for a provider (refreshes single-flight if near expiry + refreshable).
export async function getAccessToken(pid) {
  const p = getProvider(pid);
  let cred = cache.get(pid)?.cred || (await readCred(pid));
  if (!cred) throw new Error(`${pid}: not logged in`);
  if (p.refreshable && isExpired(p, cred)) cred = await refreshOnce(pid);
  return { accessToken: p.accessToken(cred), expiresAt: p.expiresAt(cred) };
}

export async function forceRefresh(pid) {
  const cred = await refreshOnce(pid, { force: true });
  return { accessToken: getProvider(pid).accessToken(cred) };
}

export async function loggedIn(pid) {
  return !!(cache.get(pid)?.cred || (await readCred(pid)));
}

export async function status(pid, { includeExtra = true } = {}) {
  const p = getProvider(pid);
  const cred = cache.get(pid)?.cred || (await readCred(pid));
  if (!cred) return { loggedIn: false };
  const s = p.status(cred);
  let extra = {};
  if (includeExtra && typeof p.extraStatus === 'function') {
    const extras = {};
    for (const path of p.extraCredPaths || []) {
      try {
        extras[path] = JSON.parse(await fs.readFile(path, 'utf8'));
      } catch {
        extras[path] = null;
      }
    }
    extra = (await p.extraStatus(extras, cred)) || {};
  }
  const merged = { ...s, ...extra };
  return { ...merged, credPath: p.credPath, expiresInSec: merged.expiresAt ? Math.max(0, Math.round((merged.expiresAt - Date.now()) / 1000)) : null };
}

export async function logout(pid) {
  cache.delete(pid);
  const p = getProvider(pid);
  const paths = [p.credPath, ...(p.extraCredPaths || [])];
  for (const path of paths) {
    try {
      await fs.unlink(path);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { ok: true };
}

// Proactively keep a refreshable provider's token fresh during idle (so the first session
// request after a quiet stretch isn't blocked on a token exchange). Caller starts it only when
// Supercalm is the active owner (proxy absent) so we never refresh a file the proxy also refreshes.
const loops = new Map();
export function startRefreshLoop(pid, intervalMs = 10 * 60_000) {
  if (loops.has(pid) || !getProvider(pid).refreshable) return;
  const t = setInterval(() => { getAccessToken(pid).catch(() => {}); }, intervalMs);
  if (t.unref) t.unref();
  loops.set(pid, t);
}
export function stopRefreshLoop(pid) {
  const t = loops.get(pid);
  if (t) { clearInterval(t); loops.delete(pid); }
}
