// Autonomous integrate-&-deploy — the PUBLISHER (docs/specs/autonomous-deploy-plan.md steps 4 + the
// APPROVED→GREEN drive). Takes an APPROVED integration (candidate already rebased onto main + gated by
// integrator.js) and ships it to the live service, then proves it green — surviving the self-deploy
// restart via the durable state machine, NEVER a detached child owning truth.
//
// The one hard rule (plan §"the principle"): merge, deploy, and health are SEPARATE persisted states;
// "the process returned" is NOT green. So:
//   drivePublish() : APPROVED → PUBLISHING → MAIN_PUBLISHED → RESTART_REQUESTED, then spawns a DETACHED
//                    exact-SHA `bin/deploy` and returns. That deploy ff's main→candidate, pushes, and
//                    restarts THIS server — killing us. We do NOT verify here (we still serve the OLD
//                    sha; our own probes would be false).
//   reconcile()    : runs in the REBORN process on boot (after integrations.js recoverOnBoot bumped the
//                    fence). If this newly-deployed server now serves the candidate → walk to VERIFYING.
//   verifyLoop()   : sustained health — served-SHA === candidate AND a read→write→read DB smoke, N
//                    CONSECUTIVE successes before GREEN. Past the deadline without that → HELD (step 5
//                    turns HELD-after-publish into auto-rollback; for now a human resolves). One success
//                    is never green.
//
// GATED: the whole path is inert unless AIOS_AUTO_PUBLISH is on (default OFF) — auto-deploying the live
// service is the highest-risk action, so it ships proven-but-off and the operator flips the capability.
// servedSha / spawnDeploy are injectable so the flow is testable without touching the live service.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { COMMIT_SHA, BOOT_ID } from './config.js';
import { gitOut } from './git.js';
import { defaultBranch } from './worktrees.js';
import { now } from './util.js';
import { db } from './store.js';
import * as store from './store.js';
import * as I from './integrations.js';

// Thresholds (read once at load; tests set env before importing). Defaults leave generous room for the
// restart to happen (RESTART_GRACE) plus a real soak (WINDOW); the deadline persisted on the row = both.
const PROBE_MS = Number(process.env.AIOS_VERIFY_PROBE_MS || 5000);
const SUCCESSES = Number(process.env.AIOS_VERIFY_SUCCESSES || 12);        // ~1min of consecutive health at 5s
const WINDOW_MS = Number(process.env.AIOS_VERIFY_WINDOW_MS || 180000);    // soak budget after the server is up
const RESTART_GRACE_MS = Number(process.env.AIOS_VERIFY_RESTART_MS || 300000); // budget for deploy+restart to serve the candidate

// The capability switch. Off by default — nothing auto-deploys the live service until an operator turns
// this on. (A future project-scope check will also require multi-session isolation to be enabled.)
export function publishEnabled() {
  const v = String(process.env.AIOS_AUTO_PUBLISH || '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(v);
}

const defaultServed = () => COMMIT_SHA;
// Full-vs-full sha compare, tolerant of short/long on either side.
function shaEq(a, b) { if (!a || !b) return false; return a === b || a.startsWith(b) || b.startsWith(a); }

// The real deploy: a DETACHED, stdio-ignored exact-SHA `bin/deploy` that outlives our restart. Absolute
// path (Node resolves a relative command against process.cwd, NOT opts.cwd — a classic footgun).
function defaultSpawnDeploy(repoPath, candidateSha) {
  const child = spawn(join(repoPath, 'bin', 'deploy'), [], {
    cwd: repoPath,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AIOS_DEPLOY_SHA: candidateSha },
  });
  child.unref();
  return child.pid || null;
}

// read→write→read DB smoke: prove the WAL write path works on the reborn server (not just that it booted).
function dbSmoke(intId) {
  try {
    const marker = 'smoke_' + now() + '_' + Math.round(performance.now());
    I.recordProbe(intId, { bootId: BOOT_ID, status: 'smoke', detail: marker });
    const back = db.prepare('SELECT detail FROM health_probes WHERE integration_id=? AND detail=? ORDER BY id DESC LIMIT 1').get(intId, marker);
    return !!back && back.detail === marker;
  } catch { return false; }
}

function safeHold(intId, fenceToken, code, data) {
  try { return I.transition(intId, 'HELD', { fenceToken, patch: { failure_code: code }, data }); }
  catch (e) { console.error('[aios] publisher safeHold failed:', e?.message || e); return null; }
}

// APPROVED → RESTART_REQUESTED (+ spawn the deploy). Everything up to the spawn is fenced state-machine
// intent persisted BEFORE the irreversible push. Returns the row at RESTART_REQUESTED (or HELD on a
// precondition failure). The restart itself kills us; reconcile() finishes the job on the other side.
export async function drivePublish(integrationId, opts = {}) {
  const { fenceToken, servedSha = defaultServed, spawnDeploy = defaultSpawnDeploy } = opts;
  const it = I.getIntegration(integrationId);
  if (!it) throw new Error('no such integration: ' + integrationId);
  if (it.stage !== 'APPROVED') throw new Error('drivePublish requires APPROVED (got ' + it.stage + ')');
  const ft = fenceToken ?? it.fence_token;

  // Capability gate — refuse (park as HELD so it's visible, never silently deploy) when off.
  if (!publishEnabled()) return I.transition(integrationId, 'HELD', { fenceToken: ft, patch: { failure_code: 'publish_disabled' }, data: { note: 'AIOS_AUTO_PUBLISH is off — autonomous publish refused' } });

  const project = it.project_id ? store.getProject(it.project_id) : null;
  const repoPath = project?.path;
  const candidate = it.candidate_sha;
  if (!repoPath || !existsSync(repoPath) || !candidate) return I.transition(integrationId, 'HELD', { fenceToken: ft, patch: { failure_code: 'no_repo_or_candidate' }, data: { repoPath, candidate } });

  // PUBLISHING — persist intent + the health deadline BEFORE any mutation (plan §1 intent/result).
  I.transition(integrationId, 'PUBLISHING', { fenceToken: ft, patch: { deploy_started_at: now(), health_deadline: now() + RESTART_GRACE_MS + WINDOW_MS }, data: { candidate } });

  // Clean fast-forward only: current main must be an ancestor of the candidate. If main moved since the
  // gate rebased (a human push; single-active blocks another integration), the candidate is stale → HELD.
  const base = await defaultBranch(repoPath);
  const mainSha = (await gitOut(repoPath, ['rev-parse', base])).text.trim();
  const ffOk = !!mainSha && !(await gitOut(repoPath, ['merge-base', '--is-ancestor', mainSha, candidate])).error;
  if (!ffOk) return safeHold(integrationId, ft, 'not_fast_forward', { base, mainSha, candidate });

  I.transition(integrationId, 'MAIN_PUBLISHED', { fenceToken: ft, patch: { base_sha: mainSha }, data: { base, mainSha } });
  I.transition(integrationId, 'RESTART_REQUESTED', { fenceToken: ft, data: { preBootId: BOOT_ID, candidate } });

  let pid = null;
  try { pid = spawnDeploy(repoPath, candidate); }
  catch (e) { return safeHold(integrationId, ft, 'deploy_spawn_failed', { error: String(e?.message || e) }); }
  I.recordProbe(integrationId, { bootId: BOOT_ID, servedSha: servedSha(), status: 'deploy_spawned', detail: 'pid=' + pid });
  return I.getIntegration(integrationId);
}

// Walk the linear publish path forward to VERIFYING, one legal fenced step at a time (used when a boot
// finds the reborn server already serving the candidate from an earlier stage). Re-reads the fence each
// step; an illegal jump just stops the walk.
function walkToVerifying(intId) {
  const order = ['PUBLISHING', 'MAIN_PUBLISHED', 'RESTART_REQUESTED', 'VERIFYING'];
  for (let guard = 0; guard < 6; guard++) {
    const cur = I.getIntegration(intId);
    if (!cur || cur.stage === 'VERIFYING') return cur;
    const idx = order.indexOf(cur.stage);
    if (idx < 0 || idx >= order.length - 1) return cur; // not on the publish path
    try { I.transition(intId, order[idx + 1], { fenceToken: cur.fence_token, data: { reconcileWalk: true } }); }
    catch { return I.getIntegration(intId); }
  }
  return I.getIntegration(intId);
}

const _verifying = new Set(); // one soak loop per integration
// Sustained health. GREEN only after SUCCESSES CONSECUTIVE good probes (served-SHA===candidate AND DB
// read→write→read) inside the persisted deadline. A stale fence (a newer boot took over) stops us.
export function verifyLoop(intId, { fenceToken, servedSha = defaultServed } = {}) {
  if (_verifying.has(intId)) return;
  _verifying.add(intId);
  let consecutive = 0;
  const done = () => _verifying.delete(intId);
  const tick = async () => {
    const it = I.getIntegration(intId);
    if (!it || it.stage !== 'VERIFYING') return done();
    if (it.fence_token !== fenceToken) return done(); // fenced out — a boot recovery owns it now
    let ok = false, detail = '';
    try {
      const servedOk = shaEq(servedSha(), it.candidate_sha);
      const dbOk = dbSmoke(intId);
      ok = servedOk && dbOk;
      detail = `served=${servedOk} db=${dbOk}`;
    } catch (e) { detail = 'probe error: ' + String(e?.message || e); }
    I.recordProbe(intId, { bootId: BOOT_ID, servedSha: servedSha(), status: ok ? 'ok' : 'fail', detail });
    I.heartbeat(intId, fenceToken);
    consecutive = ok ? consecutive + 1 : 0;
    if (consecutive >= SUCCESSES) { try { I.transition(intId, 'GREEN', { fenceToken, data: { probes: consecutive, detail } }); } catch (e) { console.error('[aios] publisher GREEN failed:', e?.message || e); } return done(); }
    if (now() > it.health_deadline) { safeHold(intId, fenceToken, 'health_timeout', { consecutive, needed: SUCCESSES, detail }); return done(); }
    const t = setTimeout(() => { tick().catch(() => done()); }, PROBE_MS);
    if (t.unref) t.unref();
  };
  tick().catch(() => done());
}

let _ticker = null;
function scheduleTicker(servedSha) {
  if (_ticker) return;
  _ticker = setTimeout(() => { _ticker = null; reconcile({ servedSha }).catch((e) => console.error('[aios] publisher ticker:', e?.message || e)); }, PROBE_MS);
  if (_ticker.unref) _ticker.unref();
}

// Resume an in-flight publish after a (re)boot. integrations.js recoverOnBoot has already bumped the
// fence + stamped this boot as owner; here we decide, from the SERVED sha, whether the deploy took
// effect. Only touches the publish/verify stages (rollback = step 5, gate = integrator.js).
export async function reconcile(opts = {}) {
  const { servedSha = defaultServed } = opts;
  const it = I.occupiedBy();
  if (!it) return { integration: null };
  if (!['PUBLISHING', 'MAIN_PUBLISHED', 'RESTART_REQUESTED', 'VERIFYING'].includes(it.stage)) return { integration: it, skipped: it.stage };
  const ft = it.fence_token;

  if (it.stage === 'VERIFYING') { verifyLoop(it.id, { fenceToken: ft, servedSha }); return { integration: it, resumed: 'VERIFYING' }; }

  if (shaEq(servedSha(), it.candidate_sha)) {
    // The reborn server IS the candidate — the deploy landed. Soak it before calling it green.
    walkToVerifying(it.id);
    const cur = I.getIntegration(it.id);
    if (cur.stage === 'VERIFYING') verifyLoop(it.id, { fenceToken: cur.fence_token, servedSha });
    return { integration: I.getIntegration(it.id), resumed: 'served->VERIFYING' };
  }
  // Not serving the candidate yet: deploy still running, or it failed before restarting. Past deadline →
  // HELD (no false green — a deploy that never served the candidate is a failure). Else re-check soon.
  if (now() > it.health_deadline) { safeHold(it.id, ft, 'deploy_not_served', { served: servedSha(), candidate: it.candidate_sha }); return { integration: I.getIntegration(it.id), held: true }; }
  scheduleTicker(servedSha);
  return { integration: it, waiting: true };
}

export { shaEq };

// On boot (every deploy restarts us), resume any in-flight publish. Deferred so listen/store settle;
// skipped under AIOS_NO_LISTEN (unit tests drive reconcile() explicitly). Fail-safe: never block boot.
if (!process.env.AIOS_NO_LISTEN) {
  const t = setTimeout(() => { reconcile().catch((e) => console.error('[aios] publisher boot reconcile:', e?.message || e)); }, 1500);
  if (t.unref) t.unref();
}
