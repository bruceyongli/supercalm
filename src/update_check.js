// Upstream update check — tells a self-hosted install when a NEWER Supercalm release exists on GitHub,
// so operators aren't stuck on old builds just because nothing reminds them. Complements (does not
// replace) web/version-badge.js's local check: the badge's fast /api/version poll detects "my own server
// restarted with a newer build → reload the page"; THIS module detects "the project shipped a newer
// release than my server is running → run bin/update", surfaced by the same badge as a GitHub link.
//
// Privacy: one anonymous HTTPS GET to api.github.com per interval (default 12h) — no identifiers beyond
// your IP, same as `git fetch`. Disable entirely with AIOS_UPDATE_CHECK=0; point forks at their own repo
// with AIOS_UPDATE_REPO=owner/name. Fail-open: network errors just mean "no update info".

import { VERSION } from './config.js';
import { route, json } from './server.js';

const REPO = (process.env.AIOS_UPDATE_REPO || 'bruceyongli/supercalm').replace(/[^A-Za-z0-9_.\/-]/g, '');
const ENABLED = process.env.AIOS_UPDATE_CHECK !== '0';
const CHECK_MS = Math.max(15 * 60 * 1000, Number(process.env.AIOS_UPDATE_CHECK_MS || 12 * 60 * 60 * 1000));

import { cmpVersion, parseLatest } from './update_core.js';

const state = { latest: null, checkedAt: 0, error: '' };

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'supercalm-update-check', ...headers }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function checkNow() {
  if (!ENABLED) return state;
  try {
    // Releases are the source of truth (tag + human notes). Fallback: main's package.json — covers a
    // repo that tags/pushes without creating GitHub Releases.
    let latest = null;
    try {
      latest = parseLatest('release', await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`, { accept: 'application/vnd.github+json' }), REPO);
    } catch { /* no releases yet / rate-limited -> fallback */ }
    if (!latest) latest = parseLatest('package', await fetchJson(`https://raw.githubusercontent.com/${REPO}/main/package.json`), REPO);
    state.latest = latest;
    state.error = '';
  } catch (e) {
    state.error = String(e.message || e).slice(0, 120); // fail-open: keep the last good result
  }
  state.checkedAt = Date.now();
  return state;
}

function payload() {
  const upd = state.latest && cmpVersion(state.latest.version, VERSION) > 0 ? state.latest : null;
  return { ok: true, current: VERSION, enabled: ENABLED, repo: REPO, checkedAt: state.checkedAt, update: upd };
}

route('GET', '/api/update', (req, res) => {
  res.setHeader('cache-control', 'no-store');
  json(res, 200, payload());
});
route('POST', '/api/update/check', async (req, res) => {
  await checkNow();
  json(res, 200, payload());
});

if (ENABLED) {
  setTimeout(() => checkNow().catch(() => {}), 20_000); // off the boot path
  setInterval(() => checkNow().catch(() => {}), CHECK_MS).unref?.();
}
