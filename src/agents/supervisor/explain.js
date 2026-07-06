import { decisionHistory, latestDecision } from './decision_records.js';

export function supervisorDecisionSummary(sessionId, limit = 25) {
  const latest = latestDecision(sessionId);
  return {
    latestDecision: latest,
    decisionHistory: decisionHistory(sessionId, limit),
    policy: latest ? {
      ruleId: latest.ruleId,
      actionType: latest.actionType,
      allowedSend: latest.allowedSend,
      suppressionReason: latest.suppressionReason,
      latestOperatorIntent: latest.latestOperatorIntent,
      currentTask: latest.decision?.currentTask || null,
      triggeringSignal: latest.triggeringSignal,
      sent: latest.sent,
    } : null,
  };
}
