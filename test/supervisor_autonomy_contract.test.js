import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aios-autonomy-contract-'));
process.env.AIOS_DATA = DATA_DIR;
process.env.AIOS_NO_LISTEN = '1';
process.on('exit', () => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

const { decideSupervisorAction } = await import('../src/agents/supervisor/decide.js');
const { __lab } = await import('../src/agents/supervisor.js');
const {
  AUTOPILOT_PLAN_ADDENDUM,
  AUTOPILOT_RELEASE_ADDENDUM,
  AUTOPILOT_RECOVERY_ADDENDUM,
  COPILOT_RECOVERY_ADDENDUM,
  isNonMutatingSupervisorCoordination,
  LEARNING_PROVENANCE_ADDENDUM,
  RESERVED_APPROVAL_ADDENDUM,
  SUPERVISOR_COORDINATION_ADDENDUM,
  TIME_CONTINUITY_ADDENDUM,
} = await import('../src/agents/answer_prompt.js');

const plan = {
  generatedAt: 1785170000000,
  stance: 'normal',
  session: {
    id: 's_plan',
    status: 'waiting',
    category: 'decision',
    stage: 'awaiting_approval',
    question: 'Here is the plan. Approve it?',
    summary: 'builder submitted a plan',
    updatedAt: 1785170000000,
  },
  supervisionDoc: { raw: '# Goal\nShip safely', gateScopeKey: 'g1' },
  supervisorState: {},
  operator: {},
  agent: {},
};

{
  const d = decideSupervisorAction(plan, { mode: 'autopilot' });
  assert.equal(d.ruleId, 'mode.autopilot_review_plan');
  assert.equal(d.action.type, 'answer', 'Autopilot routes a submitted plan through its review brain');
  assert.equal(d.allowedSend, true);
  assert.equal(d.triggeringSignal.type, 'plan_submitted');
}
{
  const d = decideSupervisorAction({
    ...plan,
    session: { ...plan.session, category: '', stage: 'planning', question: '', summary: 'still forming the plan' },
  }, { mode: 'autopilot' });
  assert.equal(d.ruleId, 'stage.stand_down');
  assert.equal(d.action.type, 'wait', 'Autopilot does not interrupt a plan that is still being formed');
}
{
  const d = decideSupervisorAction(plan, { mode: 'copilot' });
  assert.equal(d.ruleId, 'mode.copilot_review_plan');
  assert.equal(d.action.type, 'answer', 'Co-pilot routes the submitted plan through review instead of forwarding it raw');
  assert.equal(d.action.target, 'operator');
  assert.equal(d.allowedSend, false, 'Co-pilot recommendation does not approve or send the plan to the builder');
}
{
  const d = decideSupervisorAction({ ...plan, stance: 'hold' }, { mode: 'autopilot' });
  assert.equal(d.ruleId, 'operator.hold', 'explicit hold outranks Autopilot');
}
{
  const waiting = {
    ...plan,
    session: { ...plan.session, category: '', stage: 'executing', question: '', summary: 'idle between steps' },
  };
  assert.equal(decideSupervisorAction(waiting, { mode: 'autopilot' }).ruleId, 'stance.autopilot_advance',
    'Supervisor mode alone owns continuing in-scope work');
}

assert.match(AUTOPILOT_PLAN_ADDENDUM, /review it against the mission/i);
assert.match(AUTOPILOT_PLAN_ADDENDUM, /Never rubber-stamp/i);
assert.match(AUTOPILOT_RELEASE_ADDENDUM, /Do NOT ask for a per-release approval/i);
assert.match(AUTOPILOT_RELEASE_ADDENDUM, /Do NOT tell the builder to run a direct deploy command/i);
assert.match(COPILOT_RECOVERY_ADDENDUM, /takes no recovery actuator action/i);
assert.match(COPILOT_RECOVERY_ADDENDUM, /inspect reality/i);
assert.match(AUTOPILOT_RECOVERY_ADDENDUM, /owns bounded recovery/i);
assert.match(AUTOPILOT_RECOVERY_ADDENDUM, /stop, kill, hold/i);
assert.match(TIME_CONTINUITY_ADDENDUM, /persisted wall-clock deadline does NOT prove/i);
assert.match(TIME_CONTINUITY_ADDENDUM, /do not retry or fire an action immediately solely because of the clock jump/i);
assert.match(TIME_CONTINUITY_ADDENDUM, /preserving the original attempt budget and duplicate-action protections/i);
assert.match(LEARNING_PROVENANCE_ADDENDUM, /newer authenticated operator requirement outranks/i);
assert.match(LEARNING_PROVENANCE_ADDENDUM, /mark the older rule stale and quarantine\/disable it from reuse/i);
assert.match(LEARNING_PROVENANCE_ADDENDUM, /preserve or repair its provenance\/audit record/i);
assert.match(LEARNING_PROVENANCE_ADDENDUM, /neither mode may turn learned text into new product or release authority/i);
assert.match(SUPERVISOR_COORDINATION_ADDENDUM, /routine supervisory control-plane work/i);
assert.match(SUPERVISOR_COORDINATION_ADDENDUM, /Co-pilot must inspect.*ANSWER with a concrete bounded coordination recommendation/i);
assert.match(SUPERVISOR_COORDINATION_ADDENDUM, /Autopilot must ANSWER.*designated Supervisor-plane actuators/i);
assert.match(SUPERVISOR_COORDINATION_ADDENDUM, /Neither mode may alter another session's product goal/i);
assert.match(RESERVED_APPROVAL_ADDENDUM, /RECENT_OPERATOR_SIGNALS/);

const overloadAsk = {
  question: 'The provider returns 529 overloaded after four parallel sessions began at once. Should every session retry now?',
  terminalTail: 'HTTP 529 overloaded_error. Four supervised sessions share the same provider and started simultaneously.',
};
assert.equal(isNonMutatingSupervisorCoordination({
  ...overloadAsk,
  answer: 'No. Recommend a bounded staggered retry with jitter, reduce concurrency to one session first, and preserve each retry budget.',
}), true, 'bounded coordination of already-supervised sessions is a Co-pilot answer, not a product fork');
for (const [label, sample] of [
  ['retry herd', { ...overloadAsk, answer: 'Every session should retry immediately.' }],
  ['claimed actuation', { ...overloadAsk, answer: 'I already reduced concurrency and restarted the sessions.' }],
  ['reserved action', { ...overloadAsk, answer: 'Stagger the retries, then deploy the successful branch to production.' }],
  ['product mutation', {
    question: 'Four supervised sessions disagree about the product goal. Which scope should replace the current requirement?',
    terminalTail: 'Four supervised sessions are waiting.',
    answer: 'Assign one owner and replace the product scope with option B.',
  }],
  ['unmanaged fleet', {
    question: 'Four sessions in unrelated projects hit overload. Should I coordinate them?',
    answer: 'Use a bounded staggered retry with jitter.',
  }],
]) {
  assert.equal(isNonMutatingSupervisorCoordination(sample), false, `${label} must stay behind the audience gate`);
}

const supervisor = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
const context = readFileSync(new URL('../src/agents/context.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
assert.match(supervisor, /maybeAutoIntegrate\(ctx, cfg/, 'verified completion reaches the integration actuator');
assert.match(supervisor, /cfg\.mode === 'autopilot' \? AUTOPILOT_RECOVERY_ADDENDUM : COPILOT_RECOVERY_ADDENDUM/,
  'the answer brain receives the exact mode-specific recovery authority');
assert.match(supervisor, /sys \+= '\\n\\n' \+ TIME_CONTINUITY_ADDENDUM/,
  'every answer receives the shared clock-discontinuity reliability invariant');
assert.match(supervisor, /sys \+= '\\n\\n' \+ LEARNING_PROVENANCE_ADDENDUM/,
  'every answer preserves current operator authority and learned-rule audit provenance');
assert.match(supervisor, /sys \+= '\\n\\n' \+ SUPERVISOR_COORDINATION_ADDENDUM/,
  'every answer distinguishes Supervisor-plane coordination from cross-session product authority');
assert.match(supervisor, /!copilotSupervisorCoordination/,
  'the Co-pilot audience gate recognizes only bounded non-mutating Supervisor-plane coordination');
assert.match(supervisor, /maybeMonitorIntegration\(ctx, cfg, st\)/, 'Autopilot monitors the durable release after restart');
assert.match(supervisor, /row\.stage === 'GREEN'/, 'only GREEN produces released success');
assert.match(supervisor, /row\.stage === 'HELD'/, 'ambiguous release state remains operator-held');
assert.match(context, /requireCap\('integrate'\)/, 'integration actuator is capability-gated');
assert.match(context, /requestSessionIntegration\(session_id, \{ expectedCandidateSha: expected \}\)/,
  'context uses the shared request path pinned to the verifier-observed commit');
assert.match(panel, /d\.mode === 'autopilot' \? \['integrate'\] : \[\]/, 'only Autopilot mode grants the integration actuator');

function releaseCtx({
  sid = 's_release_' + Math.random().toString(16).slice(2),
  initial = {},
  ready = { ok: true },
  request = null,
  integration = null,
  integrateCap = true,
} = {}) {
  let state = { ...initial };
  const notes = [];
  const events = [];
  let requests = 0;
  const expectedShas = [];
  const ctx = {
    sessionId: sid,
    session: () => ({ id: sid, title: 'Autopilot release' }),
    getState: () => ({ ...state }),
    setState: (patch) => { state = { ...state, ...patch }; return { ...state }; },
    hasCap: (cap) => cap === 'integrate' && integrateCap,
    integrationReadiness: () => ready,
    requestIntegration: async (expectedCandidateSha) => {
      requests++;
      expectedShas.push(expectedCandidateSha);
      return request || {
        ok: true,
        duplicate: false,
        candidateSha: 'candidate1234567890',
        integration: { id: 'int_queued', stage: 'QUEUED', candidate_sha: 'candidate1234567890' },
      };
    },
    integrationStatus: () => integration,
    notifyOperator: (title, body) => notes.push({ title, body }),
    emit: (type, payload) => events.push({ type, payload }),
  };
  return { ctx, notes, events, requests: () => requests, expectedShas };
}

{
  const x = releaseCtx();
  const result = await __lab.maybeAutoIntegrate(x.ctx, { mode: 'copilot' }, { workFp: 'work-a' });
  assert.equal(result.active, false, 'Co-pilot cannot enter the release pipeline');
  assert.equal(x.requests(), 0);
}
{
  const x = releaseCtx({ ready: { ok: false, code: 'autopublish_off', error: 'off' } });
  const result = await __lab.maybeAutoIntegrate(x.ctx, { mode: 'autopilot' }, {
    workFp: 'work-a',
    verifiedCandidateSha: 'candidate1234567890',
  });
  assert.equal(result.active, false, 'Autopilot without standing deployment delegation finishes locally');
  assert.equal(x.requests(), 0);
}
{
  const x = releaseCtx();
  const result = await __lab.maybeAutoIntegrate(x.ctx, { mode: 'autopilot' }, {
    workFp: 'work-a',
    verifiedCandidateSha: 'candidate1234567890',
  });
  assert.equal(result.queued, true);
  assert.equal(x.requests(), 1, 'verified Autopilot candidate enters the one prescribed request seam');
  assert.deepEqual(x.expectedShas, ['candidate1234567890'], 'the request is pinned to the commit the verifier saw');
  assert.equal(x.ctx.getState().integrationId, 'int_queued');
  assert.equal(x.ctx.getState().integrationRequestedWorkFp, 'work-a');
}
{
  const x = releaseCtx({
    initial: { verifiedWorkFp: 'work-dirty', verifiedGateKey: 'gate', verifiedAt: 123 },
    request: { ok: false, code: 'dirty_worktree', error: 'candidate is dirty' },
  });
  const result = await __lab.maybeAutoIntegrate(x.ctx, { mode: 'autopilot' }, {
    workFp: 'work-dirty',
    verifiedCandidateSha: 'candidate1234567890',
  });
  assert.equal(result.queued, false);
  assert.equal(x.ctx.getState().verifiedWorkFp, null, 'a changed/unfrozen candidate loses verification');
  assert.equal(x.ctx.getState().releaseFailure.code, 'dirty_worktree');
}
{
  const row = { id: 'int_green', stage: 'GREEN', candidate_sha: 'green1234567890' };
  const x = releaseCtx({ initial: { integrationId: row.id, integrationStage: 'VERIFYING' }, integration: row });
  assert.equal(await __lab.maybeMonitorIntegration(x.ctx, { mode: 'autopilot' }, x.ctx.getState()), true);
  assert.equal(x.ctx.getState().integrationId, null);
  assert.equal(x.ctx.getState().releaseFinalizedId, row.id);
  assert.equal(x.events.at(-1)?.payload?.verdict, 'released', 'only GREEN emits released');
}
{
  const row = { id: 'int_held', stage: 'HELD', failure_code: 'served_identity_ambiguous' };
  const x = releaseCtx({ initial: { integrationId: row.id, integrationStage: 'VERIFYING' }, integration: row });
  await __lab.maybeMonitorIntegration(x.ctx, { mode: 'autopilot' }, x.ctx.getState());
  await __lab.maybeMonitorIntegration(x.ctx, { mode: 'autopilot' }, x.ctx.getState());
  assert.equal(x.notes.length, 1, 'an ambiguous publication notifies once and remains held');
  assert.equal(x.ctx.getState().integrationId, row.id);
}
{
  const row = { id: 'int_rejected', stage: 'REJECTED', failure_code: 'tests_failed', failure_detail: 'suite red' };
  const x = releaseCtx({
    initial: { integrationId: row.id, integrationStage: 'VERIFYING', verifiedWorkFp: 'old', verifiedGateKey: 'gate', verifiedAt: 123 },
    integration: row,
  });
  assert.equal(await __lab.maybeMonitorIntegration(x.ctx, { mode: 'autopilot' }, x.ctx.getState()), false);
  assert.equal(x.ctx.getState().verifiedWorkFp, null, 'a rejected candidate returns to correction');
  assert.equal(x.ctx.getState().releaseFailure.code, 'tests_failed');
}
{
  const heads = ['evidence-sha', 'changed-sha'];
  let state = {};
  const ctx = {
    sessionId: 's_verify_race',
    session: () => ({ id: 's_verify_race', tool: 'claude', status: 'waiting', autonomy: 'full', title: 'Release race' }),
    project: () => null,
    getState: () => ({ ...state }),
    setState: (patch) => { state = { ...state, ...patch }; return { ...state }; },
    getConfig: () => ({}),
    setConfig: () => {},
    getEvidence: async () => ({
      images: [],
      terminal_tail: 'Implemented and tested the parser fix.\n> ',
      recent_messages: [{ dir: 'out', text: 'Parser fix complete; tests pass.' }],
      git: { status: '', stat: '', diff: '', committed_stat: ' src/parser.js | 12 +-', committed_diff: '+fixed', commits_since_baseline: 'abc123 fix parser' },
    }),
    runProbes: async () => [],
    gitHead: async () => heads.shift() || 'changed-sha',
    visionRoute: () => false,
    callModel: async (_messages, opts = {}) => ({
      content: JSON.stringify({
        verdict: 'complete',
        score: 100,
        assessment: 'The parser fix and tests satisfy the task.',
        unmet: [],
        goal_conflict: false,
        unverifiable: 'none',
        message_to_agent: '',
      }),
      model: opts.model,
      route: { model: opts.model },
      canSee: false,
    }),
    hasCap: () => true,
    notifyOperator: () => {},
    emit: () => {},
    log: () => {},
  };
  const result = await __lab.runVerify(ctx, {
    model: 'gpt-5.6-sol',
    fallback_models: ['gpt-5.6-sol'],
    mode: 'autopilot',
    decision_memory: false,
    doc: '# Task\n\n## Goal\nFix the parser.\n\n## Acceptance criteria\n- [ ] Parser fix is implemented and tested.\n',
  }, 'manual', 'work-race');
  assert.equal(result.parsed.verdict, 'needs_attention', 'a commit change during review invalidates COMPLETE');
  assert.equal(result.verifiedGitSha, null);
  assert.match(result.parsed.assessment, /HEAD changed during verification/i);
}

console.log('supervisor_autonomy_contract.test ok');
