import { recordSupervisorDecision, triggeringSignal as makeTriggeringSignal } from './dispatch.js';

function keys(patch) {
  return Object.keys(patch || {});
}

function oneLine(s, max = 360) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function defaultReason(patch) {
  const changed = keys(patch);
  if (!changed.length) return 'empty supervisor state patch';
  return `supervisor state patch: ${changed.slice(0, 8).join(', ')}`;
}

// State mutation is a Supervisor side effect. Keep it behind the same auditable
// decision-record boundary as sends/commands so old controller branches cannot
// silently steer behavior without leaving a policy trace.
export function applySupervisorState(ctx, patch, {
  snapshot = null,
  ruleId = 'state.patch',
  actionType = 'state',
  actionTarget = 'internal',
  suppressionReason = 'state-update',
  latestOperatorIntent = null,
  triggeringSignal = null,
  reasons = [],
} = {}) {
  if (!patch || !keys(patch).length) return ctx.getState();
  const effectiveSnapshot = snapshot || ctx.__supervisorSnapshot || null;
  const reason = reasons.length ? reasons : [defaultReason(patch)];
  const trigger = triggeringSignal || makeTriggeringSignal(
    'supervisor_state_patch',
    oneLine(defaultReason(patch)),
    'supervisor.state'
  );
  const decision = recordSupervisorDecision(ctx, {
    snapshot: effectiveSnapshot,
    ruleId,
    actionType,
    actionTarget,
    allowedSend: false,
    suppressionReason,
    latestOperatorIntent,
    triggeringSignal: trigger,
    reasons: reason,
    statePatch: patch,
  });
  if (!decision?.decisionId) throw new Error('supervisor state mutation missing decision record');
  return ctx.setState(patch);
}
