// Deploy circuit breaker (autonomous-deploy plan §6). Scratch DB. Verifies: below threshold → not blocked;
// N post-publish failures (deploy-attempts that ended ROLLED_BACK) → breaker OPEN + stays open; clear()
// re-arms and resets the window so a single later failure doesn't re-trip. A gate REJECTED (never entered
// PUBLISHING) does NOT count.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_NO_LISTEN = '1';
process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'brk-db-'));
process.env.AIOS_BREAKER_FAILS = '3';

const store = await import('../src/store.js');
const I = await import('../src/integrations.js');
const B = await import('../src/deploy_breaker.js');

const proj = store.createProject({ id: 'p_brk', name: 'brk', path: '/tmp/nonexistent-brk' });

// Drive an integration all the way to ROLLED_BACK (a deploy-attempt that failed) — ends terminal, frees the
// pipeline for the next. Passes through PUBLISHING, so it counts as a post-publish failure.
function failedDeploy(branch) {
  const it = I.enqueue({ projectId: proj.id, sourceBranch: branch, candidateSha: 'sha_' + branch });
  for (const s of ['PREPARING', 'CHECKING', 'APPROVED', 'PUBLISHING', 'MAIN_PUBLISHED', 'ROLLING_BACK', 'ROLLBACK_PUBLISHED', 'ROLLBACK_RESTART_REQUESTED', 'ROLLBACK_VERIFYING', 'ROLLED_BACK']) {
    const cur = I.getIntegration(it.id);
    I.transition(it.id, s, { fenceToken: cur.fence_token });
  }
  return I.getIntegration(it.id);
}
// A gate rejection — never entered PUBLISHING, so it must NOT count toward the deploy breaker.
function gateReject(branch) {
  const it = I.enqueue({ projectId: proj.id, sourceBranch: branch, candidateSha: 'sha_' + branch });
  for (const s of ['PREPARING', 'CHECKING', 'REJECTED']) { const cur = I.getIntegration(it.id); I.transition(it.id, s, { fenceToken: cur.fence_token }); }
  return I.getIntegration(it.id);
}

// clean start → not blocked
assert.equal((await B.breakerBlocks(proj.id, null)).blocked, false, 'clean → not blocked');

// gate rejections don't count
gateReject('r1'); gateReject('r2'); gateReject('r3'); gateReject('r4');
assert.equal((await B.breakerBlocks(proj.id, null)).blocked, false, 'gate REJECTEDs never touched prod → do not trip');

// 2 deploy failures < threshold(3)
failedDeploy('f1'); failedDeploy('f2');
assert.equal((await B.breakerBlocks(proj.id, null)).blocked, false, '2 < threshold');

// 3rd deploy failure trips the breaker
failedDeploy('f3');
const tripped = await B.breakerBlocks(proj.id, null);
assert.equal(tripped.blocked, true, '3 post-publish failures → breaker OPEN');
assert.match(tripped.reason || '', /fail|rollback/i, 'reason names the failures');

// stays open on re-evaluation (never auto-closes)
assert.equal((await B.breakerBlocks(proj.id, null)).blocked, true, 'stays open until cleared');

// clear re-arms + resets the window
B.clearBreaker(proj.id);
assert.equal((await B.breakerBlocks(proj.id, null)).blocked, false, 'cleared → closed');

// a single failure after the clear does not re-trip (window reset by cleared_at)
failedDeploy('f4');
assert.equal((await B.breakerBlocks(proj.id, null)).blocked, false, '1 failure since clear < threshold');

// another project is unaffected (per-project breaker)
const proj2 = store.createProject({ id: 'p_brk2', name: 'brk2', path: '/tmp/nonexistent-brk2' });
assert.equal((await B.breakerBlocks(proj2.id, null)).blocked, false, 'breaker is per-project');

console.log('deploy_breaker.test: all assertions passed');
