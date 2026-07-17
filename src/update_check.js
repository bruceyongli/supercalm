// Upstream update check — tells a self-hosted install when a NEWER Supercalm release exists on GitHub,
// so operators aren't stuck on old builds just because nothing reminds them. Complements (does not
// replace) web/version-badge.js's local check: the badge's fast /api/version poll detects "my own server
// restarted with a newer build → reload the page"; THIS module detects "the project shipped a newer
// release than my server is running → run bin/update", surfaced by the same badge as a GitHub link.
//
// Privacy: one anonymous HTTPS GET to api.github.com per interval (default 12h) — no identifiers beyond
// your IP, same as `git fetch`. Disable entirely with AIOS_UPDATE_CHECK=0; point forks at their own repo
// with AIOS_UPDATE_REPO=owner/name. Fail-open: network errors just mean "no update info".

import { VERSION, ROOT, DATA_DIR } from './config.js';
import { route, json } from './server.js';
import { gitOut } from './git.js';
import { chatJson } from './llm.js';
import { execFile, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';

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

// ---- one-click apply --------------------------------------------------------
// POST /api/update/apply runs bin/update (ff-only pull + npm install + restart THIS checkout's service)
// as a detached child logging to data/update.log. On success the service restarts itself, the badge's
// /api/version poll sees the new build, and the existing reload toast finishes the flow — so the whole
// upgrade is one click in the UI. canApply gates the button server-side (must be a clean git clone).
const apply = { running: false, lastRun: null }; // lastRun: {at, ok, error, from}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}
async function canApply() {
  if (await git(['rev-parse', '--is-inside-work-tree']) === null) return { ok: false, reason: 'not a git clone' };
  if (await git(['remote', 'get-url', 'origin']) === null) return { ok: false, reason: 'no origin remote' };
  const dirty = await git(['status', '--porcelain']);
  if (dirty === null) return { ok: false, reason: 'git unavailable' };
  if (dirty.trim()) return { ok: false, reason: 'local changes present — run bin/update manually' };
  return { ok: true, reason: '' };
}

function startApply() {
  const log = openSync(join(DATA_DIR, 'update.log'), 'a');
  const child = spawn('bash', [join(ROOT, 'bin', 'update')], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
  apply.running = true;
  child.on('exit', (code) => {
    // Only reached when the updater did NOT restart us (already up to date, or it failed).
    apply.running = false;
    apply.lastRun = { at: Date.now(), ok: code === 0, error: code === 0 ? '' : `bin/update exited ${code} — see data/update.log`, from: VERSION };
  });
  child.on('error', (e) => {
    apply.running = false;
    apply.lastRun = { at: Date.now(), ok: false, error: String(e.message || e), from: VERSION };
  });
  child.unref();
}

async function payload() {
  const upd = state.latest && cmpVersion(state.latest.version, VERSION) > 0 ? state.latest : null;
  const can = upd ? await canApply() : { ok: false, reason: '' };
  return { ok: true, current: VERSION, enabled: ENABLED, repo: REPO, checkedAt: state.checkedAt, update: upd, canApply: can.ok, canApplyReason: can.reason, applying: apply.running, lastRun: apply.lastRun };
}

route('GET', '/api/update', async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  json(res, 200, await payload());
});

// "What changed" between two deployed versions, for the new-version toast — cleaned commit subjects
// (conventional-commit prefix stripped, release-bumps + chores dropped, deduped) + a GitHub compare URL
// for the full detail. Fail-soft: any git error → empty list (the toast keeps its generic hint).
const verOf = (v) => { const m = String(v || '').match(/^v?(\d+\.\d+\.\d+)$/); return m ? m[1] : null; };
function cleanSubject(s) {
  let d = String(s).replace(/^\w+(\([^)]*\))?!?:\s*/, ''); // drop "type(scope): "
  d = d.split(/\s+[—(]/)[0].trim().replace(/[.;,]+$/, ''); // drop parentheticals / em-dash tails + trailing punct
  d = d.charAt(0).toUpperCase() + d.slice(1);
  if (d.length > 56) d = d.slice(0, 56).replace(/\s+\S*$/, '') + '…'; // word-boundary truncate, no mid-word cuts
  return d;
}
// Distill the raw commit subjects into a SHORT, user-facing summary via a cheap model (what a person would
// notice: "UI improvements", "Faster voice replies"). Fail-soft: any error → null (caller uses the raw list).
async function distillChanges(rawSubjects) {
  if (!rawSubjects.length) return null;
  try {
    const { obj } = await chatJson([
      { role: 'system', content: 'Turn these git commit subjects into a SHORT release note for END USERS. Output ONLY JSON: {"changes":["...","..."]} — 3 to 5 items, each a plain non-technical phrase a user would recognize (e.g. "UI improvements", "Voice replies in history", "Bug fixes"). Group related commits; drop internal/dev-only noise. Title Case, no trailing punctuation, max ~36 chars each.' },
      { role: 'user', content: rawSubjects.slice(0, 40).join('\n') },
    ]);
    const items = Array.isArray(obj?.changes) ? obj.changes.map((x) => String(x || '').trim().replace(/[.;,]+$/, '').slice(0, 44)).filter(Boolean).slice(0, 5) : null;
    return items && items.length ? items : null;
  } catch { return null; }
}
const _changeCache = new Map(); // `${from}..${to}` -> { body, at }
route('GET', '/api/changes', async (req, res, params, url) => {
  res.setHeader('cache-control', 'no-store');
  const from = verOf(url.searchParams.get('from'));
  const to = verOf(url.searchParams.get('to')) || VERSION;
  const compare = from && to && from !== to ? `https://github.com/${REPO}/compare/v${from}...v${to}` : `https://github.com/${REPO}/releases`;
  if (!from || !to || from === to) return json(res, 200, { ok: true, from, to, changes: [], total: 0, url: compare });
  const key = from + '..' + to;
  const hit = _changeCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return json(res, 200, { ...hit.body, url: compare });
  const raw = [];
  const out = await gitOut(ROOT, ['log', `v${from}..v${to}`, '--no-merges', '--format=%s'], { timeout: 4000 });
  if (!out.error) {
    const seen = new Set();
    for (const line of out.text.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (/^release: v/i.test(line) || /^chore(\(|:)/i.test(line)) continue;
      const d = cleanSubject(line); const k = d.toLowerCase();
      if (d && !seen.has(k)) { seen.add(k); raw.push(d); }
    }
  }
  const distilled = await distillChanges(raw);
  const body = { ok: true, from, to, changes: (distilled && distilled.length) ? distilled : raw.slice(0, 6), total: raw.length, distilled: !!distilled };
  _changeCache.set(key, { body, at: Date.now() });
  json(res, 200, { ...body, url: compare });
});
route('POST', '/api/update/check', async (req, res) => {
  await checkNow();
  json(res, 200, await payload());
});
route('POST', '/api/update/apply', async (req, res) => {
  if (apply.running) return json(res, 409, { ok: false, error: 'update already running' });
  const upd = state.latest && cmpVersion(state.latest.version, VERSION) > 0 ? state.latest : null;
  if (!upd) return json(res, 400, { ok: false, error: 'no newer release known — POST /api/update/check first' });
  const can = await canApply();
  if (!can.ok) return json(res, 400, { ok: false, error: can.reason });
  startApply();
  json(res, 200, { ok: true, started: true, to: upd.version });
});

if (ENABLED) {
  setTimeout(() => checkNow().catch(() => {}), 20_000); // off the boot path
  setInterval(() => checkNow().catch(() => {}), CHECK_MS).unref?.();
}
