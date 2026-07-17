// Autonomous integrate-&-deploy — the PUBLISHER (docs/specs/autonomous-deploy-plan.md step 4 / APPROVED→
// GREEN). Verifies drivePublish + reconcile + verifyLoop on a throwaway repo + scratch DB, with the deploy
// and served-SHA INJECTED so nothing touches the live service or restarts anything:
//   A) capability OFF  → refuses (HELD publish_disabled), never spawns a deploy
//   B) happy path      → fake deploy ff's main→candidate; the reborn server serves it → VERIFYING → GREEN
//   C) deploy no-serve → server never serves the candidate → deadline → HELD (never a false GREEN)
//   D) fencing         → a stale fence token cannot drive publish (throws; stage stays APPROVED)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Tiny, fast health thresholds + scratch dirs. Set BEFORE importing (read once at module load).
process.env.AIOS_NO_LISTEN = '1';               // no port bind + no auto boot-reconcile timer
process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'pub-db-'));
process.env.AIOS_WORKTREE_ROOT = mkdtempSync(join(tmpdir(), 'pub-wt-'));
process.env.AIOS_VERIFY_PROBE_MS = '15';
process.env.AIOS_VERIFY_SUCCESSES = '3';
process.env.AIOS_VERIFY_RESTART_MS = '800';   // generous headroom: the deadline is set at drivePublish but
process.env.AIOS_VERIFY_WINDOW_MS = '800';    // verify starts later (after the fake deploy runs), and a git
delete process.env.AIOS_AUTO_PUBLISH;           // capability starts OFF (case A)

const store = await import('../src/store.js');
const I = await import('../src/integrations.js');
const P = await import('../src/publisher.js');

const WRONG = '0'.repeat(40); // a served-SHA that is never the candidate

const repo = mkdtempSync(join(tmpdir(), 'pub-repo-'));
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
writeFileSync(join(repo, 'f'), 'base\n'); g('add', '.'); g('commit', '-qm', 'base');
const proj = store.createProject({ id: 'p_pub', name: 'pub', path: repo });

// A candidate commit on its own branch, a descendant of current main (leaves main checked out). Returns SHA.
function candidateCommit(branch, file) {
  g('checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(repo, file), branch + '\n'); g('add', '.'); g('commit', '-qm', branch);
  const sha = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  return sha;
}
// An APPROVED integration for the given candidate (walks the gate stages the deterministic gate would).
function approved(sha, branch) {
  const mainSha = g('rev-parse', 'main');
  const it = I.enqueue({ projectId: proj.id, sourceBranch: branch, candidateSha: sha, baseSha: mainSha });
  const ft = it.fence_token;
  I.transition(it.id, 'PREPARING', { fenceToken: ft });
  I.transition(it.id, 'CHECKING', { fenceToken: ft, patch: { candidate_sha: sha, base_sha: mainSha } });
  I.transition(it.id, 'APPROVED', { fenceToken: ft });
  return I.getIntegration(it.id);
}
// Free the pipeline between cases: drive any non-terminal integration to REJECTED (via HELD if needed).
function clear(id) {
  let r = I.getIntegration(id);
  if (I.TERMINAL.has(r.stage)) return;
  try { if (r.stage !== 'HELD') { I.transition(id, 'HELD', { fenceToken: r.fence_token }); r = I.getIntegration(id); } I.transition(id, 'REJECTED', { fenceToken: r.fence_token }); } catch {}
}
async function waitFor(id, stages, ms = 2500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = I.getIntegration(id); if (stages.includes(r.stage)) return r; await delay(10); }
  return I.getIntegration(id);
}

// A) capability OFF → HELD publish_disabled, and the deploy is NEVER spawned.
const cA = candidateCommit('cA', 'a.txt');
const iA = approved(cA, 'cA');
const rA = await P.drivePublish(iA.id, { servedSha: () => WRONG, spawnDeploy: () => { throw new Error('deploy must not run when disabled'); } });
assert.equal(rA.stage, 'HELD', 'gated off → HELD');
assert.equal(rA.failure_code, 'publish_disabled', 'failure_code publish_disabled');
clear(iA.id);

// Turn the capability ON for the rest.
process.env.AIOS_AUTO_PUBLISH = '1';
assert.equal(P.publishEnabled(), true, 'capability enabled');

// B) happy path: fake deploy ff's main→candidate; reborn server serves it → GREEN after N probes.
const cB = candidateCommit('cB', 'b.txt');
const iB = approved(cB, 'cB');
const fakeDeploy = (repoPath, sha) => { execFileSync('git', ['-C', repoPath, 'merge', '--ff-only', sha], { stdio: 'ignore' }); return 4242; };
const rB = await P.drivePublish(iB.id, { servedSha: () => WRONG, spawnDeploy: fakeDeploy });
assert.equal(rB.stage, 'RESTART_REQUESTED', 'happy path reaches RESTART_REQUESTED (got ' + rB.stage + '/' + rB.failure_code + ')');
assert.equal(g('rev-parse', 'main'), cB, 'fake deploy fast-forwarded main to the candidate');
await P.reconcile({ servedSha: () => cB, spawnDeploy: fakeDeploy }); // the reborn server now serves the candidate
const greenB = await waitFor(iB.id, ['GREEN', 'HELD', 'REJECTED']);
assert.equal(greenB.stage, 'GREEN', 'served candidate + sustained health → GREEN (got ' + greenB.stage + '/' + greenB.failure_code + ')');
const probes = I.eventsFor(iB.id).filter((e) => e.to_stage === 'GREEN');
assert.ok(probes.length === 1, 'exactly one GREEN transition');
clear(iB.id);

// C) deploy that never serves the candidate → deadline → HELD (no false green).
const cC = candidateCommit('cC', 'c.txt');
const iC = approved(cC, 'cC');
const rC = await P.drivePublish(iC.id, { servedSha: () => WRONG, spawnDeploy: () => 7 }); // deploy no-ops (never advances/serves)
assert.equal(rC.stage, 'RESTART_REQUESTED', 'reaches RESTART_REQUESTED');
await P.reconcile({ servedSha: () => WRONG, spawnDeploy: () => 0 }); // reborn server still serves the OLD sha
const heldC = await waitFor(iC.id, ['HELD', 'GREEN', 'REJECTED']);
assert.equal(heldC.stage, 'HELD', 'never-served deploy → HELD, never GREEN (got ' + heldC.stage + ')');
assert.equal(heldC.failure_code, 'deploy_not_served', 'failure_code deploy_not_served');
clear(iC.id);

// D) fencing: a stale fence token cannot drive publish; the row stays APPROVED (no partial transition).
const cD = candidateCommit('cD', 'd.txt');
const iD = approved(cD, 'cD');
await assert.rejects(
  () => P.drivePublish(iD.id, { fenceToken: 999, servedSha: () => WRONG, spawnDeploy: () => { throw new Error('must not deploy'); } }),
  /fenced out/, 'stale fence token is rejected',
);
assert.equal(I.getIntegration(iD.id).stage, 'APPROVED', 'no partial transition under a stale fence');
clear(iD.id);

// E) forward publish that lands but can't sustain health → forward-revert AUTO-ROLLBACK → ROLLED_BACK.
const mainBeforeE = g('rev-parse', 'main');           // the previous-green target
const cE = candidateCommit('cE', 'e.txt');
g('merge', '--ff-only', cE);                           // simulate the forward deploy landing (main → cE)
const iE = I.enqueue({ projectId: proj.id, sourceBranch: 'cE', candidateSha: cE, baseSha: mainBeforeE });
const ftE = iE.fence_token;
I.transition(iE.id, 'PREPARING', { fenceToken: ftE });
I.transition(iE.id, 'CHECKING', { fenceToken: ftE, patch: { candidate_sha: cE, base_sha: mainBeforeE } });
I.transition(iE.id, 'APPROVED', { fenceToken: ftE });
I.transition(iE.id, 'PUBLISHING', { fenceToken: ftE, patch: { deploy_started_at: 1, health_deadline: 1 } }); // deadline already past
I.transition(iE.id, 'MAIN_PUBLISHED', { fenceToken: ftE, patch: { base_sha: mainBeforeE, previous_green_sha: mainBeforeE } });
I.transition(iE.id, 'RESTART_REQUESTED', { fenceToken: ftE });
I.transition(iE.id, 'VERIFYING', { fenceToken: ftE });
// health probes fail (served != candidate) + deadline past → the forward episode auto-rolls-back
P.verifyLoop(iE.id, { fenceToken: ftE, servedSha: () => WRONG, spawnDeploy: fakeDeploy });
const rbE = await waitFor(iE.id, ['ROLLBACK_RESTART_REQUESTED', 'HELD', 'ROLLED_BACK'], 3000);
assert.equal(rbE.stage, 'ROLLBACK_RESTART_REQUESTED', 'forward health failure → auto-rollback published+restart (got ' + rbE.stage + '/' + rbE.failure_code + ')');
assert.ok(rbE.rollback_sha, 'rollback_sha recorded');
assert.equal(g('cat-file', '-t', rbE.rollback_sha), 'commit', 'a forward-revert commit was created (never a reset)');
// the reborn server now serves the rollback sha → ROLLBACK_VERIFYING → ROLLED_BACK
await P.reconcile({ servedSha: () => rbE.rollback_sha, spawnDeploy: fakeDeploy });
const doneE = await waitFor(iE.id, ['ROLLED_BACK', 'HELD', 'GREEN'], 3000);
assert.equal(doneE.stage, 'ROLLED_BACK', 'rollback verified through the health window → ROLLED_BACK (got ' + doneE.stage + '/' + doneE.failure_code + ')');
clear(iE.id);

// F) the version-bump path: the deploy now bumps the version ON TOP of the candidate, so the served HEAD is a
// DESCENDANT of the candidate (not equal). Verify must still recognize it via the ANCESTOR check → GREEN.
const cF = candidateCommit('cF', 'f2.txt');
const iF = approved(cF, 'cF');
const bumpDeploy = (repoPath, sha) => {
  execFileSync('git', ['-C', repoPath, 'merge', '--ff-only', sha], { stdio: 'ignore' });      // ff main → candidate
  writeFileSync(join(repoPath, 'ver.txt'), '9.9.9\n');                                          // then a release-bump commit
  execFileSync('git', ['-C', repoPath, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoPath, 'commit', '-qm', 'release: v9.9.9'], { stdio: 'ignore' });
  return 4343;
};
const rF = await P.drivePublish(iF.id, { servedSha: () => WRONG, spawnDeploy: bumpDeploy });
assert.equal(rF.stage, 'RESTART_REQUESTED', 'bump path reaches RESTART_REQUESTED');
const deployedF = g('rev-parse', 'main');
assert.notEqual(deployedF, cF, 'the deploy bumped: served HEAD sits above the candidate');
await P.reconcile({ servedSha: () => deployedF, spawnDeploy: bumpDeploy }); // reborn server serves the bump commit (a descendant of cF)
const greenF = await waitFor(iF.id, ['GREEN', 'HELD', 'REJECTED']);
assert.equal(greenF.stage, 'GREEN', 'candidate is an ancestor of the served bump commit → GREEN (got ' + greenF.stage + '/' + greenF.failure_code + ')');
clear(iF.id);

assert.equal(I.occupiedBy(), null, 'pipeline free after all publisher runs');
console.log('publisher.test: all assertions passed');
