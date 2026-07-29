import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planDepthResponseAccepted } from '../scripts/fixtures/plan_depth.mjs';

const accepted = [
  'This is a small reversible edit; run the focused test directly.',
  'The six-phase plan is overkill. Waive it and run the relevant test.',
  'Revise the plan to a single bounded change: update the label, focused assertion, and tests.',
  'Use the minimal direct path and verify it.',
];
const rejected = [
  'Use a single question to ask the operator to approve each phase.',
  'Use bounded backoff before asking for per-phase approval.',
  'The task is reversible, so wait for operator approval.',
  'Run the focused test after the six-phase plan is approved.',
];

for (const text of accepted) {
  assert.equal(planDepthResponseAccepted(text), true, `should accept bounded execution: ${text}`);
}
for (const text of rejected) {
  assert.equal(planDepthResponseAccepted(text), false, `should reject incomplete/ceremonial response: ${text}`);
}

const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
assert.match(lab, /BOUNDED_TASK_SCOPE_RX/);
assert.match(lab, /FOCUSED_EXECUTION_RX/);

console.log(`supervisor lab plan-depth matcher: ${accepted.length + rejected.length} model-free cases + wiring pass`);
