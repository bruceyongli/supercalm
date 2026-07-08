import { recentOperatorSignals } from '../live_context.js';
import { db } from '../../store.js';
import { classifyAgentText, intentForDecision, latestOperatorIntentFromSignals } from './interpret.js';
import { parseSupervisionDoc, criteriaTexts } from './doc_model.js';
import { readSupervisorState } from './state.js';
import { buildCurrentTask } from './current_task.js';
import { resolveStage } from './stage.js';
import { resolveStance } from './stance.js';

function line(s, max = 260) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function gitChangedFiles(git) {
  const text = [git?.status, git?.stat, git?.committed_stat].filter(Boolean).join('\n');
  const out = new Set();
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const stat = l.match(/^(.+?)\s+\|\s+\d+/);
    if (stat) { out.add(stat[1].trim()); continue; }
    const status = l.match(/^[MADRCU?! ]{1,3}\s+(.+)$/);
    if (status) out.add(status[1].trim());
  }
  return [...out].slice(0, 80);
}

function apiErrorSignals(text) {
  const t = String(text || '');
  const out = [];
  if (/\b(429|rate limit|quota|overloaded|temporarily unavailable)\b/i.test(t)) out.push('retryable_api_error');
  if (/\b(401|403|unauthorized|forbidden|invalid api key|auth(?:entication)? failed)\b/i.test(t)) out.push('auth_error');
  if (/\b(5\d\d|socket hang up|ECONNRESET|ETIMEDOUT|network error)\b/i.test(t)) out.push('transport_error');
  return out;
}

function contextWindowSignals(text) {
  const t = String(text || '');
  const out = [];
  if (/\b(context window|context limit|context length|100% context|maximum context|too many tokens)\b/i.test(t)) out.push('context_window_full');
  return out;
}

export function buildSupervisorSnapshot(ctx, {
  cfg = {},
  ev = {},
  st = {},
  fp = {},
  gateKey = '',
  operatorIntent = null,
  generatedAt = Date.now(),
  recentDecisions = [],
  changedImpact = null,
} = {}) {
  const session = ctx?.session?.() || {};
  const project = ctx?.project?.() || {};
  let signals = { messages: [], decisions: [] };
  try { signals = recentOperatorSignals({ db, sessionId: ctx.sessionId }); } catch {}
  // The caller usually passes the intent it already computed with the real db. This fallback only covers
  // tests/manual callers that provide signal-like objects on ev.
  const intent = operatorIntent || latestOperatorIntentFromSignals(ev.operatorSignals || signals, generatedAt);
  const recentMessages = Array.isArray(ev.recent_messages) ? ev.recent_messages : [];
  const lastOperator = (signals.messages || [])[0] || recentMessages.slice().reverse().find((m) => m?.dir === 'in') || null;
  const agentText = [session.summary, session.question, ev.terminal_tail, ...recentMessages.map((m) => m?.text || '')].filter(Boolean).join('\n');
  const agentLabels = classifyAgentText(agentText);
  const doc = String(cfg.doc || '');
  const docModel = parseSupervisionDoc(doc);
  const changedFiles = gitChangedFiles(ev.git || {});
  const normalizedState = readSupervisorState(st, recentDecisions);
  const snapshot = {
    schema: 'supervisor.snapshot',
    generatedAt,
    // Project Memory: the active task card this tick judges against ({id, version, hash} read from
    // task-state keys phase 3 maintains — null until then). Flows into the decision records'
    // task_id/card_version columns so "allowed" stays auditable against a specific contract version.
    task: st.activeTaskId
      ? { id: st.activeTaskId, version: Number.isFinite(st.activeCardVersion) ? st.activeCardVersion : null, hash: st.activeCardHash || null }
      : null,
    session: {
      id: session.id || ctx?.sessionId || '',
      projectId: session.project_id || project.id || null,
      status: session.status || '',
      category: session.category || '',
      stage: session.stage || '', // semantic stage from the summarizer (planning|awaiting_approval|executing|blocked|review)
      title: session.title || '',
      summary: session.summary || '',
      question: session.question || '',
      updatedAt: session.last_activity || null,
      endedAt: session.ended_at || null,
      exitCode: session.exit_code ?? null,
    },
    operator: {
      lastMessageTs: lastOperator?.ts || null,
      lastMessageText: line(lastOperator?.text || ''),
      recentSignals: (signals.messages || []).slice(0, 8).map((m) => ({ ts: m.ts, text: line(m.text, 220) })),
      intent: intent?.kind || 'none',
      intentConfidence: Number(intent?.confidence || 0),
      intentEvidence: intent?.evidence || [],
    },
    agent: {
      status: session.status || '',
      reportedCompletion: agentLabels.includes('completion_claim'),
      reportedQuestion: session.category === 'decision' || session.category === 'action',
      progressFingerprint: fp || {},
      terminalSignals: agentLabels,
      apiErrorSignals: apiErrorSignals(agentText),
      contextWindowSignals: contextWindowSignals(agentText),
    },
    work: {
      gitHead: null,
      baseRef: st.baseRef || null,
      changedFiles,
      changedImpact,
      evidenceBrief: line([ev.git?.stat, ev.git?.committed_stat, ev.terminal_tail].filter(Boolean).join(' | '), 600),
      missingEvidence: [],
      visualEvidence: Array.isArray(ev.images) ? ev.images.map((i) => ({ label: i.label, kind: i.kind, hasData: !!i.dataUrl })) : [],
    },
    supervisionDoc: {
      ...docModel,
      raw: doc,
      acceptanceCriteria: criteriaTexts(docModel),
      acceptanceCriteriaDetail: docModel.acceptanceCriteria,
      staleWarnings: docModel.warnings || [],
      gateScopeKey: gateKey || '',
    },
    supervisorState: normalizedState,
    history: {
      recentSupervisorDecisions: recentDecisions || [],
      recentAgentMessages: recentMessages.slice(-8),
      recentOperatorMessages: (signals.messages || []).slice(0, 8),
      relevantPrecedents: [],
      relevantLessons: [],
    },
    decisionIntent: intentForDecision(intent),
  };
  // Durable operator stance (stance.js), persisted in supervisor state — the standing directive that steers
  // the policy. Set BEFORE stage/currentTask so both can read it. Does not decay; re-set only on a new
  // operator message (supervisor.js classifies it). 'normal' until the operator sets one.
  snapshot.stance = resolveStance(st.operatorStance);
  snapshot.stage = resolveStage(snapshot); // { stage, confidence, reasons, source } — drives the stand-down gate
  snapshot.currentTask = buildCurrentTask(snapshot);
  return snapshot;
}
