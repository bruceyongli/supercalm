// Task-scoped supervisor state (Project Memory phase 2 — docs/specs/project-memory-plan.md).
//
// The supervisor's loop-breaker fingerprints and counters (gate re-arm, repeat-push, escalation
// caps) historically lived FLAT on the per-session grant state. Once a session can move between
// TASK CARDS, flat keys are wrong in both directions: they leak across tasks (a stale gate
// fingerprint suppresses the next task's gate) or re-arm on switch (the exact runaway classes the
// counters were built to stop — all three phase-3 reviewers flagged this).
//
// Fix at the single state seam (ctx.getState/setState in agents/context.js), so ZERO call sites
// change and behavior with no active task is byte-identical (the replay suite proves it):
//   - viewTaskState(raw): the state the supervisor READS — task-scoped keys resolved from
//     raw.taskState[raw.activeTaskId] over the flat legacy values.
//   - routeTaskPatch(raw, patch): the WRITE router — task-scoped keys land under
//     taskState[activeTaskId]; everything else stays flat. A patch that itself sets
//     activeTaskId routes its scoped keys to the NEW task.
//
// Scoping judgment per key (phase-3 panel, Q5): work-contract-derived state is task-scoped;
// session-mechanics state (terminal fingerprints, exit recovery, context wedge, stance, doc
// maintenance, send cadence) stays flat.

export const TASK_SCOPED_KEYS = [
  // work/gate contract fingerprints
  'workFp', 'challengedWorkFp', 'verifiedWorkFp', 'verifiedGateKey', 'verifiedAt', 'signoff',
  'gateSentFp', 'gateSentKey', 'gateSentAt', 'gateDraftFp', 'gateDraftCount', 'gateEscalatedFp',
  'tierVerifiedFp', 'reopenPending',
  // nudge/answer/escalation caps (per contract, not per session)
  'keepWorkingFp', 'nudges', 'answerKey', 'answerTries', 'answerEscalatedKey', 'answerSentTries',
  'operatorWaitKey', 'lastEscalateKey', 'lastEscalateAt',
  // goal-integrity holds are about the active contract
  'goalConflictKey', 'goalConflictCount', 'needsOperatorHold',
];
const SCOPED = new Set(TASK_SCOPED_KEYS);

// The state the supervisor reads: flat session keys + the active task's scoped view on top.
// No active task (or no per-task bucket yet) -> the raw object unchanged (legacy behavior).
export function viewTaskState(raw) {
  const r = raw || {};
  const tid = r.activeTaskId;
  const bucket = tid ? r.taskState?.[tid] : null;
  if (!bucket) return r;
  return { ...r, ...bucket };
}

// Route a write: scoped keys into the (possibly just-set) active task's bucket, the rest flat.
// Returns a patch safe for a shallow grant-state merge (taskState is rebuilt wholesale).
export function routeTaskPatch(raw, patch) {
  const r = raw || {};
  const p = patch || {};
  const tid = Object.prototype.hasOwnProperty.call(p, 'activeTaskId') ? p.activeTaskId : r.activeTaskId;
  if (!tid) return p;
  const flat = {};
  const scoped = {};
  for (const [k, v] of Object.entries(p)) (SCOPED.has(k) ? scoped : flat)[k] = v;
  if (!Object.keys(scoped).length) return flat;
  return {
    ...flat,
    taskState: { ...(r.taskState || {}), [tid]: { ...(r.taskState?.[tid] || {}), ...scoped } },
  };
}
