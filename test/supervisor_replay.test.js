import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { decideSupervisorAction } = await import('../src/agents/supervisor/decide.js');
const { parseSupervisionDoc } = await import('../src/agents/supervisor/doc_model.js');
const { readSupervisorState } = await import('../src/agents/supervisor/state.js');
const { buildVerifierSystemPrompt, isVisualWork, normalizeVerificationResult } = await import('../src/agents/supervisor/verify.js');

function merge(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return b ?? a;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
    return out;
  }
  return b ?? a;
}

const baseSnapshot = {
  schema: 'supervisor.snapshot',
  generatedAt: 1782400000000,
  session: { id: 's_replay', projectId: 'p_aios', status: 'waiting', category: '', title: 'Replay', summary: '', question: '', updatedAt: 1782400000000 },
  operator: { intent: 'none', lastMessageText: '', lastMessageTs: null, intentConfidence: 0, intentEvidence: [] },
  decisionIntent: { type: 'none', text: '', ts: null, confidence: 0 },
  agent: { status: 'waiting', reportedCompletion: false, reportedQuestion: false, progressFingerprint: {}, terminalSignals: [], apiErrorSignals: [], contextWindowSignals: [] },
  work: { changedFiles: [], evidenceBrief: '', missingEvidence: [], visualEvidence: [] },
  supervisionDoc: { raw: '# Goal\nShip safely\n\n## Acceptance criteria\n- [ ] evidence exists', goal: 'Ship safely', currentWork: '', remainingWork: '', acceptanceCriteria: ['evidence exists'], hardRules: [], decisions: [], staleWarnings: [], gateScopeKey: 'default' },
  supervisorState: { signedOff: false, activeHold: null, lastGate: { fp: null, key: null, at: null }, lastDecision: null, verifiedWorkFp: null, questionOnlyReview: null, recoveryState: {} },
  history: { recentSupervisorDecisions: [], recentAgentMessages: [], recentOperatorMessages: [], relevantPrecedents: [], relevantLessons: [] },
};

{
  const doc = parseSupervisionDoc(`# Goal
Improve Supervisor

## Now
- Build replay fixtures

## Hard rules
- Every send needs an operator intent and signal

## Acceptance criteria
- [ ] Replay tests pass
- [x] Decision records exist

## Decisions & agreements
- Continue remaining work after prerequisites are met
`);
  assert.equal(doc.goal, 'Improve Supervisor');
  assert.equal(doc.currentWork, 'Build replay fixtures');
  assert.deepEqual(doc.hardRules, ['Every send needs an operator intent and signal']);
  assert.equal(doc.acceptanceCriteria[0].text, 'Replay tests pass');
  assert.equal(doc.acceptanceCriteria[0].done, false);
  assert.equal(doc.acceptanceCriteria[1].done, true);
  assert.deepEqual(doc.decisions, ['Continue remaining work after prerequisites are met']);
}

{
  const st = readSupervisorState({
    verifiedWorkFp: 'abc',
    gateSentKey: 'goal-1',
    needsOperatorHold: { reason: 'goal_conflict', at: 1782400000000 },
    errSig: 'rate limit',
    ctxWedgeAt: 1782400001000,
  }, [{ id: 'sd_1', ruleId: 'operator.wait' }]);
  assert.equal(st.signedOff, true);
  assert.equal(st.activeHold.reason, 'goal_conflict');
  assert.equal(st.activeHold.clearCondition, 'operator-resolve-or-new-evidence');
  assert.equal(st.lastGate.key, 'goal-1');
  assert.equal(st.lastDecision.id, 'sd_1');
  assert.equal(st.recoveryState.errSig, 'rate limit');
}

{
  assert.equal(isVisualWork({ git: { stat: 'web/agents/supervisor.js | 12 +++++' } }, ''), true);
  assert.equal(isVisualWork({ git: { stat: 'README.md | 2 +' } }, 'render screenshot required'), true);
  assert.equal(isVisualWork({ git: { stat: 'src/store.js | 2 +' } }, 'database migration'), false);
  const prompt = buildVerifierSystemPrompt({ hasDefinitionOfDone: true, visualWork: true, hasVisualProof: false, hasPriorVerifications: true, hasFailurePatterns: true });
  assert.deepEqual(prompt.addenda, ['definition_of_done', 'visual_proof_required', 'prior_verifications', 'failure_patterns']);
  assert.match(prompt.systemPrompt, /VISUAL PROOF REQUIRED/);
  assert.match(prompt.systemPrompt, /PRODUCT_AUDIT/);
  assert.match(prompt.systemPrompt, /PRODUCT WALKTHROUGH/);
  assert.match(prompt.systemPrompt, /CURRENT_OPERATOR_REQUIREMENTS/);
  assert.match(prompt.systemPrompt, /OPERATOR LATEST WORDS WIN/);
  const result = normalizeVerificationResult({ verdict: 'complete', score: 101, assessment: 'ok', unmet: ['none'], goal_conflict: false, unverifiable: 'bad', message_to_agent: '' });
  assert.equal(result.schema, 'supervisor.verify_result');
  assert.equal(result.score, 100);
  assert.equal(result.unverifiable, 'none');
  assert.deepEqual(result.missingEvidence, ['none']);
}

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/supervisor_replay/incidents.json', import.meta.url), 'utf8'));

for (const fx of fixtures) {
  const snapshot = merge(baseSnapshot, fx.snapshot || {});
  const decision = decideSupervisorAction(snapshot, fx.config || {});
  assert.equal(decision.ruleId, fx.expect.ruleId, fx.name + ': ruleId');
  assert.equal(decision.action.type, fx.expect.actionType, fx.name + ': action.type');
  assert.equal(decision.allowedSend, fx.expect.allowedSend, fx.name + ': allowedSend');
  assert.equal(decision.suppressionReason, fx.expect.suppressionReason, fx.name + ': suppressionReason');
  assert.equal(decision.latestOperatorIntent?.type || 'none', fx.expect.intentType, fx.name + ': latestOperatorIntent');
  assert.equal(decision.triggeringSignal?.type || 'none', fx.expect.triggerType, fx.name + ': triggeringSignal');
  assert(decision.audit?.evaluatedRules?.length, fx.name + ': evaluated rules recorded');
  assert(decision.audit?.matchedRules?.includes(fx.expect.ruleId), fx.name + ': matched rule recorded');
  if (decision.allowedSend) {
    assert.notEqual(decision.latestOperatorIntent, null, fx.name + ': send has operator intent');
    assert.notEqual(decision.triggeringSignal, null, fx.name + ': send has triggering signal');
  }
}

console.log('supervisor_replay.test ok');
