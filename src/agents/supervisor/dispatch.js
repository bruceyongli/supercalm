import { makeDecision, persistDecision, updateDecisionSend } from './decision_records.js';
import { cardLifecycleDirective } from './send_policy.js';
import { guardSupervisorSendContext } from './context_guard.js';
import { renderIntent } from '../intents.js';

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
  intent: typedIntent = null, // Phase 1: {name, params} — template-rendered; overrides free text
  sendOptions = {},
  allowedSend = false,
  suppressionReason = '',
  latestOperatorIntent = null,
  triggeringSignal = null,
  reasons = [],
  statePatch = {},
} = {}) {
  // Typed-intent path (v4 Phase 1, intents.js): the caller proposes an intent, the template renders
  // the exact outbound text, and a render refusal (unknown intent, bad params, placeholder content)
  // becomes a recorded non-send — never improvised text. Free-text callers keep working during the
  // strangler migration; by end of Phase 1 the kernel requires an intent on autonomous lanes.
  let renderedKind = null;
  let renderRefusal = '';
  if (typedIntent) {
    const r = renderIntent(typedIntent.name, typedIntent.params || {});
    if (r.ok) { text = r.text; renderedKind = r.kind; }
    else { renderRefusal = r.error || 'intent render refused'; text = ''; }
  }
  const msg = line(text);
  const intent = latestOperatorIntent || operatorIntentFromSnapshot(snapshot);
  let allowed = !!allowedSend;
  let suppressed = suppressionReason || '';
  let guardedReasons = [];
  if (renderRefusal) { allowed = false; suppressed = suppressed || `intent-render-refused: ${renderRefusal}`.slice(0, 160); }
  if (!msg) { allowed = false; suppressed = suppressed || 'empty-message'; }
  if (!intent) { allowed = false; suppressed = suppressed || 'missing-operator-intent'; }
  const guard = guardSupervisorSendContext({ snapshot, actionType, text: msg, triggeringSignal, allowedSend: allowed });
  if (!guard.allowedSend) {
    allowed = false;
    suppressed = suppressed || guard.suppressionReason || 'context-guard-blocked';
    guardedReasons = guard.reasons || [];
  }
  // Choke-point backstop (self-echo incident): NO supervisor-authored text may direct task-card
  // lifecycle, on any path (answer/unstick/keep-working/challenge/recover) in any mode — card admin
  // is the operator's. Only the operator relay (hold.resolve_send: the operator's own typed words)
  // is exempt. runAnswer converts these to escalations before dispatch; this catches every other
  // path plus any future call site, so the guard cannot be forgotten.
  if (allowed && ruleId !== 'hold.resolve_send' && cardLifecycleDirective(msg)) {
    allowed = false;
    suppressed = 'card-lifecycle-operator-reserved';
    guardedReasons = [...guardedReasons, 'drafted supervisor text directs task-card lifecycle (start/close/abandon/done) — operator territory in every mode'];
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
    payload: { text: msg, sendOptions, intent: typedIntent ? { name: typedIntent.name } : undefined },
  });
  if (!allowed) {
    const result = { sent: false, reason: suppressed || 'blocked', message: '', draft: msg };
    updateDecisionSend(decision.decisionId, { sent: false, reason: suppressed || 'blocked', message: '' });
    return result;
  }
  // Typed send lane for the kernel (context.js): a rendered intent carries its own lane; the operator
  // relay is the operator's own words (kernel-exempt); everything else maps from the decision's
  // actionType, defaulting to the most restricted lane. Unknown kinds fail closed downstream.
  const kind = renderedKind
    || sendOptions.kind
    || (ruleId === 'hold.resolve_send' ? 'operator' : ({ answer: 'answer', challenge: 'challenge', recover: 'recover' })[actionType] || 'nudge');
  // LEASE (Phase 1): answers/challenges/nudges were reasoned against the pane as it stood when this
  // pass began (ctx.__tickPaneSig, captured in onTick) — if it moved since, the kernel refuses the
  // stale send. Recovery is time-critical on a CHANGING pane and the operator relay is the operator's
  // own words: neither carries a lease.
  const lease = (kind === 'recover' || kind === 'operator' || !ctx.__tickPaneSig)
    ? (sendOptions.lease ?? null)
    : (sendOptions.lease ?? { paneSig: ctx.__tickPaneSig });
  const result = await ctx.sendToAgent(msg, { ...sendOptions, kind, lease });
  updateDecisionSend(decision.decisionId, { ...result, sent_text: result?.message || '' });
  return { ...result, draft: msg }; // draft = the rendered text, for caller logging even on kernel blocks
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
  const result = await ctx.sendCommand(cmd, { ...sendOptions, kind: sendOptions.kind || 'recover' });
  updateDecisionSend(decision.decisionId, { ...result, sent_text: result?.command || '' });
  return result;
}
