import { segmentOperatorMessage } from './interpret.js';
import { isStandDownStage } from './stage.js';

function oneLine(s, max = 360) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function latestMessage(snapshot) {
  const msgs = [
    ...asArray(snapshot?.operator?.recentSignals),
    ...asArray(snapshot?.history?.recentOperatorMessages),
  ]
    .filter((m) => m && (m.text || m.content))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  return msgs[0] || null;
}

function collectForwardedReports(snapshot) {
  const out = [];
  for (const m of asArray(snapshot?.operator?.recentSignals)) {
    for (const seg of segmentOperatorMessage(m.text || '')) {
      if (seg.label === 'forwarded_report') out.push({ ts: m.ts || null, text: seg.text, confidence: seg.confidence || 0.75 });
    }
  }
  return out.slice(0, 8);
}

function directIntent(snapshot, msg) {
  const fromDecision = snapshot?.decisionIntent || null;
  if (fromDecision && fromDecision.type && fromDecision.type !== 'none') {
    return {
      type: fromDecision.type,
      text: oneLine(fromDecision.text || msg?.text || ''),
      ts: fromDecision.ts || msg?.ts || null,
      confidence: Number(fromDecision.confidence || 0),
      source: 'operator_directive',
    };
  }
  return { type: 'none', text: '', ts: null, confidence: 0, source: 'none' };
}

function chooseCurrentWork(doc, intent) {
  if (intent.type === 'continue') return doc.remainingWork || intent.text || doc.currentWork || doc.goal || '';
  if (intent.type === 'scope_change' || intent.type === 'correction') return intent.text || doc.currentWork || doc.goal || '';
  return doc.currentWork || doc.goal || '';
}

function nextRequiredAction(session, intent, source, stage, stance) {
  // Mirrors decide.js in label form (durable STANCE + STAGE, not the ephemeral intent). The `correction` /
  // `scope_change` intents survive here because they're about WHICH work is current (doc reconciliation),
  // orthogonal to the push/hold stance.
  if (stance === 'hold') return 'wait';
  // Planning / awaiting plan approval is operator-owned: observe, unless the operator delegated autopilot.
  if (isStandDownStage(stage)) return stance === 'autopilot' ? 'proceed_next_phase' : 'observe_planning_operator_owned';
  if (stance === 'answer_only' && !['decision', 'action'].includes(session.category)) return 'answer_only_or_observe';
  if (intent.type === 'correction' || intent.type === 'scope_change') return 'reconcile_scope_then_continue';
  if (session.status === 'exited') return 'recover_or_escalate_exit';
  if (session.status === 'waiting' && ['decision', 'action'].includes(session.category)) return 'answer_agent_question';
  if (session.status === 'waiting' && session.category === 'review') return stance === 'autopilot' ? 'verify_then_advance' : 'verify_completion';
  if (session.status === 'waiting') return stance === 'autopilot' ? 'proceed_next_phase' : 'resume_idle_work';
  if (session.status === 'working') return 'observe_or_unstick_if_stale';
  return source === 'supervision_doc' ? 'continue_supervision_doc' : 'observe';
}

export function buildCurrentTask(snapshot) {
  const msg = latestMessage(snapshot);
  const intent = directIntent(snapshot, msg);
  const doc = snapshot?.supervisionDoc || {};
  const session = snapshot?.session || {};
  const source = intent.type !== 'none'
    ? 'operator_directive'
    : (doc.currentWork || doc.goal || doc.raw ? 'supervision_doc' : 'session_state');
  const staleDocOverride = intent.type !== 'none' && doc.currentWork
    ? {
        operatorMessageTs: intent.ts,
        operatorText: intent.text,
        docCurrentWork: oneLine(doc.currentWork),
        reason: 'latest direct operator instruction supersedes stale ## Now until reconciliation catches up',
      }
    : null;
  return {
    schema: 'supervisor.current_task',
    source,
    confidence: intent.type !== 'none' ? intent.confidence : (source === 'supervision_doc' ? 0.72 : 0.45),
    directOperatorIntent: intent,
    latestOperatorWordsConsidered: oneLine(msg?.text || ''),
    forwardedReports: collectForwardedReports(snapshot),
    currentWork: oneLine(chooseCurrentWork(doc, intent), 600),
    remainingWork: oneLine(doc.remainingWork || '', 600),
    acceptanceGates: asArray(doc.acceptanceCriteria).map((x) => oneLine(typeof x === 'string' ? x : x?.text || '')).filter(Boolean),
    hardRules: asArray(doc.hardRules).map((x) => oneLine(typeof x === 'string' ? x : x?.text || '')).filter(Boolean),
    decisions: asArray(doc.decisions).map((x) => oneLine(x)).filter(Boolean),
    staleDocOverride,
    nextRequiredAction: nextRequiredAction(session, intent, source, snapshot?.stage?.stage || '', snapshot?.stance || 'normal'),
  };
}
