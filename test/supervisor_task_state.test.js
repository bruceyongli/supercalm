import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-taskstate-'));

const { viewTaskState, routeTaskPatch, TASK_SCOPED_KEYS } = await import('../src/agents/supervisor/task_state.js');

// ---- no active task: byte-identical legacy behavior (the phase-2 invariant) -----------------------
{
  const raw = { workFp: 'w1', gateEscalatedFp: 'g1', operatorStance: 'normal', nudges: 2 };
  assert.deepEqual(viewTaskState(raw), raw, 'view is identity without activeTaskId');
  const patch = { gateEscalatedFp: 'g2', lastActionAt: 5 };
  assert.deepEqual(routeTaskPatch(raw, patch), patch, 'route is identity without activeTaskId');
  assert.deepEqual(viewTaskState(null), {}, 'null-safe');
  assert.deepEqual(routeTaskPatch(null, patch), patch);
}

// ---- with an active task: scoped keys live in the task bucket, flat keys stay flat ----------------
{
  let raw = { activeTaskId: 'task_A', operatorStance: 'normal' };
  const p1 = routeTaskPatch(raw, { workFp: 'wA', nudges: 1, lastActionAt: 99 });
  assert.equal(p1.lastActionAt, 99, 'session-mechanics key stays flat');
  assert.equal(p1.workFp, undefined, 'scoped key not written flat');
  assert.equal(p1.taskState.task_A.workFp, 'wA');
  raw = { ...raw, ...p1 };
  const view = viewTaskState(raw);
  assert.equal(view.workFp, 'wA', 'read resolves the active bucket');
  assert.equal(view.nudges, 1);
  assert.equal(view.operatorStance, 'normal');
}

// ---- task switch: no leakage in either direction (the runaway-class killer) -----------------------
{
  let raw = { activeTaskId: 'task_A', taskState: { task_A: { gateEscalatedFp: 'fpA', answerTries: 4, nudges: 3 } } };
  // switch to B — B starts clean (no re-arm from A, no inherited caps)
  raw = { ...raw, activeTaskId: 'task_B' };
  const viewB = viewTaskState(raw);
  assert.equal(viewB.gateEscalatedFp, undefined, 'task B does not see A\'s gate fingerprint');
  assert.equal(viewB.answerTries, undefined, 'A\'s escalation counter does not cap B');
  // work on B, then come BACK to A — A's state is intact (pause/resume correctness)
  const pB = routeTaskPatch(raw, { gateEscalatedFp: 'fpB' });
  raw = { ...raw, ...pB };
  raw = { ...raw, activeTaskId: 'task_A' };
  const backA = viewTaskState(raw);
  assert.equal(backA.gateEscalatedFp, 'fpA', 'returning to A restores its fingerprints');
  assert.equal(backA.nudges, 3);
  assert.equal(viewTaskState({ ...raw, activeTaskId: 'task_B' }).gateEscalatedFp, 'fpB');
}

// ---- a patch that SETS the active task routes its scoped keys to the NEW task ---------------------
{
  const raw = { activeTaskId: 'task_A', taskState: { task_A: { workFp: 'wA' } } };
  const p = routeTaskPatch(raw, { activeTaskId: 'task_B', workFp: 'wB' });
  assert.equal(p.activeTaskId, 'task_B');
  assert.equal(p.taskState.task_B.workFp, 'wB', 'scoped key follows the task being activated');
  assert.equal(p.taskState.task_A.workFp, 'wA', 'other buckets preserved');
  // clearing the active task routes flat again
  const p2 = routeTaskPatch({ activeTaskId: null }, { workFp: 'wX' });
  assert.equal(p2.workFp, 'wX');
}

// ---- legacy flat values act as fallback under a task until first scoped write ---------------------
{
  const raw = { activeTaskId: 'task_A', workFp: 'legacy', taskState: { task_A: { nudges: 1 } } };
  const v = viewTaskState(raw);
  assert.equal(v.workFp, 'legacy', 'flat legacy value readable until the bucket shadows it');
  const p = routeTaskPatch(raw, { workFp: 'scoped-now' });
  const v2 = viewTaskState({ ...raw, ...p });
  assert.equal(v2.workFp, 'scoped-now', 'bucket shadows flat after the first scoped write');
}

// ---- the scoped-key set is the reviewed one (drift lock) ------------------------------------------
{
  for (const k of ['workFp', 'gateEscalatedFp', 'answerTries', 'answerSentTries', 'keepWorkingFp', 'goalConflictKey', 'needsOperatorHold', 'tierVerifiedFp', 'reopenPending', 'signoff']) {
    assert.ok(TASK_SCOPED_KEYS.includes(k), `${k} is task-scoped`);
  }
  for (const k of ['liveFp', 'liveSince', 'operatorStance', 'exitRecoveryKey', 'ctxWedgeAt', 'lastActionAt', 'baseRef']) {
    assert.ok(!TASK_SCOPED_KEYS.includes(k), `${k} must stay session-flat`);
  }
}

// ---- records carry the contract: decision rows stamp task_id + card_version -----------------------
{
  const { makeDecision, persistDecision } = await import('../src/agents/supervisor/decision_records.js');
  const { db } = await import('../src/store.js');
  const d = makeDecision({
    sessionId: 's_ts', snapshot: { task: { id: 'task_Z', version: 7, hash: 'abc' }, session: { id: 's_ts' } },
    ruleId: 'gate.challenge', action: { type: 'send', target: 'agent' }, allowedSend: true,
  });
  assert.deepEqual(d.task, { id: 'task_Z', version: 7, hash: 'abc' }, 'decision object carries the card ref');
  persistDecision('s_ts', d, { task: d.task });
  const row = db.prepare('SELECT task_id, card_version FROM supervisor_decisions WHERE id = ?').get(d.decisionId);
  assert.equal(row.task_id, 'task_Z');
  assert.equal(row.card_version, 7);
  // null-task decisions stay null (legacy shape)
  const d2 = makeDecision({ sessionId: 's_ts', snapshot: { session: { id: 's_ts' } }, ruleId: 'r', action: { type: 'none', target: 'internal' } });
  persistDecision('s_ts', d2);
  const row2 = db.prepare('SELECT task_id, card_version FROM supervisor_decisions WHERE id = ?').get(d2.decisionId);
  assert.equal(row2.task_id, null);
  assert.equal(row2.card_version, null);
  // reviews table carries the columns too (importing the supervisor runs its schema + migrations)
  await import('../src/agents/supervisor.js');
  const rc = new Set(db.prepare('PRAGMA table_info(supervisor_reviews)').all().map((r) => r.name));
  assert.ok(rc.has('task_id') && rc.has('card_version'), 'reviews stamped with the contract columns');
}

// ---- seam locks: the scoping lives at the ONE state boundary --------------------------------------
{
  const ctxSrc = readFileSync(new URL('../src/agents/context.js', import.meta.url), 'utf8');
  assert.match(ctxSrc, /viewTaskState\(getGrant/, 'getState resolves the task view');
  assert.match(ctxSrc, /routeTaskPatch\(raw, patch\)/, 'setState routes scoped writes');
  const obsSrc = readFileSync(new URL('../src/agents/supervisor/observe.js', import.meta.url), 'utf8');
  assert.match(obsSrc, /task: st\.activeTaskId/, 'snapshot names the active card');
  const supSrc = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(supSrc, /taskRef/, 'logIntervention stamps the card');
  assert.match(supSrc, /applyActiveCard/, 'phase 3: the supervisor consumes the card through the single seam');
}

console.log('supervisor_task_state.test ok');
