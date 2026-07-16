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
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { COMMIT_SHA, BOOT_ID, VERSION, DATA_DIR } from './config.js';
import { gitOut } from './git.js';
import { defaultBranch } from './worktrees.js';
import { now } from './util.js';
import { db } from './store.js';
import * as store from './store.js';
import * as I from './integrations.js';
import { helperEnabled } from './project_helpers.js';
import { PROTECTED } from './integrator.js';

const short = (s, n = 300) => String(s || '').slice(-n);

// Thresholds (read once at load; tests set env before importing). Defaults leave generous room for the
// restart to happen (RESTART_GRACE) plus a real soak (WINDOW); the deadline persisted on the row = both.
const PROBE_MS = Number(process.env.AIOS_VERIFY_PROBE_MS || 5000);
const SUCCESSES = Number(process.env.AIOS_VERIFY_SUCCESSES || 12);        // ~1min of consecutive health at 5s
const WINDOW_MS = Number(process.env.AIOS_VERIFY_WINDOW_MS || 180000);    // soak budget after the server is up
const RESTART_GRACE_MS = Number(process.env.AIOS_VERIFY_RESTART_MS || 300000); // budget for deploy+restart to serve the candidate

// The capability switch — PER-PROJECT (project_helpers.auto_publish, toggled in the Projects view), with the
// AIOS_AUTO_PUBLISH env as a fleet-wide hard kill-switch/override (helperEnabled honors it). Off by default:
// no project auto-deploys the live service until an operator turns it on for THAT project.
export function publishEnabled(projectId) {
  return helperEnabled(projectId, 'autoPublish');
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
  // Spawn failures (ENOENT/EACCES — bin/deploy missing or unexecutable) arrive ASYNC on a detached
  // child; unhandled they throw uncaughtException (crashes the test harness outright — the
  // publisher.test flake — and on the live daemon the deploy silently never runs while the global
  // guard eats the error). Log it; the health deadline then HOLDs the integration (deploy_not_served),
  // which is the designed no-false-green outcome.
  child.on('error', (e) => console.error('[aios] deploy spawn failed:', e?.message || e));
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

  // Capability gate — refuse (park as HELD so it's visible, never silently deploy) when this PROJECT's
  // autonomous deploy is off.
  if (!publishEnabled(it.project_id)) return I.transition(integrationId, 'HELD', { fenceToken: ft, patch: { failure_code: 'publish_disabled' }, data: { note: "project's autonomous deploy is off — publish refused" } });

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

  // previous_green_sha = the main that was live before this deploy — the forward-revert target if we roll back.
  I.transition(integrationId, 'MAIN_PUBLISHED', { fenceToken: ft, patch: { base_sha: mainSha, previous_green_sha: mainSha }, data: { base, mainSha } });
  I.transition(integrationId, 'RESTART_REQUESTED', { fenceToken: ft, data: { preBootId: BOOT_ID, candidate } });

  let pid = null;
  try { pid = spawnDeploy(repoPath, candidate); }
  catch (e) { return safeHold(integrationId, ft, 'deploy_spawn_failed', { error: String(e?.message || e) }); }
  I.recordProbe(integrationId, { bootId: BOOT_ID, servedSha: servedSha(), status: 'deploy_spawned', detail: 'pid=' + pid });
  return I.getIntegration(integrationId);
}

// The two deploy "episodes" share one shape (RESTART-like → VERIFYING-like → terminal), differing only in
// which sha must be served + the stage names. Parameterizing lets ONE verifyLoop/reconcile drive both the
// forward publish (→ GREEN) and the rollback (→ ROLLED_BACK).
const FORWARD = { path: ['PUBLISHING', 'MAIN_PUBLISHED', 'RESTART_REQUESTED', 'VERIFYING'], verify: 'VERIFYING', success: 'GREEN', sha: (it) => it.candidate_sha, kind: 'forward' };
const ROLLBACK = { path: ['ROLLING_BACK', 'ROLLBACK_PUBLISHED', 'ROLLBACK_RESTART_REQUESTED', 'ROLLBACK_VERIFYING'], verify: 'ROLLBACK_VERIFYING', success: 'ROLLED_BACK', sha: (it) => it.rollback_sha, kind: 'rollback' };
function episodeOf(stage) { if (FORWARD.path.includes(stage)) return FORWARD; if (ROLLBACK.path.includes(stage)) return ROLLBACK; return null; }

// Walk an episode's linear path forward to its verify stage, one legal fenced step at a time (used when a
// boot finds the reborn server already serving the expected sha from an earlier stage). Re-reads the fence
// each step; an illegal jump just stops the walk.
function walkTo(intId, targetStage, path) {
  for (let guard = 0; guard < 8; guard++) {
    const cur = I.getIntegration(intId);
    if (!cur || cur.stage === targetStage) return cur;
    const idx = path.indexOf(cur.stage), tgt = path.indexOf(targetStage);
    if (idx < 0 || tgt < 0 || idx >= tgt) return cur;
    try { I.transition(intId, path[idx + 1], { fenceToken: cur.fence_token, data: { walk: true } }); }
    catch { return I.getIntegration(intId); }
  }
  return I.getIntegration(intId);
}

// After an autonomous deploy bumps the version, the served HEAD sits one trusted release commit ABOVE the
// tested candidate, so served===candidate no longer holds. Verify instead that the candidate is an ANCESTOR
// of the served HEAD — it is provably in the deployed history; the only delta is bin/version's package.json
// bump. repoPath = the project repo; served = the running server's HEAD sha.
async function servedHasCandidate(repoPath, expected, served) {
  if (!expected || !served) return false;
  if (expected === served) return true;               // fast path (no-bump deploys / tests)
  if (!repoPath) return false;
  return !(await gitOut(repoPath, ['merge-base', '--is-ancestor', expected, served])).error;
}
const repoOf = (it) => (it?.project_id ? store.getProject(it.project_id)?.path : null) || null;

// A soaked-GREEN autonomous deploy IS a stable release — it passed the full gate AND health-verified live in
// production. Bless it: write the stable marker for the running version so `config.releaseChannel()` returns
// 'stable' and the new-version toast fires even for "stable only" viewers (routine `bin/deploy` dev pushes
// stay 'every'). LOCAL marker only — no public GitHub Release (that stays the maintainer's `bin/release`).
function blessStable() {
  try { writeFileSync(join(DATA_DIR, 'release_channel.json'), JSON.stringify({ version: VERSION, channel: 'stable', at: new Date().toISOString() }) + '\n'); }
  catch (e) { console.error('[aios] blessStable failed:', e?.message || e); }
}

const _verifying = new Set(); // one soak loop per integration
// Sustained health for an episode. Its success stage only after SUCCESSES CONSECUTIVE good probes (served-SHA
// === the episode's expected sha AND a read→write→read DB smoke) inside the persisted deadline. A stale fence
// (a newer boot took over) stops us. On deadline: forward → auto-rollback (if safe) else HELD; rollback →
// HELD (a rollback that can't go green needs a human).
export function verifyLoop(intId, { fenceToken, servedSha = defaultServed, spawnDeploy = defaultSpawnDeploy, episode = FORWARD } = {}) {
  if (_verifying.has(intId)) return;
  _verifying.add(intId);
  let consecutive = 0;
  const done = () => _verifying.delete(intId);
  const tick = async () => {
    const it = I.getIntegration(intId);
    if (!it || it.stage !== episode.verify) return done();
    if (it.fence_token !== fenceToken) return done(); // fenced out — a boot recovery owns it now
    let ok = false, detail = '';
    try {
      const servedOk = await servedHasCandidate(repoOf(it), episode.sha(it), servedSha());
      const dbOk = dbSmoke(intId);
      ok = servedOk && dbOk;
      detail = `served=${servedOk} db=${dbOk}`;
    } catch (e) { detail = 'probe error: ' + String(e?.message || e); }
    I.recordProbe(intId, { bootId: BOOT_ID, servedSha: servedSha(), status: ok ? 'ok' : 'fail', detail });
    I.heartbeat(intId, fenceToken);
    consecutive = ok ? consecutive + 1 : 0;
    if (consecutive >= SUCCESSES) { try { I.transition(intId, episode.success, { fenceToken, data: { probes: consecutive, detail, episode: episode.kind } }); blessStable(); } catch (e) { console.error('[aios] publisher ' + episode.success + ' failed:', e?.message || e); } return done(); }
    if (now() > it.health_deadline) { await onVerifyFail(intId, fenceToken, episode, { consecutive, detail, servedSha, spawnDeploy }); return done(); }
    const t = setTimeout(() => { tick().catch(() => done()); }, PROBE_MS);
    if (t.unref) t.unref();
  };
  tick().catch(() => done());
}

async function onVerifyFail(intId, ft, episode, ctx) {
  if (episode.kind === 'rollback') return safeHold(intId, ft, 'rollback_health_timeout', { consecutive: ctx.consecutive, detail: ctx.detail });
  // Forward publish couldn't sustain health → forward-revert auto-rollback if the change is safe, else HELD.
  try { await startRollback(intId, ft, ctx); }
  catch (e) { console.error('[aios] startRollback error:', e?.message || e); safeHold(intId, ft, 'rollback_error', { error: String(e?.message || e) }); }
}

// Forward-revert auto-rollback (plan §5): create a revert commit on main (NEVER reset/force), redeploy the
// previous-green state via the same exact-SHA path, and verify it through the SAME health window. Only for
// protected-path-clean changes (an APPROVED candidate is one by construction — the gate rejects schema/
// deploy/config edits); a protected diff, an empty diff, or a revert conflict → HELD for a human.
async function startRollback(intId, ft, { servedSha = defaultServed, spawnDeploy = defaultSpawnDeploy } = {}) {
  const it = I.getIntegration(intId);
  const project = it.project_id ? store.getProject(it.project_id) : null;
  const repoPath = project?.path;
  const target = it.previous_green_sha || it.base_sha;
  const candidate = it.candidate_sha;
  if (!repoPath || !existsSync(repoPath) || !target || !candidate) return safeHold(intId, ft, 'rollback_no_target', { target, candidate });
  const files = (await gitOut(repoPath, ['diff', '--name-only', `${target}..${candidate}`])).text.split('\n').filter(Boolean);
  if (!files.length) return safeHold(intId, ft, 'rollback_empty', { note: 'nothing to revert (target === candidate)' });
  if (files.some((f) => PROTECTED.some((rx) => rx.test(f)))) return safeHold(intId, ft, 'rollback_unsafe_protected', { files: files.slice(0, 20) });

  I.transition(intId, 'ROLLING_BACK', { fenceToken: ft, patch: { previous_green_sha: target, health_deadline: now() + RESTART_GRACE_MS + WINDOW_MS }, data: { target, reverting: files.length } });
  const base = await defaultBranch(repoPath);
  await gitOut(repoPath, ['checkout', base]);
  const rev = await gitOut(repoPath, ['revert', '--no-commit', `${target}..${candidate}`], { timeout: 30000 });
  if (rev.error) { await gitOut(repoPath, ['revert', '--abort']).catch(() => {}); await gitOut(repoPath, ['reset', '--hard', 'HEAD']).catch(() => {}); return safeHold(intId, I.getIntegration(intId).fence_token, 'rollback_conflict', { detail: short(rev.error) }); }
  const commit = await gitOut(repoPath, ['commit', '-m', `rollback: integration ${intId} not green — forward-revert to ${target.slice(0, 12)}`], { timeout: 15000 });
  if (commit.error) { await gitOut(repoPath, ['reset', '--hard', 'HEAD']).catch(() => {}); return safeHold(intId, I.getIntegration(intId).fence_token, 'rollback_commit_failed', { detail: short(commit.error) }); }
  const rollbackSha = (await gitOut(repoPath, ['rev-parse', 'HEAD'])).text.trim();
  I.transition(intId, 'ROLLBACK_PUBLISHED', { fenceToken: I.getIntegration(intId).fence_token, patch: { rollback_sha: rollbackSha }, data: { rollbackSha } });
  I.transition(intId, 'ROLLBACK_RESTART_REQUESTED', { fenceToken: I.getIntegration(intId).fence_token, data: { preBootId: BOOT_ID, rollbackSha } });
  let pid = null;
  try { pid = spawnDeploy(repoPath, rollbackSha); }
  catch (e) { return safeHold(intId, I.getIntegration(intId).fence_token, 'rollback_deploy_spawn_failed', { error: String(e?.message || e) }); }
  I.recordProbe(intId, { bootId: BOOT_ID, servedSha: servedSha(), status: 'rollback_deploy_spawned', detail: 'pid=' + pid });
  return I.getIntegration(intId);
}

let _ticker = null;
function scheduleTicker(opts) {
  if (_ticker) return;
  _ticker = setTimeout(() => { _ticker = null; reconcile(opts).catch((e) => console.error('[aios] publisher ticker:', e?.message || e)); }, PROBE_MS);
  if (_ticker.unref) _ticker.unref();
}

// Resume an in-flight publish OR rollback after a (re)boot. integrations.js recoverOnBoot has already bumped
// the fence + stamped this boot owner; here we decide, from the SERVED sha, whether the (forward or rollback)
// deploy took effect. Only touches the publish/rollback stages (gate = integrator.js).
export async function reconcile(opts = {}) {
  const { servedSha = defaultServed, spawnDeploy = defaultSpawnDeploy } = opts;
  const it = I.occupiedBy();
  if (!it) return { integration: null };
  const episode = episodeOf(it.stage);
  if (!episode) return { integration: it, skipped: it.stage };
  const ft = it.fence_token;

  if (it.stage === episode.verify) { verifyLoop(it.id, { fenceToken: ft, servedSha, spawnDeploy, episode }); return { integration: it, resumed: episode.verify }; }

  if (await servedHasCandidate(repoOf(it), episode.sha(it), servedSha())) {
    // The reborn server carries the expected sha (candidate is in its deployed history) — the deploy landed.
    // Soak it before calling it done.
    walkTo(it.id, episode.verify, episode.path);
    const cur = I.getIntegration(it.id);
    if (cur.stage === episode.verify) verifyLoop(it.id, { fenceToken: cur.fence_token, servedSha, spawnDeploy, episode });
    return { integration: I.getIntegration(it.id), resumed: 'served->' + episode.verify };
  }
  // Not serving the expected sha yet: deploy still running, or it failed before restarting. Past deadline →
  // HELD (no false green — a deploy that never served its target is a failure; ambiguous, so a human looks).
  if (now() > it.health_deadline) { safeHold(it.id, ft, episode.kind === 'forward' ? 'deploy_not_served' : 'rollback_deploy_not_served', { served: servedSha(), expected: episode.sha(it) }); return { integration: I.getIntegration(it.id), held: true }; }
  scheduleTicker({ servedSha, spawnDeploy });
  return { integration: it, waiting: true };
}

export { shaEq };

// On boot (every deploy restarts us), resume any in-flight publish/rollback. Deferred so listen/store settle;
// skipped under AIOS_NO_LISTEN (unit tests drive reconcile() explicitly). Fail-safe: never block boot.
if (!process.env.AIOS_NO_LISTEN) {
  const t = setTimeout(() => { reconcile().catch((e) => console.error('[aios] publisher boot reconcile:', e?.message || e)); }, 1500);
  if (t.unref) t.unref();
}
