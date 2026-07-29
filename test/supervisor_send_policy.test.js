import assert from 'node:assert/strict';

const { MODES, modeOf, copilotThreshold, sendPolicy, DEFAULT_COPILOT_CONFIDENCE, cardLifecycleDirective, copilotRecoveryDirective } = await import('../src/agents/supervisor/send_policy.js');
const { DELEGATED_HOW_ADDENDUM, detectsPendingPlanApproval, isNonMutatingCurrentCardReview, enforceAnswerSafety, enforceCopilotCurrentCardReview } = await import('../src/agents/answer_prompt.js');

// Hard reason codes are safety decisions, not advisory labels: a contradictory model action fails closed.
for (const reason_code of ['integrity', 'goal_conflict', 'human_gate']) {
  const guarded = enforceAnswerSafety({ action: 'answer', answer: 'Proceed anyway', reason_code, reason: 'hard blocker' });
  assert.equal(guarded.action, 'escalate');
  assert.equal(guarded.answer, '');
}

// ---- Co-pilot recovery cannot hide inside kind=answer ----------------------------------------------
{
  assert.equal(copilotRecoveryDirective('In co-pilot mode, likewise resume the builder.'), true);
  assert.equal(copilotRecoveryDirective('Monitoring/supervisor modes should use the available resume actuator.'), true);
  assert.equal(copilotRecoveryDirective('Invoke the resume actuator in advisory mode.'), true);
  assert.equal(copilotRecoveryDirective('Co-pilot must NOT invoke the resume actuator.'), false);
  assert.equal(copilotRecoveryDirective('Co-pilot verifies the resume actuator is available and drafts a bounded resume recommendation.'), false);
  assert.equal(copilotRecoveryDirective('Autopilot may invoke the actuator; Co-pilot takes no actuator action.'), false);
}
assert.equal(enforceAnswerSafety({ action: 'answer', answer: 'Use strict', reason_code: 'none' }).action, 'answer');
const planContext = { question: 'Here is my implementation plan. Approve the plan / say go and I will start.' };
assert.equal(detectsPendingPlanApproval(planContext), true);
const reviewedPlan = enforceAnswerSafety({ action: 'answer', answer: 'Add a rollback check, then the plan is ready.', reason_code: 'none' }, planContext);
assert.equal(reviewedPlan.action, 'escalate');
assert.equal(reviewedPlan.answer, '');
assert.match(reviewedPlan.recommendation, /rollback check/, 'Co-pilot plan review survives as an operator recommendation');
assert.equal(detectsPendingPlanApproval({ question: 'The approved plan is executing; choose the strict parser.' }), false);
assert.match(DELEGATED_HOW_ADDENDUM, /all listed alternatives satisfy the established goal/i);
assert.match(DELEGATED_HOW_ADDENDUM, /NEVER overrides[\s\S]{0,220}(?:integrity|Tier-3)/);

// Co-pilot can do useful reality-check work without acquiring card mutation authority.
{
  const currentAsk = { question: 'The criteria are met. Should I close this card and activate the next one?' };
  assert.equal(isNonMutatingCurrentCardReview({
    ...currentAsk,
    answer: 'Do not close or activate either task card. Keep card state unchanged while I verify the current acceptance criteria and test evidence.',
  }), true);
  assert.equal(isNonMutatingCurrentCardReview({
    ...currentAsk,
    answer: 'Close this card after checking the tests and activate the next task card.',
  }), false, 'an asserted transition is not a non-mutating review');
  assert.equal(isNonMutatingCurrentCardReview({
    question: 'You can reopen the log-UI card or leave it closed — say the word.',
    answer: 'Leave the card unchanged while checking evidence.',
  }), false, 'an arbitrary operator option list is not reclassified as current-card review');
  assert.equal(isNonMutatingCurrentCardReview({
    ...currentAsk,
    answer: 'Do not close this card; verify it, then activate the next task card.',
  }), true, 'the semantic helper recognizes the review clause');
  assert.equal(cardLifecycleDirective('Do not close this card; verify it, then activate the next task card.'), true,
    'the independent lifecycle gate still blocks a mixed review-plus-mutation answer');
  assert.equal(cardLifecycleDirective(
    'Do not close the log-UI card or activate the editor card; keep card state unchanged and provide the acceptance-criteria evidence.',
  ), false, 'one explicit negation scopes both coordinated lifecycle verbs');
  assert.equal(cardLifecycleDirective(
    'Do not close the log-UI card, but activate the editor card after this message.',
  ), true, 'a contrastive second lifecycle verb remains an asserted mutation');
  assert.equal(cardLifecycleDirective(
    'Do not close the log-UI card. Activate the editor card after this message.',
  ), true, 'sentence punctuation ends lifecycle refutation scope');

  const prematureEscalation = {
    action: 'escalate',
    answer: '',
    recommendation: 'Verify the acceptance criteria and tests before deciding whether to close it.',
    reason_code: 'scope',
    reserved: true,
    confidence: 0.9,
  };
  const reviewed = enforceCopilotCurrentCardReview(prematureEscalation, {
    ...currentAsk,
    supervisorMode: 'copilot',
  });
  assert.equal(reviewed.action, 'answer', 'Co-pilot does not escalate before doing its evidence review');
  assert.match(reviewed.answer, /state unchanged[\s\S]{0,120}(?:acceptance-criteria|test evidence)/i);
  assert.equal(reviewed.reserved, false);
  assert.equal(cardLifecycleDirective(reviewed.answer), false, 'the deterministic review response cannot mutate card state');
  assert.equal(enforceCopilotCurrentCardReview(prematureEscalation, {
    question: 'Should I close this card in another session?',
    supervisorMode: 'copilot',
  }), prematureEscalation, 'cross-session card work stays outside authority');
  assert.equal(enforceCopilotCurrentCardReview({ ...prematureEscalation, reason_code: 'human_gate' }, {
    ...currentAsk,
    supervisorMode: 'copilot',
  }).action, 'escalate', 'hard gates are never normalized into a send');
  assert.equal(enforceCopilotCurrentCardReview({
    ...prematureEscalation,
    reason: 'The operator must decide whether the product scope should pivot.',
    recommendation: 'Choose the desired product outcome.',
  }, {
    ...currentAsk,
    supervisorMode: 'copilot',
  }).action, 'escalate', 'a real product fork is not disguised as an evidence review');
  assert.equal(enforceCopilotCurrentCardReview(prematureEscalation, {
    ...currentAsk,
    supervisorMode: 'autopilot',
  }), prematureEscalation, 'Autopilot retains its independent task-transition policy');
}

// ---- modeOf: legacy resolution (mode wins; observe_only only as fallback; NEVER default-merged) ----
{
  assert.equal(modeOf({}), 'autopilot', 'legacy config with neither key keeps the pre-mode behavior');
  assert.equal(modeOf({ observe_only: true }), 'observe');
  assert.equal(modeOf({ observe_only: false }), 'autopilot');
  assert.equal(modeOf({ mode: 'copilot', observe_only: true }), 'copilot', 'explicit mode outranks legacy flag');
  assert.equal(modeOf({ mode: 'observe', observe_only: false }), 'observe');
  assert.equal(modeOf({ mode: 'bogus' }), 'autopilot', 'unknown mode falls back to legacy resolution');
  assert.deepEqual(MODES, ['observe', 'copilot', 'autopilot']);
}

// ---- threshold clamping ----
{
  assert.equal(copilotThreshold({}), DEFAULT_COPILOT_CONFIDENCE);
  assert.equal(copilotThreshold({ copilot_confidence: 0.5 }), 0.5);
  assert.equal(copilotThreshold({ copilot_confidence: 7 }), 1);
  assert.equal(copilotThreshold({ copilot_confidence: -1 }), 0);
  assert.equal(copilotThreshold({ copilot_confidence: 'NaNish' }), DEFAULT_COPILOT_CONFIDENCE);
}

// ---- observe: everything drafts (except operator) ----
for (const kind of ['answer', 'challenge', 'nudge', 'recover']) {
  const p = sendPolicy('observe', kind, { confidence: 1, reserved: false });
  assert.equal(p.allowed, false, `observe blocks ${kind}`);
  assert.equal(p.reason, 'mode-observe');
}

// ---- autopilot: everything sends ----
for (const kind of ['answer', 'challenge', 'nudge', 'recover']) {
  assert.equal(sendPolicy('autopilot', kind, {}).allowed, true, `autopilot sends ${kind}`);
}

// ---- operator kind bypasses every mode ----
for (const mode of MODES) {
  assert.equal(sendPolicy(mode, 'operator', {}).allowed, true, `operator relay sends in ${mode}`);
}

// ---- copilot matrix ----
{
  // challenges (evidence demands) always send
  assert.equal(sendPolicy('copilot', 'challenge', {}).allowed, true);
  // nudges and recoveries draft, with distinguishable reasons
  assert.deepEqual(sendPolicy('copilot', 'nudge', {}), { allowed: false, reason: 'mode-copilot-holds-nudge' });
  assert.deepEqual(sendPolicy('copilot', 'recover', {}), { allowed: false, reason: 'mode-copilot-holds-recover' });
  // confident non-reserved answer sends
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.9, reserved: false }).allowed, true);
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.8, reserved: false }).allowed, true, 'threshold is inclusive');
  // below threshold drafts
  assert.deepEqual(sendPolicy('copilot', 'answer', { confidence: 0.79, reserved: false }), { allowed: false, reason: 'mode-copilot-confidence' });
  // custom threshold honored
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.6, reserved: false, threshold: 0.5 }).allowed, true);
  // FAIL-CLOSED: missing/invalid confidence never sends
  assert.deepEqual(sendPolicy('copilot', 'answer', { reserved: false }), { allowed: false, reason: 'mode-copilot-no-confidence' });
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 'high', reserved: false }).allowed, false);
  // FAIL-CLOSED: reserved missing or true never sends (model must positively confirm reserved:false)
  assert.deepEqual(sendPolicy('copilot', 'answer', { confidence: 0.95 }), { allowed: false, reason: 'mode-copilot-reserved-unconfirmed' });
  assert.equal(sendPolicy('copilot', 'answer', { confidence: 0.95, reserved: true }).allowed, false);
}

// ---- unknown mode string degrades to legacy autopilot behavior (never bricks sends) ----
assert.equal(sendPolicy('weird', 'answer', {}).allowed, true);

// ---- cardLifecycleDirective: the operator-reserved card-admin backstop (self-echo incident) ----
{
  // THE incident text (verbatim shape) must be caught in every mode
  assert.equal(cardLifecycleDirective('Start the pending \u201cWorkflow Editor design + connection fixes\u201d card as the active task. Treat the Workflow log UI redesign card as done/closed rather than merging the two goals; preserve its history, then continue on the editor card.'), true, 'the real incident directive is caught');
  assert.equal(cardLifecycleDirective('Close the current card as done and start the next one.'), true);
  assert.equal(cardLifecycleDirective('Activate task card task_9caa308172.'), true);
  assert.equal(cardLifecycleDirective('Abandon this card; the goal moved.'), true);
  assert.equal(cardLifecycleDirective('Treat the log-UI work as done and move on.'), true);
  assert.equal(cardLifecycleDirective('Resume the paused card for the editor work.'), true);
  // Explicit refutations describe the safety boundary; they are not instructions to mutate state.
  assert.equal(cardLifecycleDirective('Do not create, close, activate, or otherwise mutate Supervisor task cards. Stay on the current work while I verify it.'), false);
  assert.equal(cardLifecycleDirective('The builder must never close the current task card.'), false);
  assert.equal(cardLifecycleDirective("The builder doesn't open, close, or switch Supervisor task cards. Stay on the current work while I verify it."), false);
  assert.equal(cardLifecycleDirective('The builder does not open, close, or switch Supervisor task cards.'), false);
  assert.equal(cardLifecycleDirective("Don't change any card state — builders don't close, open, or activate Supervisor cards, and that stays true here. The log-UI card remains open and the editor card stays inactive while I review the completion evidence."), false,
    'captured safe Co-pilot review is not converted into card administration');
  assert.equal(cardLifecycleDirective('The current card is open and the next task card is inactive while evidence is reviewed.'), false,
    'describing an open card is not an imperative lifecycle action');
  // Refutation scope is clause-local: an asserted lifecycle instruction nearby must still fire.
  assert.equal(cardLifecycleDirective('Do not close the current card; activate the next task card now.'), true);
  assert.equal(cardLifecycleDirective('Never start cards in another project. Close the current task card now.'), true);
  assert.equal(cardLifecycleDirective('The current card remains open and activate the next task card now.'), true,
    'a state adjective cannot consume and hide a later asserted transition in the same clause');
  // Ordinary engineering directives must NOT trip it — builders legitimately work ON card UI code
  assert.equal(cardLifecycleDirective('Fix the null deref in renderTaskCard and add a test.'), false);
  assert.equal(cardLifecycleDirective('Add a Dismiss button to the card banner component.'), false);
  assert.equal(cardLifecycleDirective('Run the suite, then commit.'), false);
  assert.equal(cardLifecycleDirective('The card component should render the archive drawer collapsed.'), false);
  assert.equal(cardLifecycleDirective(''), false);
  assert.equal(cardLifecycleDirective(null), false);
}

// ---- source locks: the self-echo guards stay wired into the live answer path ----
{
  const { readFileSync } = await import('node:fs');
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(sup, /cfg\.mode === 'autopilot' \? AUTOPILOT_SCOPE_CARD_ADMIN_ADDENDUM : SCOPE_CARD_ADMIN_ADDENDUM/, 'runAnswer selects the mode-specific current-session task-management contract');
  assert.match(sup, /cardLifecycleDirective\(answer\)/, 'deterministic lifecycle guard runs on the drafted answer');
  assert.match(sup, /cfg\.mode === 'copilot' && copilotRecoveryDirective\(answer\)/,
    'Co-pilot answer text cannot bypass the state-changing recovery lane');
  assert.match(sup, /BETWEEN TASKS: there is NO active contract/, 'between-tasks answers are restraint-scoped');
  assert.match(sup, /activeTaskId: null, activeCardVersion: null, activeCardHash: null/, 'between-tasks clears stale contract attribution');
  const ap = readFileSync(new URL('../src/agents/answer_prompt.js', import.meta.url), 'utf8');
  assert.match(ap, /SCOPE & CARD ADMINISTRATION — HARD RULES/, 'addendum text present');
  assert.match(ap, /not your jurisdiction/i, 'subject-matter vs jurisdiction rule present');
  assert.match(ap, /Co-pilot does not perform the transition[\s\S]{0,180}OWNS the completion-evidence review/, 'Co-pilot reviews current-task evidence instead of forwarding it raw');
  assert.match(ap, /never ask the operator to perform the evidence review/, 'Co-pilot cannot punt its own reality check to the operator');
  assert.match(ap, /escalation is the LAST step after checking available reality/, 'Co-pilot escalation is reality-first');
  const pm = readFileSync(new URL('../src/agents/supervisor/project_memory.js', import.meta.url), 'utf8');
  assert.match(pm, /Choosing, starting, or closing/, 'between-tasks contract names card admin as operator territory');

  // Choke point: the dispatcher blocks card-lifecycle text on EVERY path/mode except the operator
  // relay — so no current or future call site can forget the guard.
  const disp = readFileSync(new URL('../src/agents/supervisor/dispatch.js', import.meta.url), 'utf8');
  assert.match(disp, /ruleId !== 'hold\.resolve_send' && cardLifecycleDirective\(msg\)/, 'dispatcher-level lifecycle block, operator relay exempt');
  assert.match(disp, /card-lifecycle-operator-reserved/, 'distinct suppression reason for the panel feed');
  // Between tasks, verify must not inflate the project DoD/spec into the contract.
  assert.match(sup, /BETWEEN_TASKS_ADDENDUM: There is NO active task card/, 'verify carries the between-tasks scope bound');
  // The jurisdiction addendum rides EVERY steering prompt, not just answers.
  assert.match(sup, /SYS_UNSTICK \+ '\\n\\n' \+ SCOPE_CARD_ADMIN_ADDENDUM/, 'unstick prompt carries jurisdiction rules');
  assert.ok(/sys \+= '\\n\\n' \+ SCOPE_CARD_ADMIN_ADDENDUM; \/\/ self-echo hardening: verify/.test(sup), 'verify prompt carries jurisdiction rules');
}

// ---- audience gate (self-echo first domino, v0.3.29) ----
{
  const { readFileSync } = await import('node:fs');
  const sup = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  // model classifies audience; CODE owns delivery: explicit Supervisor Autopilot OR the legacy
  // chat-derived stance is delegation. Without either, operator_choice never delivers.
  assert.match(sup, /managementDelegated = cfg\.mode === 'autopilot' \|\| resolveStance\(ctx\.getState\(\)\.operatorStance\) === 'autopilot'/,
    'explicit Supervisor Autopilot and the legacy stance both count as management delegation');
  assert.match(sup, /audience.{0,40}=== 'operator_choice' && !managementDelegated/,
    'deterministic audience gate on the model field');
  assert.match(sup, /!managementDelegated && !copilotCardReview/,
    'a narrowly non-mutating current-card evidence review is not reduced to a bare Co-pilot escalation');
  assert.match(sup, /cfg\.mode === 'autopilot' \? AUTOPILOT_PLAN_ADDENDUM : STAGE_ADDENDUM/, 'Autopilot reviews and acts on submitted plans; Co-pilot reviews and recommends without builder approval');
  assert.match(sup, /audience=\$\{String\(parsed\.audience\)/, 'audience surfaced in intervention rows for forensics + lab grading');
  const ap = readFileSync(new URL('../src/agents/answer_prompt.js', import.meta.url), 'utf8');
  assert.match(ap, /"audience":"builder_blocked"/, 'addendum defines the audience field');
  assert.match(ap, /Do not escalate solely because the audience is the operator/, 'model answers on merits; the gate decides delivery');
  assert.match(ap, /reversible implementation-method choice[\s\S]{0,180}not a product-scope fork/i, 'autopilot distinguishes reversible HOW choices from operator-owned WHAT choices');
  // the lab exists and covers the incident matrix
  const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
  for (const sc of ['1-self-echo-cross-session', '2-card-lifecycle-block', '3-reserved-deploy-menu', '4-operator-audience', '4b-audience-autopilot-delegation', '5-stage-plan-approval', '6-context-footer-not-wedge', '7-model-403-switch', '8-dig-for-truth', '9-between-tasks-dod-bound', '10-goal-doubt-hold']) {
    assert.ok(lab.includes(sc), `lab scenario ${sc} present`);
  }
  assert.match(sup, /export const __lab/, 'lab seam exported');
  // Boundary judgment: between-tasks bias flip + the work-derived trigger (card-never-updated incident)
  assert.match(sup, /BETWEEN TASKS \(no active card\) the bar FLIPS/, 'boundary prompt flips conservatism between tasks');
  assert.match(sup, /RECENT COMMITTED WORK \(git log, newest first\)/, 'work-derived boundary path exists');
  assert.match(sup, /boundaryWorkTs/, 'work-derived recheck spacing state');
  assert.match(sup, /boundaryWorkFp === wfp/, 'work-derived trigger keyed on the commit set, not wall-clock (first live test lockout)');
  assert.match(sup, /Advance the evidence baseline at the close boundary/, 'baseRef advances when a card closes — audits scope to current work');
  assert.match(sup, /unstickSys \+= '\\n\\n' \+ STAGE_ADDENDUM/, 'unstick carries the Co-pilot plan-review boundary');
  assert.match(sup, /OPERATOR RECORD — HARD RULE/, 'unstick may not invent operator instructions');
  assert.match(sup, /evidence\.operator_messages = lc/, 'unstick evidence includes the operator record');
  assert.match(sup, /BOUNDARY_FRESH_MS/, 'stale pending suggestions supersede instead of freezing card detection');
  const panel = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
  assert.match(panel, /pm-between-title/, 'merged between-tasks empty state');
  assert.ok(!/sup-empty-doc">No active task card/.test(panel), 'redundant second empty box removed');
  const uilab = readFileSync(new URL('../scripts/ui-lab.mjs', import.meta.url), 'utf8');
  assert.match(uilab, /between-tasks-state/, 'ui-lab covers the between-tasks usage state');
  assert.match(sup, /if \(ctx\.__betweenTasks\) \{\n    const st0 = ctx\.getState\(\);\n    const bfp = 'between\|'/, 'completion gate stands down between tasks (48s-after-complete loop)');
}

console.log('supervisor_send_policy.test ok');
