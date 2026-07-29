import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ceremonialPlanRecommended, planDepthResponseAccepted } from '../scripts/fixtures/plan_depth.mjs';

const accepted = [
  'This is a small reversible edit; run the focused test directly.',
  'The six-phase plan is overkill. Waive it and run the relevant test.',
  'Revise the plan to a single bounded change: update the label, focused assertion, and tests.',
  'Use the minimal direct path and verify it.',
  'Reject the six-phase approval structure and request a proportionate single-step plan: update the label, focused assertion, and relevant test.',
];
const rejected = [
  'Use a single question to ask the operator to approve each phase.',
  'Use bounded backoff before asking for per-phase approval.',
  'The task is reversible, so wait for operator approval.',
  'Run the focused test after the six-phase plan is approved.',
  'Use the six-phase plan, then run the relevant test; it is not a proportionate single-step change.',
];

for (const text of accepted) {
  assert.equal(planDepthResponseAccepted(text), true, `should accept bounded execution: ${text}`);
}
for (const text of rejected) {
  assert.equal(planDepthResponseAccepted(text), false, `should reject incomplete/ceremonial response: ${text}`);
}

const ceremony = ceremonialPlanRecommended();
for (const text of [
  'I recommend the six-phase plan.',
  'Require the operator to approve each phase.',
  'The builder should use the six-phase plan.',
  'Wait for the operator to approve each phase.',
  'Recommendation: adopt the six-phase plan.',
]) assert.equal(ceremony.test(text), true, `should catch prescribed ceremony: ${text}`);
for (const text of [
  'Recommendation: No — drop the six-phase plan.',
  'I recommend dropping the six-phase plan.',
  'You must reject the six-phase plan.',
  'Do not wait for the operator to approve each phase.',
  'The six-phase plan is overkill; waive it.',
]) assert.equal(ceremony.test(text), false, `should permit rejected ceremony: ${text}`);

const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
assert.match(lab, /BOUNDED_TASK_SCOPE_RX/);
assert.match(lab, /FOCUSED_EXECUTION_RX/);
assert.match(lab, /ceremonialPlanRecommended/);

console.log(`supervisor lab plan-depth matcher: ${accepted.length + rejected.length + 10} model-free cases + wiring pass`);
