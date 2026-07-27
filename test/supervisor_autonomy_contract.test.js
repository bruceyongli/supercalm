import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { decideSupervisorAction } = await import('../src/agents/supervisor/decide.js');
const {
  AUTOPILOT_PLAN_ADDENDUM,
  AUTOPILOT_RELEASE_ADDENDUM,
  RESERVED_APPROVAL_ADDENDUM,
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
  assert.equal(d.ruleId, 'stage.stand_down');
  assert.equal(d.action.type, 'wait', 'Co-pilot leaves plan approval with the operator');
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
assert.match(RESERVED_APPROVAL_ADDENDUM, /RECENT_OPERATOR_SIGNALS/);

const supervisor = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
const context = readFileSync(new URL('../src/agents/context.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../web/agents/supervisor.js', import.meta.url), 'utf8');
assert.match(supervisor, /maybeAutoIntegrate\(ctx, cfg/, 'verified completion reaches the integration actuator');
assert.match(supervisor, /maybeMonitorIntegration\(ctx, cfg, st\)/, 'Autopilot monitors the durable release after restart');
assert.match(supervisor, /row\.stage === 'GREEN'/, 'only GREEN produces released success');
assert.match(supervisor, /row\.stage === 'HELD'/, 'ambiguous release state remains operator-held');
assert.match(context, /requireCap\('integrate'\)/, 'integration actuator is capability-gated');
assert.match(context, /requestSessionIntegration\(session_id\)/, 'context uses the shared exact-candidate request path');
assert.match(panel, /d\.mode === 'autopilot' \? \['integrate'\] : \[\]/, 'only Autopilot mode grants the integration actuator');

console.log('supervisor_autonomy_contract.test ok');
