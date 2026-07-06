export const SUPERVISOR_STATE_SCHEMA = 'supervisor.state';

export function readSupervisorState(st = {}, recentDecisions = []) {
  const hold = st.needsOperatorHold || null;
  return {
    schema: SUPERVISOR_STATE_SCHEMA,
    signedOff: !!(st.verifiedWorkFp || st.verifiedAt),
    operatorStance: st.operatorStance || null,
    operatorStanceReason: st.operatorStanceReason || '',
    operatorStanceMsgTs: Number(st.operatorStanceMsgTs || 0),
    activeHold: hold ? {
      reason: hold.reason || 'held',
      scope: hold.scope || hold.key || '',
      armedAt: hold.at || hold.armedAt || null,
      clearCondition: hold.clearCondition || 'operator-resolve-or-new-evidence',
      allowedActions: hold.allowedActions || ['resolve', 'record-decision'],
    } : null,
    lastGate: {
      fp: st.gateSentFp || null,
      key: st.gateSentKey || null,
      at: st.gateSentAt || null,
    },
    lastDecision: recentDecisions?.[0] || null,
    verifiedWorkFp: st.verifiedWorkFp || null,
    verifiedAt: st.verifiedAt || null,
    questionOnlyReview: st.questionOnlyReviewedKey || st.questionOnlyQuietKey || null,
    recoveryState: {
      errSig: st.errSig || null,
      errType: st.errType || null,
      errAttempt: Number(st.errAttempt || 0),
      errNextAt: st.errNextAt || null,
      ctxWedgeAt: st.ctxWedgeAt || null,
      ctxActed: !!st.ctxActed,
      exit: {
        key: st.exitRecoveryKey || null,
        attempt: Number(st.exitRecoveryAttempt || 0),
        lastAt: st.exitRecoveryLastAt || null,
        resolved: !!st.exitRecoveryResolved,
        reason: st.exitRecoveryReason || '',
        notified: !!st.exitRecoveryNotified,
      },
    },
    rawKeys: Object.keys(st || {}).sort(),
  };
}

export function statePatchForGate({ fp = null, key = null, at = Date.now() } = {}) {
  return { gateSentFp: fp, gateSentKey: key, gateSentAt: at };
}

export function statePatchForHold({ reason = 'held', scope = '', clearCondition = 'operator-resolve-or-new-evidence', at = Date.now() } = {}) {
  return { needsOperatorHold: { reason, scope, clearCondition, at } };
}

// Persist the operator's durable stance (from stance.js). msgTs marks the newest operator message this
// stance was classified from, so the tick only re-classifies when a NEWER operator message arrives.
export function statePatchForStance({ stance = null, reason = '', msgTs = 0 } = {}) {
  return { operatorStance: stance || null, operatorStanceReason: String(reason || '').slice(0, 240), operatorStanceMsgTs: Number(msgTs || 0) };
}

export function clearHoldPatch() {
  return { needsOperatorHold: null };
}
