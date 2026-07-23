// RELEASE-HEALTH MONITOR — general, project-agnostic detection of a deploy that didn't take.
//
// The 2026-07-17 OpenHand incident: a Pages deploy went out from the wrong tree and served the OLD UI for
// THREE DAYS undetected. The agent's own #1 lesson was "every deploy day ends with a live-bundle version
// +marker verification." This makes that CONTINUOUS and automatic for ANY project: declare a live URL + a
// marker that must be present when the current product is live, and AIOS polls it and alerts on drift.
//
// Design (docs/specs/deploy-safety-general.md): one declarative per-project `release_targets` row feeds
// this monitor (detection) AND the deploy-source guardrail (prevention, separate module). Nothing here is
// project-specific — the project declares its own truth. Fail-open: a checker error never crashes the loop.
import { db } from './store.js';
import * as store from './store.js';
import { bus } from './bus.js';
import { now } from './util.js';
import { route, json, readJson } from './server.js';
import { assertCompleteReleaseSource } from './release_contract.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS release_targets (
    project_id    TEXT PRIMARY KEY,
    enabled       INTEGER NOT NULL DEFAULT 1,
    live_url      TEXT NOT NULL DEFAULT '',   -- live surface to verify (prefer the DIRECT deployment URL over the CDN-cached custom domain)
    expect        TEXT NOT NULL DEFAULT '',   -- marker that MUST be present when the current product is live (substring, or /regex/flags)
    forbid        TEXT NOT NULL DEFAULT '',   -- optional marker that must NOT be present (e.g. an old-UI signature)
    source_dir    TEXT NOT NULL DEFAULT '',   -- canonical deploy tree (consumed by the deploy-source guardrail)
    source_branch TEXT NOT NULL DEFAULT '',   -- expected branch (consumed by the guardrail)
    interval_sec  INTEGER NOT NULL DEFAULT 900,
    last_status   TEXT,                        -- ok | stale | down | unknown
    last_detail   TEXT,
    last_value    TEXT,                        -- a short excerpt proving what we saw (the matched region)
    last_checked  INTEGER,
    fail_streak   INTEGER NOT NULL DEFAULT 0,  -- consecutive bad checks (debounce)
    alerted       INTEGER NOT NULL DEFAULT 0,  -- 1 once we've notified for the current bad episode
    updated_at    TEXT
  )
`);

const CHECK_DEBOUNCE = Number(process.env.AIOS_RELEASE_DEBOUNCE || 2); // consecutive bad checks before alerting
const FETCH_TIMEOUT_MS = Number(process.env.AIOS_RELEASE_TIMEOUT_MS || 12000);
const READ_CAP = 512 * 1024; // never read more than 512KB of a live response
const LOOP_MS = 30_000;
const MONITOR_ON = process.env.AIOS_RELEASE_MONITOR !== '0';

const _get = db.prepare('SELECT * FROM release_targets WHERE project_id = ?');
const _all = db.prepare('SELECT * FROM release_targets');
const _upsert = db.prepare(`INSERT INTO release_targets
  (project_id,enabled,live_url,expect,forbid,source_dir,source_branch,interval_sec,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(project_id) DO UPDATE SET
    enabled=excluded.enabled, live_url=excluded.live_url, expect=excluded.expect, forbid=excluded.forbid,
    source_dir=excluded.source_dir, source_branch=excluded.source_branch, interval_sec=excluded.interval_sec,
    updated_at=excluded.updated_at`);
const _status = db.prepare(`UPDATE release_targets SET last_status=?, last_detail=?, last_value=?, last_checked=?, fail_streak=?, alerted=? WHERE project_id=?`);

export function getTarget(projectId) { return _get.get(projectId) || null; }
export function listTargets() { return _all.all(); }
// Consumed by the deploy-source guardrail (Slice 2) — the declared canonical deploy tree/branch.
export function deployContract(projectId) {
  const t = _get.get(projectId);
  if (!t || (!t.source_dir && !t.source_branch)) return null;
  try {
    assertCompleteReleaseSource(t.source_dir, t.source_branch);
  } catch (cause) {
    const e = new Error('release source contract requires both source_dir and source_branch');
    e.code = 'invalid-release-source-contract';
    e.cause = cause;
    throw e;
  }
  return { source_dir: t.source_dir, source_branch: t.source_branch };
}

export function setTarget(projectId, patch = {}) {
  const cur = getTarget(projectId) || { enabled: 1, live_url: '', expect: '', forbid: '', source_dir: '', source_branch: '', interval_sec: 900 };
  const clampInt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 60 ? Math.min(n, 86400) : d; };
  const next = {
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
    live_url: patch.live_url !== undefined ? String(patch.live_url).trim().slice(0, 500) : cur.live_url,
    expect: patch.expect !== undefined ? String(patch.expect).slice(0, 300) : cur.expect,
    forbid: patch.forbid !== undefined ? String(patch.forbid).slice(0, 300) : cur.forbid,
    source_dir: patch.source_dir !== undefined ? String(patch.source_dir).trim().slice(0, 500) : cur.source_dir,
    source_branch: patch.source_branch !== undefined ? String(patch.source_branch).trim().slice(0, 200) : cur.source_branch,
    interval_sec: patch.interval_sec !== undefined ? clampInt(patch.interval_sec, cur.interval_sec) : cur.interval_sec,
  };
  // http(s) only; reject anything else so the checker can't be pointed at a file:// or odd scheme.
  if (next.live_url && !/^https?:\/\//i.test(next.live_url)) throw new Error('live_url must be http(s)://');
  assertCompleteReleaseSource(next.source_dir, next.source_branch);
  _upsert.run(projectId, next.enabled, next.live_url, next.expect, next.forbid, next.source_dir, next.source_branch, next.interval_sec, now());
  return getTarget(projectId);
}

// A marker matches if the body contains the substring (case-insensitive) or matches a /regex/flags form.
function markerMatch(body, marker) {
  if (!marker) return { hit: false, at: -1 };
  const rx = /^\/(.+)\/([a-z]*)$/i.exec(marker);
  if (rx) {
    try { const re = new RegExp(rx[1], rx[2].includes('i') ? rx[2] : rx[2] + 'i'); const m = re.exec(body); return { hit: !!m, at: m ? m.index : -1 }; }
    catch { /* bad regex -> fall through to substring */ }
  }
  const at = body.toLowerCase().indexOf(marker.toLowerCase());
  return { hit: at >= 0, at };
}

// Fetch the live surface with a cache-buster + no-store (edge-cache gotcha), a hard timeout, and a read cap.
async function fetchLive(url) {
  const bust = url + (url.includes('?') ? '&' : '?') + '_aios=' + now();
  const res = await fetch(bust, { headers: { 'cache-control': 'no-store', pragma: 'no-cache', 'user-agent': 'supercalm-release-monitor' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let body = '';
  try {
    const reader = res.body?.getReader?.();
    if (reader) {
      const dec = new TextDecoder(); let n = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; body += dec.decode(value, { stream: true }); if (n >= READ_CAP) { try { await reader.cancel(); } catch {} break; } }
    } else { body = (await res.text()).slice(0, READ_CAP); }
  } catch { /* keep whatever we read */ }
  return { ok: res.ok, status: res.status, body };
}

// One check → classify ok|stale|down, debounce, alert-once on the bad edge, note recovery.
export async function checkTarget(projectId, { force = false } = {}) {
  const t = getTarget(projectId);
  if (!t || !t.enabled || !t.live_url) return null;
  const proj = store.getProject(projectId);
  let status = 'ok', detail = '', value = '';
  try {
    const r = await fetchLive(t.live_url);
    if (!r.ok) { status = 'down'; detail = `HTTP ${r.status}`; }
    else {
      const exp = t.expect ? markerMatch(r.body, t.expect) : { hit: true, at: -1 };
      const forb = t.forbid ? markerMatch(r.body, t.forbid) : { hit: false, at: -1 };
      if (!exp.hit) { status = 'stale'; detail = `expected marker not found: ${t.expect.slice(0, 60)}`; }
      else if (forb.hit) { status = 'stale'; detail = `forbidden marker present: ${t.forbid.slice(0, 60)}`; }
      else { status = 'ok'; detail = 'live surface current'; if (exp.at >= 0) value = r.body.slice(Math.max(0, exp.at - 12), exp.at + 48).replace(/\s+/g, ' ').trim(); }
    }
  } catch (e) { status = 'down'; detail = String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 120); }

  const bad = status !== 'ok';
  const wasBad = (t.last_status && t.last_status !== 'ok') ? 1 : 0;
  let streak = bad ? (t.fail_streak || 0) + 1 : 0;
  let alerted = t.alerted;
  if (bad && streak >= CHECK_DEBOUNCE && !t.alerted) {
    alerted = 1;
    const name = proj?.name || projectId;
    bus.emit('notify', {
      title: `Release check failed: ${name}`,
      body: `${name} live surface is ${status.toUpperCase()} — ${detail}. Check the deploy (right tree/branch?) at ${t.live_url}`,
      url: 'projects',
      tag: `release-${projectId}`,
    });
    console.error(`[aios] release ${projectId} (${name}): ${status.toUpperCase()} — ${detail} @ ${t.live_url}`);
  }
  if (!bad && wasBad && t.alerted) { // recovered
    alerted = 0;
    console.log(`[aios] release ${projectId}: recovered (${detail})`);
    bus.emit('notify', { title: `Release recovered: ${proj?.name || projectId}`, body: `${t.live_url} is serving the current product again.`, url: 'projects', tag: `release-${projectId}` });
  }
  _status.run(status, detail, value, now(), streak, alerted, projectId);
  bus.emit('changed');
  return { project_id: projectId, status, detail, value, live_url: t.live_url, checked_at: now(), fail_streak: streak };
}

async function tick() {
  if (!MONITOR_ON) return;
  for (const t of listTargets()) {
    if (!t.enabled || !t.live_url) continue;
    if (t.last_checked && now() - t.last_checked < (t.interval_sec * 1000)) continue;
    try { await checkTarget(t.project_id); } catch (e) { console.error('[aios] release tick error', t.project_id, e.message); }
  }
}

// ---- routes ----------------------------------------------------------------
const view = (t, proj) => t ? { project_id: t.project_id, enabled: !!t.enabled, live_url: t.live_url, expect: t.expect, forbid: t.forbid, source_dir: t.source_dir, source_branch: t.source_branch, interval_sec: t.interval_sec, last_status: t.last_status || 'unknown', last_detail: t.last_detail || '', last_value: t.last_value || '', last_checked: t.last_checked || 0, project: proj ? { id: proj.id, name: proj.name } : null } : null;

route('GET', '/api/project/:id/release', (req, res, { id }) => {
  const proj = store.getProject(id);
  if (!proj) return json(res, 404, { error: 'no such project' });
  json(res, 200, { ok: true, target: view(getTarget(id), proj) || { project_id: id, enabled: true, live_url: '', expect: '', forbid: '', source_dir: '', source_branch: '', interval_sec: 900, last_status: 'unknown', project: { id: proj.id, name: proj.name } } });
});

route('POST', '/api/project/:id/release', async (req, res, { id }) => {
  const proj = store.getProject(id);
  if (!proj) return json(res, 404, { error: 'no such project' });
  const b = await readJson(req).catch(() => ({}));
  try { const t = setTarget(id, b); json(res, 200, { ok: true, target: view(t, proj) }); }
  catch (e) { json(res, 400, { error: e.message }); }
});

route('POST', '/api/project/:id/release/check', async (req, res, { id }) => {
  const proj = store.getProject(id);
  if (!proj) return json(res, 404, { error: 'no such project' });
  const r = await checkTarget(id, { force: true });
  if (!r) return json(res, 400, { error: 'no live_url configured for this project' });
  json(res, 200, { ok: true, result: r, target: view(getTarget(id), proj) });
});

// Fleet overview — every configured target + its live status (for a dashboard/projects list).
route('GET', '/api/release', (req, res) => {
  const out = listTargets().filter((t) => t.live_url).map((t) => view(t, store.getProject(t.project_id)));
  json(res, 200, { ok: true, targets: out });
});

if (MONITOR_ON) {
  setTimeout(() => tick().catch(() => {}), 15_000); // first sweep off the boot path
  setInterval(() => tick().catch((e) => console.error('[aios] release loop', e.message)), LOOP_MS).unref?.();
}
