const PROACTIVE_ACTIONS = new Set(['challenge', 'nudge', 'recover', 'checkpoint']);
const HARD_STOP_INTENTS = new Set(['wait']);
const SOFT_STOP_INTENTS = new Set(['question_only', 'status_question', 'ack']);
const OPERATOR_NEWEST_SLOP_MS = 60 * 1000;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'agent', 'agents', 'all', 'also', 'and', 'are', 'back', 'before',
  'being', 'can', 'claim', 'claims', 'code', 'complete', 'completed', 'current', 'done', 'each',
  'every', 'evidence', 'fix', 'fixed', 'from', 'goal', 'going', 'have', 'into', 'issue', 'issues',
  'just', 'latest', 'make', 'must', 'need', 'needs', 'not', 'now', 'operator', 'out', 'proof',
  'report', 'reported', 'review', 'scope', 'sent', 'session', 'should', 'sign', 'status', 'supervisor',
  'task', 'tests', 'that', 'the', 'their', 'them', 'these', 'this', 'those', 'through', 'using',
  'verify', 'want', 'were', 'what', 'when', 'with', 'work', 'working',
]);

function line(s, max = 360) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function intentFromSnapshot(snapshot) {
  return snapshot?.currentTask?.directOperatorIntent?.type && snapshot.currentTask.directOperatorIntent.type !== 'none'
    ? snapshot.currentTask.directOperatorIntent
    : (snapshot?.decisionIntent || snapshot?.operator || null);
}

function operatorIsNewest(snapshot, intent) {
  const ts = Number(intent?.ts || snapshot?.operator?.lastMessageTs || 0);
  if (!ts) return false;
  const sessionTs = Number(snapshot?.session?.updatedAt || 0);
  if (!sessionTs) return true;
  return sessionTs <= ts + OPERATOR_NEWEST_SLOP_MS;
}

function words(s) {
  const out = new Set();
  for (const m of String(s || '').toLowerCase().match(/[a-z0-9_/-]{4,}/g) || []) {
    const w = m.replace(/^[-_/]+|[-_/]+$/g, '');
    if (w && !STOP_WORDS.has(w)) out.add(w);
  }
  return out;
}

function overlap(textWords, source) {
  let n = 0;
  for (const w of words(source)) if (textWords.has(w)) n++;
  return n;
}

function staleDocLeak(snapshot, text) {
  const stale = snapshot?.currentTask?.staleDocOverride;
  if (!stale) return null;
  const textWords = words(text);
  const staleHits = overlap(textWords, stale.docCurrentWork || '');
  if (staleHits < 2) return null;
  const current = [
    snapshot?.currentTask?.currentWork,
    snapshot?.currentTask?.latestOperatorWordsConsidered,
    snapshot?.currentTask?.directOperatorIntent?.text,
  ].filter(Boolean).join(' ');
  if (overlap(textWords, current) > 0) return null;
  return `message appears anchored to stale doc work "${line(stale.docCurrentWork, 140)}" instead of the latest operator work "${line(current, 140)}"`;
}

function forwardedReportLeak(snapshot, text) {
  const reports = Array.isArray(snapshot?.currentTask?.forwardedReports) ? snapshot.currentTask.forwardedReports : [];
  if (!reports.length) return null;
  const textWords = words(text);
  const direct = [
    snapshot?.currentTask?.currentWork,
    snapshot?.currentTask?.latestOperatorWordsConsidered,
    snapshot?.currentTask?.directOperatorIntent?.text,
  ].filter(Boolean).join(' ');
  for (const r of reports) {
    const reportHits = overlap(textWords, r?.text || '');
    if (reportHits < 2) continue;
    if (overlap(textWords, direct) > 0) continue;
    return `message promotes forwarded report text into a requirement: "${line(r?.text, 160)}"`;
  }
  return null;
}

export function guardSupervisorSendContext({
  snapshot = null,
  actionType = '',
  text = '',
  triggeringSignal = null,
  allowedSend = false,
} = {}) {
  const result = {
    allowedSend: !!allowedSend,
    suppressionReason: '',
    reasons: [],
  };
  if (!allowedSend) return result;

  if (!snapshot?.schema) {
    result.allowedSend = false;
    result.suppressionReason = 'missing-supervisor-snapshot';
    result.reasons.push('agent-facing send has no normalized SupervisorSnapshot');
    return result;
  }

  const action = String(actionType || '').toLowerCase();
  const intent = intentFromSnapshot(snapshot) || {};
  const intentType = String(intent.type || intent.kind || 'none');
  const proactive = PROACTIVE_ACTIONS.has(action);

  if (proactive && HARD_STOP_INTENTS.has(intentType)) {
    result.allowedSend = false;
    result.suppressionReason = 'operator-latest-words-block-send';
    result.reasons.push(`latest operator intent is ${intentType}: "${line(intent.text || snapshot?.operator?.lastMessageText)}"`);
    return result;
  }

  if (proactive && SOFT_STOP_INTENTS.has(intentType) && operatorIsNewest(snapshot, intent)) {
    result.allowedSend = false;
    result.suppressionReason = 'operator-latest-words-block-send';
    result.reasons.push(`latest operator intent is ${intentType} and no newer agent signal supersedes it: "${line(intent.text || snapshot?.operator?.lastMessageText)}"`);
    return result;
  }

  const leak = proactive ? staleDocLeak(snapshot, text) : null;
  if (leak) {
    result.allowedSend = false;
    result.suppressionReason = 'stale-doc-context-blocked';
    result.reasons.push(leak);
    return result;
  }

  const reportLeak = proactive ? forwardedReportLeak(snapshot, text) : null;
  if (reportLeak) {
    result.allowedSend = false;
    result.suppressionReason = 'forwarded-report-context-blocked';
    result.reasons.push(reportLeak);
    return result;
  }

  if (!triggeringSignal?.type) {
    result.allowedSend = false;
    result.suppressionReason = 'missing-triggering-signal';
    result.reasons.push('agent-facing send has no fresh triggering signal');
  }
  return result;
}
