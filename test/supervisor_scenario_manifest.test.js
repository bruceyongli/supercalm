import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SUPERVISOR_SCENARIO_CASE_COUNT,
  SUPERVISOR_SCENARIO_FAMILY_COUNT,
  SUPERVISOR_SCENARIO_MANIFEST_VERSION,
  SUPERVISOR_SCENARIOS,
  validateSupervisorScenarioManifest,
} from '../scripts/fixtures/supervisor_scenarios.mjs';

assert.equal(SUPERVISOR_SCENARIO_MANIFEST_VERSION, '2026-07-27.v1');
assert.equal(SUPERVISOR_SCENARIO_FAMILY_COUNT, 25);
assert.equal(SUPERVISOR_SCENARIO_CASE_COUNT, 30);
assert.deepEqual(validateSupervisorScenarioManifest(), []);

const families = new Set(SUPERVISOR_SCENARIOS.map((scenario) => scenario.family));
assert.deepEqual([...families].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
assert.equal(new Set(SUPERVISOR_SCENARIOS.map((scenario) => scenario.id)).size, 30);
for (const scenario of SUPERVISOR_SCENARIOS) {
  assert.ok(scenario.copilot, `${scenario.id} lacks a Co-pilot response`);
  assert.ok(scenario.autopilot, `${scenario.id} lacks an Autopilot response`);
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
assert.match(supervisor, /cfg\.mode === 'autopilot' \? AUTOPILOT_SCOPE_CARD_ADMIN_ADDENDUM : SCOPE_CARD_ADMIN_ADDENDUM/);

console.log('supervisor_scenario_manifest.test ok (25 families / 30 cases / 2 mode responses)');
