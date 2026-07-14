// Autonomous integrate-&-deploy — the durable state machine (docs/specs/autonomous-deploy-plan.md step 2).
// Verifies: enqueue + FIFO, the legal transition graph, illegal-transition rejection, FENCING (stale token
// rejected), the SINGLE-ACTIVE invariant, and BOOT RECOVERY (fence bump orphans a stale worker). Runs on a
// scratch DB — never the live one.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'int-'));
const I = await import('../src/integrations.js');

// ---- enqueue + FIFO ----
const a = I.enqueue({ projectId: 'p1', sessionId: 's1', sourceBranch: 'b1', candidateSha: 'aaa' });
assert.equal(a.stage, 'QUEUED', 'enqueued in QUEUED');
assert.equal(I.eventsFor(a.id).length, 1, 'enqueue recorded one event');
const b = I.enqueue({ projectId: 'p1', sessionId: 's2', sourceBranch: 'b2', candidateSha: 'bbb' });
assert.equal(I.nextQueued().id, a.id, 'FIFO: oldest queued first');

// ---- legal transition walk to GREEN (with fencing) ----
const ft = a.fence_token;
let r = I.transition(a.id, 'PREPARING', { fenceToken: ft });
assert.equal(r.stage, 'PREPARING', 'QUEUED→PREPARING');
for (const to of ['CHECKING', 'APPROVED', 'PUBLISHING', 'MAIN_PUBLISHED', 'RESTART_REQUESTED', 'VERIFYING', 'GREEN']) {
  r = I.transition(a.id, to, { fenceToken: ft });
  assert.equal(r.stage, to, 'walk → ' + to);
}
assert.ok(I.TERMINAL.has('GREEN'), 'GREEN is terminal');
assert.equal(I.eventsFor(a.id).length, 9, 'each transition recorded (1 enqueue + 8 steps)');

// ---- illegal transition rejected, no partial apply ----
const c = I.enqueue({ candidateSha: 'ccc' });
assert.throws(() => I.transition(c.id, 'GREEN', { fenceToken: c.fence_token }), /illegal transition/, 'QUEUED→GREEN illegal');
assert.equal(I.getIntegration(c.id).stage, 'QUEUED', 'illegal transition did not apply');
assert.throws(() => I.transition(c.id, 'BOGUS', { fenceToken: c.fence_token }), /unknown stage/, 'unknown stage rejected');

// ---- fencing: a stale token cannot write ----
I.transition(c.id, 'PREPARING', { fenceToken: c.fence_token });
assert.throws(() => I.transition(c.id, 'CHECKING', { fenceToken: 999 }), /fenced out/, 'stale fence token rejected');
assert.equal(I.getIntegration(c.id).stage, 'PREPARING', 'fenced-out write did not apply');

// ---- single-active: another candidate cannot enter an active stage while one occupies ----
assert.throws(() => I.transition(b.id, 'PREPARING', { fenceToken: b.fence_token }), /single-active/, 'second active blocked while c is active');
assert.equal(I.getIntegration(b.id).stage, 'QUEUED', 'blocked candidate stays queued');
// resolve c out of the pipeline → the queue frees
I.transition(c.id, 'REJECTED', { fenceToken: c.fence_token });
const r2 = I.transition(b.id, 'PREPARING', { fenceToken: b.fence_token });
assert.equal(r2.stage, 'PREPARING', 'queue freed after c rejected → b can claim');

// ---- boot recovery: fence bump orphans the stale (pre-restart) worker ----
const before = I.getIntegration(b.id).fence_token;
const rec = I.recoverOnBoot('boot-XYZ');
assert.equal(rec.integration.id, b.id, 'recovery finds the pipeline-occupying integration');
assert.ok(rec.integration.fence_token > before, 'fence token bumped on recovery');
assert.equal(rec.integration.owner_boot_id, 'boot-XYZ', 'new boot stamped as owner');
assert.throws(() => I.transition(b.id, 'CHECKING', { fenceToken: before }), /fenced out/, 'the pre-restart worker (old token) is orphaned');
const r3 = I.transition(b.id, 'CHECKING', { fenceToken: rec.integration.fence_token });
assert.equal(r3.stage, 'CHECKING', 'the recovered owner (new token) can proceed');

// ---- occupiedBy sees the active one; a terminal one frees the queue ----
assert.equal(I.occupiedBy()?.id, b.id, 'occupiedBy = the active integration');
I.transition(b.id, 'REJECTED', { fenceToken: rec.integration.fence_token });
assert.equal(I.occupiedBy(), null, 'no integration occupies the pipeline once all terminal');

console.log('integrations.test: all assertions passed');
