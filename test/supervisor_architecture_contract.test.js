import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-supervisor-arch-'));

const { classifyOperatorText, latestOperatorIntentFromSignals, segmentOperatorMessage } = await import('../src/agents/supervisor/interpret.js');
const { buildCurrentTask } = await import('../src/agents/supervisor/current_task.js');
const { filterHardRulesForCurrentTask } = await import('../src/agents/supervisor/challenge.js');
const { decideSupervisorAction } = await import('../src/agents/supervisor/decide.js');
const { dispatchSupervisorSend, triggeringSignal, recordSupervisorDecision } = await import('../src/agents/supervisor/dispatch.js');
const { guardSupervisorSendContext } = await import('../src/agents/supervisor/context_guard.js');
const { applySupervisorState } = await import('../src/agents/supervisor/effects.js');
const { decisionHistory, latestDecision } = await import('../src/agents/supervisor/decision_records.js');

{
  assert.equal(classifyOperatorText('not ask for fixing anything but answer my question only').kind, 'question_only');
  assert.equal(classifyOperatorText('hold on, do nothing for now').kind, 'wait');
  assert.equal(classifyOperatorText('what are you working on?').kind, 'status_question');
  assert.equal(classifyOperatorText("Fix all the issues quickly, and start using multiple sub-agents to speed things up. You've spent too much time on the task.").kind, 'continue');
  assert.equal(classifyOperatorText('Goal 1 is done, keep going and start what is left').kind, 'continue');
  const forwardedOnly = latestOperatorIntentFromSignals({ messages: [{ ts: 1782400000000, text: 'Codex status: go ahead and deploy' }] }, 1782400001000);
  assert.equal(forwardedOnly, null, 'forwarded agent report must not become operator intent');
  const mixed = segmentOperatorMessage('[from Claude] verified dashboard render — ok ship it');
  assert.equal(mixed[0].label, 'forwarded_report');
  assert.equal(mixed[1].label, 'operator_directive');
  assert.equal(mixed[1].intent, 'continue');
  assert.equal(segmentOperatorMessage('Codex deployed the corrected Admin Devices three-column layout.')[0].label, 'forwarded_report');
  assert.equal(segmentOperatorMessage('Codex is doing a visual QA/fix pass on Admin Devices.')[0].label, 'forwarded_report');
  const statusWins = latestOperatorIntentFromSignals({
    messages: [
      { ts: 1782400002000, text: 'what are you working on?' },
      { ts: 1782400000000, text: 'OK, I saw the status change' },
    ],
  }, 1782400003000);
  assert.equal(statusWins.kind, 'status_question');
}

const baseSnapshot = {
  schema: 'supervisor.snapshot',
  generatedAt: 1782400000000,
  session: { id: 's_arch', status: 'waiting', category: 'review', summary: 'done claim', updatedAt: 1782400000000 },
  operator: { intent: 'question_only', lastMessageText: 'answer only', lastMessageTs: 1782399999000, intentConfidence: 0.98 },
  decisionIntent: { type: 'question_only', text: 'answer only', ts: 1782399999000, confidence: 0.98 },
  supervisionDoc: { raw: '# Goal\n\n## Acceptance criteria\n- [ ] Works', gateScopeKey: 'g1' },
  supervisorState: {},
  agent: {},
};
const neutralSnapshot = {
  ...baseSnapshot,
  operator: { intent: 'none', lastMessageText: '', lastMessageTs: null, intentConfidence: 0 },
  decisionIntent: { type: 'none', text: '', ts: null, confidence: 0 },
  currentTask: {
    schema: 'supervisor.current_task',
    source: 'supervision_doc',
    confidence: 0.72,
    directOperatorIntent: { type: 'none', text: '', ts: null, confidence: 0, source: 'none' },
    latestOperatorWordsConsidered: '',
    forwardedReports: [],
    currentWork: 'ship safely',
    acceptanceGates: [],
    hardRules: [],
    decisions: [],
    staleDocOverride: null,
    nextRequiredAction: 'observe',
  },
};

{
  // DURABLE STANCE drives the policy now (not the ephemeral regex intent). answer_only → a completion
  // review is observed, not gated.
  const d = decideSupervisorAction({ ...baseSnapshot, stance: 'answer_only' });
  assert.equal(d.ruleId, 'operator.answer_only');
  assert.equal(d.action.type, 'wait');
  assert.equal(d.allowedSend, false);
  assert.equal(d.suppressionReason, 'answer-only');
}

{
  // hold → stand down silently, whatever the agent is doing.
  const d = decideSupervisorAction({ ...baseSnapshot, stance: 'hold' });
  assert.equal(d.ruleId, 'operator.hold');
  assert.equal(d.action.type, 'wait');
  assert.equal(d.allowedSend, false);
  assert.equal(d.suppressionReason, 'operator-hold');
}

{
  // autopilot: a phase already verified (gate sent for this scope) ADVANCES to the next phase — the core
  // fix. This must survive without any recent operator message (durable stance), so no operator/intent here.
  const d = decideSupervisorAction({
    ...baseSnapshot,
    stance: 'autopilot',
    operator: { intent: 'none', lastMessageText: '', lastMessageTs: null, intentConfidence: 0 },
    decisionIntent: { type: 'none', text: '', ts: null, confidence: 0 },
    session: { ...baseSnapshot.session, category: 'review' },
    agent: { terminalSignals: ['completion_claim'] },
    supervisorState: { lastGate: { key: 'g1' } },
  });
  assert.equal(d.ruleId, 'stance.autopilot_advance');
  assert.equal(d.action.type, 'nudge');
  assert.equal(d.allowedSend, true);
  assert.equal(d.triggeringSignal.type, 'advance_phase');
}

{
  const d = decideSupervisorAction({
    ...baseSnapshot,
    operator: { intent: 'none', lastMessageText: 'go', lastMessageTs: 1, intentConfidence: 0 },
    decisionIntent: { type: 'none', text: 'go', ts: 1, confidence: 0 },
    session: { ...baseSnapshot.session, category: 'action', question: 'Can I proceed?' },
  });
  assert.equal(d.ruleId, 'agent.waiting.question');
  assert.equal(d.action.type, 'answer');
  assert.equal(d.allowedSend, true);
  assert.equal(d.triggeringSignal.type, 'agent_question');
}

const sent = [];
let state = {};
const ctx = {
  sessionId: 's_arch',
  getState() { return state; },
  setState(patch) {
    state = { ...state, ...patch };
    return state;
  },
  async sendToAgent(text, opts) {
    sent.push({ text, opts });
    return { sent: true, message: '[Supervisor] ' + text };
  },
};

{
  const r = await dispatchSupervisorSend(ctx, {
    snapshot: neutralSnapshot,
    ruleId: 'test.send',
    actionType: 'nudge',
    text: 'continue',
    sendOptions: { guarded: true, blockDecision: false },
    allowedSend: true,
    triggeringSignal: triggeringSignal('test_signal', 'fresh test signal', 'fixture'),
    reasons: ['test send'],
  });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  const latest = latestDecision('s_arch');
  assert.equal(latest.ruleId, 'test.send');
  assert.equal(latest.sent, true);
  assert.equal(latest.allowedSend, true);
  assert.equal(latest.triggeringSignal.type, 'test_signal');
}

{
  const r = await dispatchSupervisorSend(ctx, {
    snapshot: baseSnapshot,
    ruleId: 'test.question_only_blocked',
    actionType: 'nudge',
    text: 'keep working',
    sendOptions: { guarded: true, blockDecision: false },
    allowedSend: true,
    triggeringSignal: triggeringSignal('idle_waiting', 'agent went idle', 'fixture'),
    reasons: ['operator latest words should win'],
  });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'operator-latest-words-block-send');
  assert.equal(sent.length, 1, 'question-only guard must block before ctx.sendToAgent');
  assert.equal(latestDecision('s_arch').suppressionReason, 'operator-latest-words-block-send');
}

{
  const r = await dispatchSupervisorSend(ctx, {
    snapshot: neutralSnapshot,
    ruleId: 'test.blocked',
    actionType: 'nudge',
    text: 'blocked',
    allowedSend: true,
    reasons: ['missing trigger must block'],
  });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'missing-triggering-signal');
  assert.equal(sent.length, 1, 'blocked send must not reach ctx.sendToAgent');
  assert.equal(latestDecision('s_arch').ruleId, 'test.blocked');
  assert.equal(latestDecision('s_arch').sent, false);
}

{
  const staleSnapshot = {
    ...neutralSnapshot,
    decisionIntent: { type: 'continue', text: 'Fix all the issues quickly, and start using multiple sub-agents.', ts: 1782400109000, confidence: 0.95 },
    currentTask: {
      ...neutralSnapshot.currentTask,
      source: 'operator_directive',
      directOperatorIntent: { type: 'continue', text: 'Fix all the issues quickly, and start using multiple sub-agents.', ts: 1782400109000, confidence: 0.95 },
      currentWork: 'Fix all the issues quickly, and start using multiple sub-agents.',
      latestOperatorWordsConsidered: 'Fix all the issues quickly, and start using multiple sub-agents.',
      staleDocOverride: {
        operatorMessageTs: 1782400109000,
        operatorText: 'Fix all the issues quickly, and start using multiple sub-agents.',
        docCurrentWork: 'Complete digital employee architecture and LangGraph migration',
        reason: 'latest direct operator instruction supersedes stale ## Now until reconciliation catches up',
      },
    },
  };
  const g = guardSupervisorSendContext({
    snapshot: staleSnapshot,
    actionType: 'challenge',
    text: 'Before sign-off, prove the LangGraph migration and digital employee architecture are complete.',
    triggeringSignal: triggeringSignal('completion_claim', 'agent claims completion', 'fixture'),
    allowedSend: true,
  });
  assert.equal(g.allowedSend, false);
  assert.equal(g.suppressionReason, 'stale-doc-context-blocked');
}

{
  const reportSnapshot = {
    ...neutralSnapshot,
    currentTask: {
      ...neutralSnapshot.currentTask,
      source: 'operator_directive',
      directOperatorIntent: { type: 'continue', text: 'Fix all the issues quickly.', ts: 1782400109000, confidence: 0.95 },
      currentWork: 'Fix all the issues quickly.',
      latestOperatorWordsConsidered: 'Fix all the issues quickly.',
      forwardedReports: [{ ts: 1782400108000, text: 'Codex deployed the corrected Admin Devices three-column layout.', confidence: 0.9 }],
    },
  };
  const g = guardSupervisorSendContext({
    snapshot: reportSnapshot,
    actionType: 'challenge',
    text: 'Also prove the Admin Devices three-column layout is fixed and deployed.',
    triggeringSignal: triggeringSignal('completion_claim', 'agent claims completion', 'fixture'),
    allowedSend: true,
  });
  assert.equal(g.allowedSend, false);
  assert.equal(g.suppressionReason, 'forwarded-report-context-blocked');
}

{
  recordSupervisorDecision(ctx, {
    snapshot: baseSnapshot,
    ruleId: 'test.noop',
    actionType: 'none',
    suppressionReason: 'no-action',
    triggeringSignal: triggeringSignal('quiet_tick', 'nothing actionable', 'fixture'),
    reasons: ['quiet decisions are persisted'],
  });
  const rows = decisionHistory('s_arch', 10);
  assert(rows.some((r) => r.ruleId === 'test.noop' && r.actionType === 'none'));
}

{
  const next = applySupervisorState(ctx, { gateSentKey: 'g1' }, {
    snapshot: baseSnapshot,
    ruleId: 'test.state_patch',
    triggeringSignal: triggeringSignal('fixture_state_patch', 'state wrapper test', 'fixture'),
    reasons: ['state writes require a decision record'],
  });
  assert.equal(next.gateSentKey, 'g1');
  const latest = latestDecision('s_arch');
  assert.equal(latest.ruleId, 'test.state_patch');
  assert.equal(latest.actionType, 'state');
  assert.deepEqual(latest.statePatch, { gateSentKey: 'g1' });
}

{
  const source = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  const rawSends = [...source.matchAll(/ctx\.sendToAgent\s*\(/g)];
  assert.equal(rawSends.length, 0, 'Supervisor must not bypass dispatch with raw ctx.sendToAgent');
  const rawStateWrites = [...source.matchAll(/ctx\.setState\s*\(/g)];
  assert.equal(rawStateWrites.length, 0, 'Supervisor must not bypass decision effects with raw ctx.setState');
  const effects = readFileSync(new URL('../src/agents/supervisor/effects.js', import.meta.url), 'utf8');
  assert.match(effects, /recordSupervisorDecision/);
  assert.match(effects, /ctx\.setState\(patch\)/);
  assert.match(source, /maybeRecoverUnexpectedExit/);
  assert.match(source, /recover\.unexpected_exit/);
  assert.match(source, /auto_resume_exited/);
  assert.match(source, /supervisorDecisionSummary/);
  assert.match(source, /decisionHistory/);
  assert.match(source, /readSupervisorState/);
  assert.match(source, /supervisorState/);
}

{
  const currentTask = buildCurrentTask({
    generatedAt: 1782400100000,
    decisionIntent: { type: 'continue', text: 'keep going and do LangGraph now', ts: 1782400099000, confidence: 0.95 },
    operator: { recentSignals: [{ ts: 1782400099000, text: '[from Claude] goal 1 verified — keep going and do LangGraph now' }] },
    session: { status: 'waiting', category: 'review' },
    supervisionDoc: {
      goal: 'Refactor supervisor',
      currentWork: 'Goal 1',
      remainingWork: 'Goal 2: LangGraph integration',
      acceptanceCriteria: ['LangGraph integrated and tested'],
    },
  });
  assert.equal(currentTask.source, 'operator_directive');
  assert.equal(currentTask.directOperatorIntent.type, 'continue');
  assert.equal(currentTask.currentWork, 'Goal 2: LangGraph integration');
  assert.equal(currentTask.staleDocOverride.reason.includes('supersedes stale'), true);
  assert.equal(currentTask.forwardedReports.length, 1);
}

{
  const task = buildCurrentTask({
    generatedAt: 1782400110000,
    decisionIntent: { type: 'continue', text: 'Fix all the issues quickly, and start using multiple sub-agents to speed things up.', ts: 1782400109000, confidence: 0.95 },
    operator: { recentSignals: [{ ts: 1782400109000, text: 'Fix all the issues quickly, and start using multiple sub-agents to speed things up.' }] },
    session: { status: 'waiting', category: 'review' },
    supervisionDoc: { goal: 'Architecture upgrade', currentWork: 'Complete architecture doc upgrade', remainingWork: '', acceptanceCriteria: ['Visual evidence is complete'] },
  });
  assert.equal(task.source, 'operator_directive');
  assert.equal(task.currentWork, 'Fix all the issues quickly, and start using multiple sub-agents to speed things up.');
  const rules = filterHardRulesForCurrentTask([
    'Do not introduce or keep LangGraph as the workflow-management solution.',
    'n8n is a template source/importer, not a runtime.',
    'Coordinate shared App.tsx/styles.css work before deploy packaging; do not clobber other sessions changes.',
    'Do not perform a Worker production deploy unless there is explicit operator deploy authorization.',
  ], task);
  assert(!rules.some((r) => /LangGraph|n8n/.test(r)), 'stale architecture rules should not leak into non-architecture current task gates');
  assert(rules.some((r) => /Coordinate shared App\.tsx/.test(r)), 'shared-file safety rules should remain');
  assert(rules.some((r) => /Worker production deploy/.test(r)), 'deploy safety rules should remain');
}

{
  const host = readFileSync(new URL('../src/agents/host.js', import.meta.url), 'utf8');
  assert.match(host, /tickOnExitedMs/);
  const context = readFileSync(new URL('../src/agents/context.js', import.meta.url), 'utf8');
  assert.match(context, /resumeSession/);
}

{
  const ui = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
  // Send-authority mode is a tri-state segmented control, not a hidden boolean: all four segments exist,
  // the mode saves draft-first (full-draft save), and observe_only is only ever DERIVED from the mode.
  assert.match(ui, /id="sup-mode"/, 'mode segmented control must exist');
  assert.match(ui, /id="sup-mode-\$\{m\}"/, 'segments carry stable per-mode ids');
  for (const m of ['off', 'observe', 'copilot', 'autopilot']) assert.match(ui, new RegExp(`seg\\('${m}',`), `mode segment ${m}`);
  assert.match(ui, /cfg\.observe_only = cfg\.mode === 'observe'/, 'observe_only must be derived from mode, never set directly');
  assert.doesNotMatch(ui, /id="sup-observe"/, 'the legacy observe-only checkbox is gone (the mode control replaced it)');
  assert.doesNotMatch(ui, /id="sup-fallbacks"/, 'the raw comma-separated chain input is gone (the chain editor replaced it)');
  assert.match(ui, /id="sup-chain-add"/, 'chain editor add-select exists');
  assert.match(ui, /optgroup/, 'chain add-select groups models by provider');
  assert.match(ui, /Policy Decision/);
  assert.match(ui, /Supervisor State/);
  assert.match(ui, /latestDecision/);
  assert.match(ui, /decisionHistory/);
  assert.match(ui, /supervisorState/);
  assert.match(ui, /Operator intent/);
  assert.match(ui, /Latest words considered/);
  assert.match(ui, /Direct operator span/);
  assert.match(ui, /Forwarded:/);
  assert.match(ui, /Doc override/);
  assert.match(ui, /Suppression/);
  assert.doesNotMatch(ui, /id="sup-sync"/, 'Supervisor UI must not expose a manual catch-up button');
  assert.doesNotMatch(ui, /Keep the doc current automatically/, 'doc catch-up must be always-on, not a user toggle');
  assert.match(ui, /cfg\.self_maintaining_doc = true/, 'saving settings must heal old disabled auto-doc configs');
  assert.match(ui, /review_template/, 'review behavior must be a separate config field');
  assert.match(ui, /id="sup-review-template"/, 'settings must expose a separate review-behavior editor');
  assert.match(ui, /Save behavior template/, 'templates must save standing review behavior, not session docs');
  assert.match(ui, /Load behavior template/, 'templates must load into standing review behavior, not session docs');
  assert.match(ui, /body: draft\.review_template/, 'template-save must send review_template as body');
  assert.doesNotMatch(ui, /Save as template/, 'session docs must not be saved as reusable templates');
  assert.doesNotMatch(ui, /Load template…/, 'session docs must not be replaced from template controls');
  assert.doesNotMatch(ui, /draft\.doc\s*=\s*t\.doc/, 'loading a template must not overwrite the session supervision doc');
  const source = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
  // Send-authority mode: every send funnels through the kind-aware gate, and the reserved-approval
  // hardening is compiled-in (appended like STAGE_ADDENDUM — NOT inside the playbook-swappable SYS_ANSWER,
  // which the supervisor_playbooks table would swallow on existing installs).
  assert.match(source, /RESERVED_APPROVAL_ADDENDUM/, 'reserved-approval addendum must be appended in runAnswer');
  assert.match(source, /from '\.\/supervisor\/send_policy\.js'/, 'send gate must come from the pure send_policy module');
  assert.doesNotMatch(source, /canSend\(ctx, cfg\)[^,a-z]/, 'every canSend call must name its message kind');
  assert.doesNotMatch(source, /defaults:\s*{[^}]*mode:/s, 'mode must NEVER be defaulted (it would silently re-mode legacy grants)');
  assert.doesNotMatch(source, /if \(cfg\.self_maintaining_doc && cfg\.doc/, 'runtime doc catch-up must not depend on an optional config flag');
  assert.match(source, /DOC_AUTOGEN_RETRY_MS/, 'missing-doc auto-generation must be rate-limited, not a hot loop');
  assert.match(source, /ensureSupervisionDoc\(ctx, cfg, \{ trigger: 'auto'/, 'missing supervision docs must be generated automatically on tick');
  assert.match(source, /Generated the missing supervision doc/, 'auto-generated supervision docs must be logged as doc updates');
  assert.match(source, /review_behavior_template/, 'review behavior template must travel as separate rubric evidence');
  assert.match(source, /body\?\.(body|review_template)/, 'template-save must accept a behavior-template body, not only a doc');
  const verify = readFileSync(new URL('../src/agents/supervisor/verify.js', import.meta.url), 'utf8');
  assert.match(verify, /TEMPLATE SEPARATION/, 'verifier must treat review templates as rubric only, not task scope');
}

console.log('supervisor_architecture_contract.test ok');
