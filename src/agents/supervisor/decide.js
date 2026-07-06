import { isStandDownStage } from './stage.js';
import { resolveStance } from './stance.js';

// The policy is a DETERMINISTIC function of two semantic labels the model already produced upstream —
// the operator's durable STANCE (stance.js, persisted, read from operator messages) and the session's
// STAGE (stage.js / summarizer, read from the screen). decide.js itself does no reading/guessing: it maps
// (stance × stage × status) → one action, so it stays auditable, cheap on every tick, and lockable by the
// replay harness. Orthogonal safety rules (hold / exit / context-window / signed-off / recovery) come first.
export const POLICY_RULES = [
  'operator.hold',
  'operator.answer_only',
  'supervisor.hold',
  'recover.context_window',
  'recover.unexpected_exit',
  'session.exited',
  'session.starting',
  'session.no_doc',
  'session.signed_off',
  'stage.stand_down',
  'stance.autopilot_proceed',
  'verification.needs_evidence',
  'completion.no_new_signal',
  'stance.autopilot_advance',
  'agent.waiting.question',
  'agent.waiting.review',
  'agent.waiting.idle',
  'agent.working.stuck',
  'default.none',
];

function action(type, target = 'internal', payload = {}) {
  return { type, target, payload };
}

function base(snapshot, ruleId, actionObj, reasons, extra = {}) {
  const matchedRules = [ruleId].filter(Boolean);
  return {
    schema: 'supervisor.policy_decision',
    policyVersion: 'supervisor.policy.2026-07-04',
    ruleId,
    stance: snapshot?.stance || 'normal',
    stage: snapshot?.stage?.stage || snapshot?.session?.stage || '',
    action: actionObj,
    allowedSend: !!extra.allowedSend,
    suppressionReason: extra.suppressionReason || '',
    latestOperatorIntent: snapshot?.decisionIntent || {
      type: snapshot?.operator?.intent || 'none',
      text: snapshot?.operator?.lastMessageText || '',
      ts: snapshot?.operator?.lastMessageTs || null,
      confidence: Number(snapshot?.operator?.intentConfidence || 0),
    },
    currentTask: snapshot?.currentTask || null,
    triggeringSignal: extra.triggeringSignal || null,
    reasons: Array.isArray(reasons) ? reasons : [String(reasons || '')].filter(Boolean),
    unmetCriteria: extra.unmetCriteria || [],
    requiredEvidence: extra.requiredEvidence || [],
    statePatch: extra.statePatch || {},
    audit: {
      evaluatedRules: POLICY_RULES,
      matchedRules,
      priorDecisionRefs: extra.priorDecisionRefs || [],
    },
  };
}

function signal(type, summary, snapshot, evidenceRef = '') {
  return { type, summary: String(summary || type).slice(0, 360), ts: snapshot?.session?.updatedAt || snapshot?.generatedAt || Date.now(), evidenceRef };
}

export function decideSupervisorAction(snapshot, config = {}) {
  const session = snapshot?.session || {};
  const operator = snapshot?.operator || {};
  const state = snapshot?.supervisorState || {};
  const doc = snapshot?.supervisionDoc || {};
  const agent = snapshot?.agent || {};
  const verification = snapshot?.verification || snapshot?.verifier || {};
  const terminalSignals = Array.isArray(agent.terminalSignals) ? agent.terminalSignals : [];
  const contextSignals = Array.isArray(agent.contextWindowSignals) ? agent.contextWindowSignals : [];
  const opText = operator.lastMessageText || '';

  // DURABLE OPERATOR STANCE (stance.js) + semantic STAGE (stage.js) — the two axes of the whole policy.
  const stance = resolveStance(snapshot?.stance);
  const stage = snapshot?.stage?.stage || snapshot?.session?.stage || '';
  const standDownStage = isStandDownStage(stage) && session.status === 'waiting'; // planning | awaiting_approval

  // 1. HOLD — the operator told the supervisor to stand down / stay quiet. Nothing overrides this.
  if (stance === 'hold') {
    return base(snapshot, 'operator.hold', action('wait'), 'operator stance is hold — supervisor stands down until told otherwise', {
      suppressionReason: 'operator-hold',
      triggeringSignal: signal('operator_hold', opText || 'operator asked supervisor to wait', snapshot, 'operator.stance'),
    });
  }
  // 2. ANSWER_ONLY — engage only on a genuine blocking question; otherwise observe.
  if (stance === 'answer_only' && !['decision', 'action'].includes(session.category)) {
    return base(snapshot, 'operator.answer_only', action('wait'), 'operator stance is answer-only — no unsolicited actions or nudges', {
      suppressionReason: 'answer-only',
      triggeringSignal: signal('operator_answer_only', opText || 'operator asked for answer-only behavior', snapshot, 'operator.stance'),
    });
  }

  // --- Orthogonal safety rules (independent of stance/stage) ---
  if (state.activeHold) {
    return base(snapshot, 'supervisor.hold', action('wait'), `active hold: ${state.activeHold.reason || 'held'}`, {
      suppressionReason: 'active-hold',
      triggeringSignal: signal('active_hold', state.activeHold.reason || 'held', snapshot, 'supervisor.state'),
    });
  }
  if (session.status === 'exited') {
    const exitRecovery = state.recoveryState?.exit || {};
    if (state.signedOff) return base(snapshot, 'session.exited', action('none'), 'signed-off session exited', { suppressionReason: 'signed-off-exited' });
    if (exitRecovery.resolved) return base(snapshot, 'session.exited', action('none'), 'session exit already handled', { suppressionReason: 'exit-recovery-resolved' });
    if (doc.raw && doc.raw.trim()) {
      return base(snapshot, 'recover.unexpected_exit', action(config.allowExitRecovery ? 'recover' : 'escalate', config.allowExitRecovery ? 'agent' : 'operator'), 'supervised session exited before verified completion', {
        allowedSend: !!config.allowExitRecovery,
        suppressionReason: config.allowExitRecovery ? '' : 'exit-recovery-not-authorized',
        triggeringSignal: signal('unexpected_exit', `session exited with code ${session.exitCode ?? 'unknown'} before sign-off`, snapshot, 'session.status.exited'),
        requiredEvidence: ['resume or operator recovery decision', 'fresh verification after recovery'],
      });
    }
    return base(snapshot, 'session.exited', action('none'), 'session exited without a supervision doc', { suppressionReason: 'session-exited' });
  }
  if (contextSignals.includes('context_window_full')) {
    return base(snapshot, 'recover.context_window', action(config.allowContextRecovery ? 'recover' : 'escalate', config.allowContextRecovery ? 'agent' : 'operator'), 'context window appears wedged', {
      allowedSend: !!config.allowContextRecovery,
      suppressionReason: config.allowContextRecovery ? '' : 'context-recovery-needs-operator-or-config',
      triggeringSignal: signal('context_window_full', 'agent reported context window exhaustion', snapshot, 'terminal_tail'),
      requiredEvidence: ['terminal context-window error'],
    });
  }
  if (session.status === 'starting') return base(snapshot, 'session.starting', action('wait'), 'session starting', { suppressionReason: 'session-starting' });
  if (!doc.raw || !doc.raw.trim()) return base(snapshot, 'session.no_doc', action('wait'), 'no supervision doc', { suppressionReason: 'missing-supervision-doc' });
  if (state.signedOff) return base(snapshot, 'session.signed_off', action('none'), 'signed off unless new evidence reopens it', { suppressionReason: 'signed-off' });

  // 3. STAGE STAND-DOWN — planning / awaiting-plan-approval is the OPERATOR's decision to make, not ours.
  //    Under `autopilot` the operator has pre-delegated "keep going", so an inter-phase "shall I proceed?"
  //    pause is a STALL, not a gate — nudge the builder onward instead of parking it. Otherwise stand down.
  if (standDownStage) {
    // A FORMED plan pausing for per-phase approval (awaiting_approval) yields to autopilot — proceed to the
    // next phase. But RAW planning (the plan itself isn't formed yet) always stands down, even under autopilot:
    // there are no phases to proceed into, and forming the plan is still the operator's call.
    if (stance === 'autopilot' && stage === 'awaiting_approval') {
      return base(snapshot, 'stance.autopilot_proceed', action('nudge', 'agent'), 'operator delegated finishing the work (autopilot); proceed to the next phase without waiting for per-phase approval', {
        allowedSend: true,
        triggeringSignal: signal('proceed_directive', opText || 'finish the remaining phases', snapshot, 'operator.stance'),
      });
    }
    return base(snapshot, 'stage.stand_down', action('wait'), `session is in the ${stage} stage — the plan/design is still being decided; the operator owns this, so the supervisor stands down (no answer, nudge, or completion challenge until execution starts)`, {
      suppressionReason: `stage-${stage}`,
      triggeringSignal: signal('planning_stage', `${stage}: ${(snapshot?.stage?.reasons || []).join(', ') || 'operator still shaping the plan'}`, snapshot, snapshot?.stage?.source || 'stage'),
      statePatch: { lastStage: stage },
    });
  }

  // 4. Verification found concrete gaps → challenge (fed in from a prior verify pass).
  if (verification.verdict === 'needs_evidence' || (Array.isArray(verification.missingEvidence) && verification.missingEvidence.length)) {
    const missing = verification.missingEvidence || verification.unmetCriteria || ['missing concrete evidence'];
    return base(snapshot, 'verification.needs_evidence', action('challenge', 'agent'), 'verification found missing concrete evidence', {
      allowedSend: true,
      triggeringSignal: signal('verification_gap', missing.slice(0, 3).join('; '), snapshot, 'verification'),
      unmetCriteria: verification.unmetCriteria || [],
      requiredEvidence: missing,
    });
  }

  // 5. COMPLETION CLAIM (stage=review). Verify a phase ONCE; then, if the operator wants everything finished
  //    (autopilot), advance to the next phase instead of going quiet — the piece the old code was missing,
  //    which left the builder parked after each phase. Without autopilot, a re-claim with no new evidence
  //    stays quiet (completion.no_new_signal), as before.
  if (session.status === 'waiting' && session.category === 'review') {
    const gateAlreadySent = state.lastGate?.key && state.lastGate.key === doc.gateScopeKey && !terminalSignals.includes('evidence_supplied');
    if (gateAlreadySent) {
      if (stance === 'autopilot') {
        return base(snapshot, 'stance.autopilot_advance', action('nudge', 'agent'), 'phase verified and operator wants all phases finished (autopilot) — advance to the next phase', {
          allowedSend: true,
          triggeringSignal: signal('advance_phase', session.summary || 'phase complete — advance to the next phase', snapshot, 'operator.stance'),
          priorDecisionRefs: state.lastDecision?.id ? [state.lastDecision.id] : [],
        });
      }
      return base(snapshot, 'completion.no_new_signal', action('wait'), 'completion gate was already sent for this scope and no new evidence signal is present', {
        suppressionReason: 'repeated-gate-no-new-signal',
        triggeringSignal: signal('completion_claim', session.summary || 'agent claims completion', snapshot, 'session.category'),
        priorDecisionRefs: state.lastDecision?.id ? [state.lastDecision.id] : [],
      });
    }
    return base(snapshot, 'agent.waiting.review', action('verify', 'internal'), 'agent claims completion or asks for review', {
      triggeringSignal: { type: 'completion_claim', summary: session.summary || 'waiting review', ts: session.updatedAt || snapshot.generatedAt, evidenceRef: 'session.category' },
    });
  }

  // 6. A genuine blocking question from the agent → answer it (this is what answer_only still allows through).
  if (session.status === 'waiting' && ['decision', 'action'].includes(session.category)) {
    return base(snapshot, 'agent.waiting.question', action('answer', 'agent'), 'agent is waiting for an answer', {
      allowedSend: true,
      triggeringSignal: { type: 'agent_question', summary: session.summary || session.question || 'agent asks for direction', ts: session.updatedAt || snapshot.generatedAt, evidenceRef: 'session.category' },
    });
  }

  // 7. Idle wait with no decision/review category. Under autopilot, keep it moving; otherwise a plain nudge
  //    only sends if policy config authorizes idle nudges.
  if (session.status === 'waiting') {
    if (stance === 'autopilot') {
      return base(snapshot, 'stance.autopilot_advance', action('nudge', 'agent'), 'agent idled while the operator wants the work carried to completion (autopilot) — nudge it onward', {
        allowedSend: true,
        triggeringSignal: { type: 'idle_waiting', summary: session.summary || 'agent idle while waiting under autopilot', ts: session.updatedAt || snapshot.generatedAt, evidenceRef: 'operator.stance' },
      });
    }
    return base(snapshot, 'agent.waiting.idle', action('nudge', 'agent'), 'agent is waiting without a decision/review category', {
      allowedSend: !!config.allowIdleNudge,
      suppressionReason: config.allowIdleNudge ? '' : 'idle-nudge-not-authorized-by-policy-config',
      triggeringSignal: { type: 'idle_waiting', summary: session.summary || 'agent idle while waiting', ts: session.updatedAt || snapshot.generatedAt, evidenceRef: 'session.status' },
    });
  }

  // 8. Working sessions need stuck-duration evidence before we intervene.
  if (session.status === 'working' && agent.progressFingerprint?.live) {
    return base(snapshot, 'agent.working.stuck', action('wait'), 'working sessions require stuck-duration evidence before intervention', { suppressionReason: 'working-monitor' });
  }
  return base(snapshot, 'default.none', action('none'), 'no actionable supervisor signal', { suppressionReason: 'no-actionable-signal' });
}
