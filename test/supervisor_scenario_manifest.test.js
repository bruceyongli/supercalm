import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SUPERVISOR_SCENARIO_CASE_COUNT,
  SUPERVISOR_SCENARIO_FAMILY_COUNT,
  SUPERVISOR_SCENARIO_MANIFEST_VERSION,
  SUPERVISOR_RESPONSE_PROTOCOL,
  SUPERVISOR_SCENARIOS,
  validateSupervisorScenarioManifest,
} from '../scripts/fixtures/supervisor_scenarios.mjs';

assert.equal(SUPERVISOR_SCENARIO_MANIFEST_VERSION, 'SGR-2026-07-28.1');
assert.equal(SUPERVISOR_SCENARIO_FAMILY_COUNT, 72);
assert.equal(SUPERVISOR_SCENARIO_CASE_COUNT, 77);
assert.deepEqual(validateSupervisorScenarioManifest(), []);
assert.match(SUPERVISOR_RESPONSE_PROTOCOL.shared, /OBSERVE reality.*VERIFY.*diagnosis/);
assert.match(SUPERVISOR_RESPONSE_PROTOCOL.copilot, /ANSWER safe facts.*RECOMMEND.*smallest true authority boundary/);
assert.match(SUPERVISOR_RESPONSE_PROTOCOL.autopilot, /DECIDE and ACT.*outside-authority.*unsafe.*ambiguous/);

const families = new Set(SUPERVISOR_SCENARIOS.map((scenario) => scenario.family));
assert.deepEqual([...families].sort((a, b) => a - b), Array.from({ length: 72 }, (_, i) => i + 1));
assert.equal(new Set(SUPERVISOR_SCENARIOS.map((scenario) => scenario.id)).size, 77);
for (const scenario of SUPERVISOR_SCENARIOS) {
  assert.ok(scenario.copilot, `${scenario.id} lacks a Co-pilot response`);
  assert.ok(scenario.autopilot, `${scenario.id} lacks an Autopilot response`);
  assert.doesNotMatch(scenario.copilot, /^(?:ESCALATE|HOLD\+ESCALATE)\b/, `${scenario.id} lets Co-pilot use escalation as the whole response`);
  assert.doesNotMatch(scenario.autopilot, /^(?:ESCALATE|HOLD\+ESCALATE)\b/, `${scenario.id} lets Autopilot use escalation as the whole response`);
}

const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
for (const scenario of SUPERVISOR_SCENARIOS) {
  assert.ok(lab.includes(`'${scenario.id}'`), `${scenario.id} is not wired into the executable lab`);
}
assert.match(lab, /--mode must be copilot or autopilot/);
assert.match(lab, /executed \$\{actualIds\.length\} cases; manifest requires/);
assert.match(lab, /configured=requested=routed=returned=/);

const prompt = readFileSync(new URL('../src/agents/answer_prompt.js', import.meta.url), 'utf8');
const supervisor = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
assert.match(prompt, /AUTOPILOT_SCOPE_CARD_ADMIN_ADDENDUM/);
assert.match(prompt, /The deterministic Supervisor gate performs the actual internal transition/);
assert.match(prompt, /CO-PILOT REVIEWS BEFORE ASKING/);
assert.match(prompt, /escalation is the LAST step after checking available reality/);
assert.match(supervisor, /cfg\.mode === 'autopilot' \? AUTOPILOT_SCOPE_CARD_ADMIN_ADDENDUM : SCOPE_CARD_ADMIN_ADDENDUM/);
assert.match(supervisor, /const autoManageCards = ON_MSG_CARDS && cfg\.mode === 'autopilot'/);

console.log('supervisor_scenario_manifest.test ok (72 families / 77 cases / 2 mode responses)');
