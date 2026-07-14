// Autonomous integrate-&-deploy — the ORCHESTRATOR control flow (plan §6/trigger). Scratch DB, all heavy
// steps injected: verifies the gating + sequencing without real git/deploy —
//   autoPublish off → nothing dequeued (stays QUEUED)
//   breaker blocks → REJECTED (breaker_open), gate never runs
//   isolation off  → REJECTED (isolation_off)
//   gate REJECTS   → publish never runs
//   happy path     → gate → APPROVED → publish → RESTART_REQUESTED
//   single-active  → a second pass is skipped while one occupies the pipeline
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_NO_LISTEN = '1';
process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'orch-db-'));

const store = await import('../src/store.js');
const I = await import('../src/integrations.js');
const O = await import('../src/deploy_orchestrator.js');

const proj = store.createProject({ id: 'p_orch', name: 'orch', path: '/tmp/nonexistent-orch' });

// injected step fakes that drive the REAL state machine (so stages/fencing are exercised)
const gateApprove = async (id, { fenceToken }) => { I.transition(id, 'PREPARING', { fenceToken }); let c = I.getIntegration(id); I.transition(id, 'CHECKING', { fenceToken: c.fence_token, patch: { candidate_sha: 'cand' } }); c = I.getIntegration(id); return I.transition(id, 'APPROVED', { fenceToken: c.fence_token }); };
const gateReject = async (id, { fenceToken }) => { I.transition(id, 'PREPARING', { fenceToken }); const c = I.getIntegration(id); return I.transition(id, 'REJECTED', { fenceToken: c.fence_token, patch: { failure_code: 'checks_failed' } }); };
const publishOk = async (id, { fenceToken }) => { I.transition(id, 'PUBLISHING', { fenceToken }); let c = I.getIntegration(id); I.transition(id, 'MAIN_PUBLISHED', { fenceToken: c.fence_token }); c = I.getIntegration(id); return I.transition(id, 'RESTART_REQUESTED', { fenceToken: c.fence_token }); };
const notBlocked = async () => ({ blocked: false });
const blocked = async () => ({ blocked: true, reason: 'thrash' });
const isoOn = () => true;
const isoOff = () => false;
let published = 0;
const publishCount = async (id, o) => { published++; return publishOk(id, o); };

function clear(id) { let r = I.getIntegration(id); if (I.TERMINAL.has(r.stage)) return; try { if (r.stage !== 'HELD') { I.transition(id, 'HELD', { fenceToken: r.fence_token }); r = I.getIntegration(id); } I.transition(id, 'REJECTED', { fenceToken: r.fence_token }); } catch {} }
const enq = (b) => I.enqueue({ projectId: proj.id, sourceBranch: b, candidateSha: 'sha_' + b });

// autoPublish OFF → nothing dequeued
const iOff = enq('off');
let r = await O.orchestrateOnce({ enabled: () => false, blocks: notBlocked, isolation: isoOn, gate: gateApprove, publish: publishOk });
assert.equal(r.skipped, 'autoPublish_off', 'off → skipped');
assert.equal(I.getIntegration(iOff.id).stage, 'QUEUED', 'stays QUEUED when the capability is off');
clear(iOff.id);

// breaker blocks → REJECTED, gate never runs
const iBlk = enq('blk');
let gateRan = 0; const gateSpy = async (id, o) => { gateRan++; return gateApprove(id, o); };
r = await O.orchestrateOnce({ enabled: () => true, blocks: blocked, isolation: isoOn, gate: gateSpy, publish: publishOk });
assert.equal(r.result.stage, 'REJECTED', 'breaker → REJECTED');
assert.equal(r.result.failure_code, 'breaker_open', 'failure_code breaker_open');
assert.equal(gateRan, 0, 'gate never ran under an open breaker');
clear(iBlk.id);

// isolation OFF → REJECTED isolation_off
const iIso = enq('iso');
r = await O.orchestrateOnce({ enabled: () => true, blocks: notBlocked, isolation: isoOff, gate: gateApprove, publish: publishOk });
assert.equal(r.result.stage, 'REJECTED', 'isolation off → REJECTED');
assert.equal(r.result.failure_code, 'isolation_off', 'failure_code isolation_off');
clear(iIso.id);

// gate REJECTS → publish never runs
const iGr = enq('gr');
published = 0;
r = await O.orchestrateOnce({ enabled: () => true, blocks: notBlocked, isolation: isoOn, gate: gateReject, publish: publishCount });
assert.equal(r.result.stage, 'REJECTED', 'gate reject → REJECTED');
assert.equal(published, 0, 'publish never ran on a rejected gate');
clear(iGr.id);

// happy path → gate → APPROVED → publish → RESTART_REQUESTED
const iOk = enq('ok');
published = 0;
r = await O.orchestrateOnce({ enabled: () => true, blocks: notBlocked, isolation: isoOn, gate: gateApprove, publish: publishCount });
assert.equal(r.result.stage, 'RESTART_REQUESTED', 'happy path → RESTART_REQUESTED (got ' + r.result.stage + ')');
assert.equal(published, 1, 'publish ran exactly once');

// single-active: another pass is skipped while iOk occupies the pipeline
const iNext = enq('next');
r = await O.orchestrateOnce({ enabled: () => true, blocks: notBlocked, isolation: isoOn, gate: gateApprove, publish: publishOk });
assert.equal(r.skipped, 'occupied', 'second pass skipped while one occupies the pipeline');
assert.equal(I.getIntegration(iNext.id).stage, 'QUEUED', 'the queued one waits its turn');
clear(iOk.id); clear(iNext.id);

console.log('deploy_orchestrator.test: all assertions passed');
