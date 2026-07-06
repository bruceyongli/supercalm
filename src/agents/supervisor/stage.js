// Session STAGE — the situational awareness the Supervisor lacked. Its decision engine only modeled
// EXECUTION states (answer the question / keep working / verify completion / unstick). So a session that
// was still PLANNING — the agent proposing a plan, the operator iterating a design doc, the agent asking
// the operator to "say go" — got mis-served: the supervisor tried to answer the operator's design
// questions, nudged the agent to code before the plan was approved, and challenged for completion of work
// that didn't exist yet (incident s_0e9e27b282). Stage lets the policy STAND DOWN while the operator still
// owns the decision, and only intervene once the session is genuinely executing.
//
// Pure + dependency-free so decide.js, observe.js, and the replay eval all import it. The RELIABLE signal
// is the summarizer's semantic `stage` (persisted on session.stage); the regex heuristic here is a
// conservative fallback — it declares planning/awaiting_approval only when confident, so a real execution
// session is never silenced by mistake (standing down wrongly is cheap; jumping in wrongly is the bug).

export const STAGES = ['planning', 'awaiting_approval', 'executing', 'blocked', 'review', 'unknown'];
export const STANDDOWN_STAGES = new Set(['planning', 'awaiting_approval']);
export function isStandDownStage(stage) { return STANDDOWN_STAGES.has(String(stage || '')); }

// Agent is proposing / shaping a plan (not yet implementing).
const PLAN_MARKERS = /\b(here'?s (?:the|my) plan|implementation plan|the plan is|proposed plan|design doc|##\s*plan\b|\bP0\b|\bP1\b|phase 1\b|options?:|approach [ab1-9]\b|trade-?offs?|i'?ll (?:propose|outline|draft|sketch)|let me (?:propose|outline|draft|plan)|before i (?:start|implement|code))\b/i;
// Agent is explicitly asking the operator to approve / choose (operator-owned decision).
const APPROVAL_REQUEST = /\b(say (?:the word|go)|shall i (?:start|proceed|begin|code)|should i (?:start|proceed|begin)|ready to (?:start|implement|code|proceed)|await(?:ing)? (?:your )?(?:approval|go-?ahead|sign-?off|confirmation|the go)|do you want me to (?:start|proceed|build)|want me to (?:start|proceed|build)|\bproceed\?|\bapprove\??|which (?:option|approach|one)|pick (?:one|an option)|would you like me to (?:proceed|start))\b/i;
// Operator is still shaping the plan (iterating a doc, deferring coding, giving another feedback round).
const OPERATOR_PLANNING = /\b(write (?:a|the|another|new)\b[^.\n]*\b(?:doc|plan|design|spec)|another round of feedback|(?:then|before) we (?:can )?(?:start|begin) (?:coding|implementing)|before you (?:start|code|implement)|do ?n'?t (?:start|code|implement) yet|plan first|let'?s plan|revise the (?:plan|doc|design|spec)|\bnot yet\b|finalize the (?:plan|doc|design)|review (?:the|your) plan|take (?:the|this|another|last) (?:round of )?feedback)\b/i;
// Operator gave an explicit GO — flips a planning session to executing.
const OPERATOR_GO = /\b(go ahead|start (?:coding|implementing|building|now)|approved\b|ship it|proceed now|do it now|lgtm,?\s*(?:go|start|ship|proceed)|begin (?:the )?implementation|start the implementation)\b/i;

function agentText(snapshot) {
  const s = snapshot?.session || {};
  const parts = [s.summary, s.question, snapshot?.work?.evidenceBrief];
  for (const m of (snapshot?.history?.recentAgentMessages || [])) parts.push(m?.text || '');
  return parts.filter(Boolean).join('\n');
}
function latestOperatorText(snapshot) {
  const sigs = snapshot?.operator?.recentSignals || snapshot?.history?.recentOperatorMessages || [];
  return sigs.slice(0, 4).map((m) => m?.text || '').join('\n');
}

export function classifyStageHeuristic(snapshot) {
  const session = snapshot?.session || {};
  const agent = snapshot?.agent || {};
  const status = session.status || '';
  const category = session.category || '';
  const text = agentText(snapshot);
  const opText = latestOperatorText(snapshot);
  const diffFiles = (snapshot?.work?.changedFiles || []).length;
  const reasons = [];

  // Auth/access block wins — its remedy is escalate, not stand-down.
  if ((agent.apiErrorSignals || []).includes('auth_error')) return { stage: 'blocked', confidence: 0.8, reasons: ['auth_error'], source: 'heuristic' };

  // Explicit operator GO overrides planning cues -> executing.
  if (OPERATOR_GO.test(opText) && !OPERATOR_PLANNING.test(opText)) return { stage: 'executing', confidence: 0.7, reasons: ['operator_go'], source: 'heuristic' };

  const approvalReq = APPROVAL_REQUEST.test(text);
  const planMarkers = PLAN_MARKERS.test(text);
  const operatorPlanning = OPERATOR_PLANNING.test(opText);

  if (status === 'waiting' && approvalReq && (category === 'decision' || planMarkers || operatorPlanning)) {
    return { stage: 'awaiting_approval', confidence: 0.75, reasons: ['approval_request'], source: 'heuristic' };
  }
  if (operatorPlanning) return { stage: 'planning', confidence: 0.7, reasons: ['operator_planning'], source: 'heuristic' };
  if (planMarkers && diffFiles <= 1) return { stage: 'planning', confidence: 0.65, reasons: ['plan_markers', `diff=${diffFiles}`], source: 'heuristic' };

  if (agent.reportedCompletion || category === 'review') return { stage: 'review', confidence: 0.55, reasons: ['completion_or_review'], source: 'heuristic' };
  if (status === 'working' || diffFiles >= 2) return { stage: 'executing', confidence: 0.5, reasons: ['working_or_diff'], source: 'heuristic' };
  return { stage: 'unknown', confidence: 0.3, reasons: [], source: 'heuristic' };
}

const VALID = new Set(STAGES);
// Prefer the summarizer's semantic stage (session.stage) when present & valid; else the heuristic. A hard
// auth-block from the heuristic still wins (it's a factual terminal signal, not a judgment call).
export function resolveStage(snapshot) {
  const summar = String(snapshot?.session?.stage || '').trim();
  const heur = classifyStageHeuristic(snapshot);
  if (VALID.has(summar) && summar !== 'unknown') {
    if (heur.stage === 'blocked' && summar !== 'blocked') return { ...heur, source: 'heuristic:auth', semanticStage: summar };
    return { stage: summar, confidence: 0.85, reasons: ['summarizer'], source: 'summarizer', heuristicStage: heur.stage };
  }
  return heur;
}
