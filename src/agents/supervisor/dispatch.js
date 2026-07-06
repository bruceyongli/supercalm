import { makeDecision, persistDecision, updateDecisionSend } from './decision_records.js';
import { guardSupervisorSendContext } from './context_guard.js';

function line(s, max = 1500) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function operatorIntentFromSnapshot(snapshot) {
  return snapshot?.decisionIntent || {
    type: snapshot?.operator?.intent || 'none',
    text: snapshot?.operator?.lastMessageText || '',
    ts: snapshot?.operator?.lastMessageTs || null,
    confidence: Number(snapshot?.operator?.intentConfidence || 0),
  };
}

function signal(type, summary, evidenceRef = '') {
  return { type, summary: line(summary, 360), ts: Date.now(), evidenceRef };
}

export function triggeringSignal(type, summary, evidenceRef = '') {
  return signal(type, summary, evidenceRef);
}

export function recordSupervisorDecision(ctx, {
  snapshot = null,
  ruleId = '',
  actionType = 'none',
  actionTarget = 'internal',
  allowedSend = false,
  suppressionReason = '',
  latestOperatorIntent = null,
  triggeringSignal = null,
  reasons = [],
  statePatch = {},
  payload = {},
} = {}) {
  const decision = makeDecision({
    sessionId: ctx.sessionId,
    snapshot,
    ruleId,
    action: { type: actionType, target: actionTarget, payload },
    allowedSend,
    suppressionReason,
    latestOperatorIntent: latestOperatorIntent || operatorIntentFromSnapshot(snapshot),
    triggeringSignal,
    reasons,
    statePatch,
  });
  persistDecision(ctx, decision, snapshot);
  return decision;
}

export async function dispatchSupervisorSend(ctx, {
  snapshot = null,
  ruleId = '',
  actionType = 'nudge',
  text = '',
  sendOptions = {},
  allowedSend = false,
  suppressionReason = '',
  latestOperatorIntent = null,
  triggeringSignal = null,
  reasons = [],
  statePatch = {},
} = {}) {
  const msg = line(text);
  const intent = latestOperatorIntent || operatorIntentFromSnapshot(snapshot);
  let allowed = !!allowedSend;
  let suppressed = suppressionReason || '';
  let guardedReasons = [];
  if (!msg) { allowed = false; suppressed = suppressed || 'empty-message'; }
  if (!intent) { allowed = false; suppressed = suppressed || 'missing-operator-intent'; }
  const guard = guardSupervisorSendContext({ snapshot, actionType, text: msg, triggeringSignal, allowedSend: allowed });
  if (!guard.allowedSend) {
    allowed = false;
    suppressed = suppressed || guard.suppressionReason || 'context-guard-blocked';
    guardedReasons = guard.reasons || [];
  }
  const decision = recordSupervisorDecision(ctx, {
    snapshot,
    ruleId,
    actionType,
    actionTarget: 'agent',
    allowedSend: allowed,
    suppressionReason: suppressed,
    latestOperatorIntent: intent,
    triggeringSignal,
    reasons: [...(Array.isArray(reasons) ? reasons : [String(reasons || '')].filter(Boolean)), ...guardedReasons],
    statePatch,
    payload: { text: msg, sendOptions },
  });
  if (!allowed) {
    const result = { sent: false, reason: suppressed || 'blocked', message: '' };
    updateDecisionSend(decision.decisionId, result);
    return result;
  }
  const result = await ctx.sendToAgent(msg, sendOptions);
  updateDecisionSend(decision.decisionId, { ...result, sent_text: result?.message || '' });
  return result;
}

export async function dispatchSupervisorCommand(ctx, {
  snapshot = null,
  ruleId = '',
  command = '',
  sendOptions = {},
  allowedSend = false,
  suppressionReason = '',
  latestOperatorIntent = null,
  triggeringSignal = null,
  reasons = [],
} = {}) {
  const cmd = line(command, 120);
  let allowed = !!allowedSend;
  let suppressed = allowed ? '' : (suppressionReason || 'send-not-allowed');
  let guardedReasons = [];
  if (!cmd) { allowed = false; suppressed = suppressed || 'empty-command'; }
  const guard = guardSupervisorSendContext({ snapshot, actionType: 'recover', text: cmd, triggeringSignal, allowedSend: allowed });
  if (!guard.allowedSend) {
    allowed = false;
    suppressed = suppressed || guard.suppressionReason || 'context-guard-blocked';
    guardedReasons = guard.reasons || [];
  }
  const decision = recordSupervisorDecision(ctx, {
    snapshot,
    ruleId,
    actionType: 'recover',
    actionTarget: 'agent',
    allowedSend: allowed,
    suppressionReason: suppressed,
    latestOperatorIntent: latestOperatorIntent || operatorIntentFromSnapshot(snapshot),
    triggeringSignal,
    reasons: [...(Array.isArray(reasons) ? reasons : [String(reasons || '')].filter(Boolean)), ...guardedReasons],
    payload: { command: cmd, sendOptions },
  });
  if (!allowed || !cmd) {
    const result = { sent: false, reason: suppressed || 'blocked', command: cmd };
    updateDecisionSend(decision.decisionId, result);
    return result;
  }
  const result = await ctx.sendCommand(cmd, sendOptions);
  updateDecisionSend(decision.decisionId, { ...result, sent_text: result?.command || '' });
  return result;
}
