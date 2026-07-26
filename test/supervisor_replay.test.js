import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { decideSupervisorAction } = await import('../src/agents/supervisor/decide.js');
const { parseSupervisionDoc } = await import('../src/agents/supervisor/doc_model.js');
const { readSupervisorState } = await import('../src/agents/supervisor/state.js');
const {
  VERIFY_EVIDENCE_VERSION,
  VERIFY_PROMPT_VERSION,
  buildVerifierSystemPrompt,
  isVisualWork,
  normalizeVerificationResult,
  verifierContractScope,
} = await import('../src/agents/supervisor/verify.js');

assert.equal(VERIFY_PROMPT_VERSION, 'supervisor.verify.2026-07-23.2');
assert.equal(VERIFY_EVIDENCE_VERSION, 'supervisor.evidence.2026-07-23.2');

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
  assert.match(prompt.systemPrompt, /DECISIVE EVIDENCE CHECKS/);
  assert.match(prompt.systemPrompt, /still screenshot or text visible in a composer proves only that pixels rendered/i);
  // The rubric must offer the out-of-band blind-channel kind (proof served at a URL / committed
  // artifacts / chat-only), so the verifier reports the unreadable channel instead of re-demanding it.
  assert.match(prompt.systemPrompt, /out_of_band/);
  const result = normalizeVerificationResult({ verdict: 'complete', score: 101, assessment: 'ok', unmet: ['none'], goal_conflict: false, unverifiable: 'bad', message_to_agent: '' });
  assert.equal(result.schema, 'supervisor.verify_result');
  assert.equal(result.score, 100);
  assert.equal(result.unverifiable, 'none');
  assert.deepEqual(result.missingEvidence, ['none']);
  // out_of_band is a real blind-channel kind and must survive normalization (it drives the
  // escalate-once-then-quiet loop-breaker, identical to no_git/auth_wall).
  const oob = normalizeVerificationResult({ verdict: 'needs_attention', score: 55, assessment: 'proof is served at /review but not in git or the screenshot', unmet: [], goal_conflict: false, unverifiable: 'out_of_band', message_to_agent: '' });
  assert.equal(oob.unverifiable, 'out_of_band');

  // Development regression: between tasks, a repository-wide DoD is background rather than the
  // contract. Remove it mechanically instead of asking a stochastic model to resolve two conflicting
  // instructions ("enumerate every DoD gate" versus "do not demand the full spec").
  const betweenScope = verifierContractScope({
    betweenTasks: true,
    supervisionDocument: '# Between tasks\n\nStand by for the operator to start the next task card.',
    definitionOfDone: 'All five phases of the grand refactor must be complete.',
    definitionOfDoneFiles: ['docs/specs/grand-plan.md'],
    currentOperatorRequirements: {
      acceptance_items: ['Show the exact passing command output before sign-off.'],
    },
  });
  assert.equal(betweenScope.includeDefinitionOfDone, false);
  assert.equal(betweenScope.supervisionDocument, '# Between tasks\n\nNo active task contract. Evaluate only whether the work just reported is honestly evidenced.');
  assert.doesNotMatch(betweenScope.supervisionDocument, /start (the )?next/i);
  assert.equal(betweenScope.definitionOfDone, '');
  assert.deepEqual(betweenScope.definitionOfDoneFiles, []);
  assert.deepEqual(betweenScope.currentOperatorRequirements, {
    acceptance_items: ['Show the exact passing command output before sign-off.'],
  }, 'explicit current operator requirements remain a between-task sign-off gate');
  const activeScope = verifierContractScope({
    betweenTasks: false,
    supervisionDocument: '# Active task\n\nShip the storage slice.',
    definitionOfDone: 'All five phases of the grand refactor must be complete.',
    definitionOfDoneFiles: ['docs/specs/grand-plan.md'],
  });
  assert.equal(activeScope.includeDefinitionOfDone, true, 'active-task DoD enforcement remains intact');
  assert.equal(activeScope.supervisionDocument, '# Active task\n\nShip the storage slice.', 'active-task document remains intact');

  // Corroborated renders in an unreadable channel are still a hold, but not a "nothing rendered"
  // failure. A dedicated prompt must replace—not accompany—the generic missing-visual prompt.
  const outOfBandPrompt = buildVerifierSystemPrompt({
    visualWork: true,
    hasVisualProof: false,
    hasOutOfBandEvidence: true,
  });
  assert.deepEqual(outOfBandPrompt.addenda, ['out_of_band_visual']);
  assert.doesNotMatch(outOfBandPrompt.systemPrompt, /VISUAL PROOF REQUIRED/);
  assert.match(outOfBandPrompt.systemPrompt, /set "unverifiable" to "out_of_band"/);
  assert.match(outOfBandPrompt.systemPrompt, /do not state that no visual evidence exists/i);

  const conflict = normalizeVerificationResult({
    verdict: 'needs_attention',
    score: 80,
    assessment: 'The active task conflicts with the authoritative spec.',
    unmet: [],
    goal_conflict: true,
    unverifiable: 'none',
    message_to_agent: '',
  });
  assert.equal(conflict.goal_conflict, true, 'genuine active-task goal doubt still arms the hold path');
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

// Integration locks (source-level, like supervisor_engagement.test.js): the OUT-OF-BAND CHANNEL
// PERSISTENCE guard must stay wired. Without it, blindEscalatedFp is per-work-state (fp.work), so a
// session whose proof is structurally out-of-band (served /review) re-fires the whole completion gate
// on every commit — the repeated "attach the artifacts" loop. These asserts fail if the guard is removed.
{
  const { readFileSync } = await import('node:fs');
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup, /verifierContractScope\(\{[\s\S]{0,180}betweenTasks: !!ctx\.__betweenTasks/, 'live verifier mechanically scopes project DoD away between tasks');
  assert.match(sup, /currentOperatorRequirements: opReq/, 'live verifier passes current operator gates through contract scoping');
  assert.match(sup, /supervision_doc: contractScope\.supervisionDocument/, 'live verifier uses the bounded between-task document');
  assert.match(sup, /current_operator_requirements: contractScope\.currentOperatorRequirements/, 'live evidence retains current operator gates independently of project DoD');
  assert.match(sup, /hasOutOfBandEvidence: !!outOfBandEvidence/, 'live verifier selects the dedicated rendered-out-of-band prompt');
  assert.match(sup, /const outOfBandStanding = !!st\.outOfBandEscalatedAt && !hasOperatorMessageSince/, 'out-of-band standing flag is computed session-level');
  assert.match(sup, /!gateRecentlySent && !outOfBandStanding/, 'completion gate stops re-challenging while the out-of-band channel is standing');
  assert.match(sup, /parsed\.unverifiable === 'out_of_band' && outOfBandStanding\) return;/, 'a standing out-of-band verdict does not re-escalate to the operator per commit');
  assert.match(sup, /parsed\.unverifiable === 'out_of_band' \? \{ outOfBandEscalatedAt: now\(\) \}/, 'escalating an out-of-band verdict sets the session-level flag');
  assert.match(sup, /else if \(st\.outOfBandEscalatedAt\)[\s\S]{0,220}outOfBandEscalatedAt: null/, 'a clean git-verifiable verdict clears the flag so the gate re-engages');
}

console.log('supervisor_replay.test ok');
