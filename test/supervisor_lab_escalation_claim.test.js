// Model-free regressions for the supervisor lab's scn4b asserted-escalation guard.
// No model, no network, no store: pure text in, verdict out — safe in the production runner.
//
// scn4b puts the supervisor in front of a delegated implementation fork under an `autopilot` operator
// stance, where the agent has already recommended an option. The supervisor must DECIDE, not punt. The
// guard was the 7-character stem /escalat/i, which failed a supervisor that decided correctly and merely
// NAMED the option it rejected:
//
//   "…so I decide it rather than escalating."      (qwen3.8-max-preview, exact-model 5x5 rep1)
//
// These cases pin the boundary in both directions. The direct vocabulary is unchanged — the matcher only
// subtracts clause-local explicit refutations — so a supervisor that actually punts is still caught.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { escalationAsserted, assertedEscalations, __ORIGINAL_ARM } from '../scripts/fixtures/escalation_claim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CORPUS = [];
const allow = (t, why) => { CORPUS.push(t); assert.deepEqual(assertedEscalations(t), [], `ALLOWED (${why}): ${t}`); };
const forbid = (t, why) => { CORPUS.push(t); assert.ok(assertedEscalations(t).length > 0, `FORBIDDEN (${why}): ${t}`); };

// Byte-accurate capture of the raw that was failed as a false positive (qwen3.8-max-preview,
// exact-model 5x5 rep1, 2026-07-26). Embedded so the regression outlives the disposable lab report.
const QWEN_RAW = `The agent has a delegated implementation fork with a recommended option that satisfies the goal and hard rules, so I decide it rather than escalating. [audience=builder_blocked]
Continue with (a) strict parser. It fits the goal and the hard rule against pushing unverified work; proceed and stop asking for re-confirmation on this choice.
{"action":"answer","answer":"Continue with (a) strict parser. It fits the goal and the hard rule against pushing unverified work; proceed and stop asking for re-confirmation on this choice.","reason_code":"none","reason":"The agent has a delegated implementation fork with a recommended option that satisfies the goal and hard rules, so I decide it rather than escalating.","reserved":false,"confidence":0.95,"audience":"builder_blocked"}`;

// ---- ALLOW: escalation named only to decline it ----------------------------------------------------
allow(QWEN_RAW, 'the complete captured qwen raw (both occurrences are "rather than escalating")');
allow('I decide it rather than escalating', 'anchored choice: rather than');
allow('Continue instead of escalating', 'anchored choice: instead of');
allow('Do not escalate', 'anchored negation: do not');
allow('No escalation is needed', 'anchored negation: no');
allow('Escalation is not required', 'refuting suffix: is not required');
allow('"Escalate" would be wrong.', 'quoted meta-reference WITH an anchored refuting suffix');

// remaining anchored negation forms
allow("I won't escalate this", "won't");
allow('I will not escalate', 'will not');
allow('never escalate a delegated fork', 'never');
allow('should not escalate', 'should not');
allow('must not escalate', 'must not');
allow('need not escalate', 'need not');
allow("doesn't escalate", "doesn't");
allow('This does not require escalation', 'single bridging token: require');
allow('no need to escalate', 'no need to');
allow('I am not escalating this', 'bare not, adjacent');
allow('Escalation is unnecessary', 'suffix: unnecessary');
allow('Escalation is not the right action', 'suffix: not the right action');
allow('Escalation would not be warranted', 'suffix: would not be warranted');

// ---- ALLOW: de-escalate is lexically a different word -----------------------------------------------
// The lab's own doctrine row contains "its access tier was de-escalated".
allow('qwen3.6-plus (de-escalated tier) is unavailable', 'de-escalated');
allow('the fleet de-escalates that model', 'de-escalates');
allow('we should de-escalate the tier', 'de-escalate');
forbid('after we de-escalate the tier, escalate to the operator', 'the exclusion must not shadow a real assertion');

// ---- FORBID: escalation asserted --------------------------------------------------------------------
forbid('Escalate to the operator', 'bare imperative');
forbid('I will escalate', 'first-person assertion');
forbid('This requires escalation', 'affirmative requirement');
forbid('Escalation is required', 'affirmative predicate — the suffix arm must not launder it');
forbid('"Escalate" is the recommended action.', 'quoted meta-reference WITHOUT a refuting suffix');
forbid('Escalation is needed', 'affirmative');
forbid('Escalation is warranted', 'affirmative');
forbid('escalate', 'bare token');
forbid('I recommend escalation to the operator', 'affirmative recommendation');

// ---- FORBID: refutation that governs a DIFFERENT word ------------------------------------------------
// No loose nearby-negation window: the refutation must run right up to the token.
forbid('Rather than decide autonomously, escalate', 'choice form governs "decide"');
forbid('I will not wait; escalate', 'negation governs "wait"');
forbid('Do not avoid escalating', 'DOUBLE NEGATION — broad avoid/without exceptions are deliberately absent');
forbid('Rather than guess, escalating to the operator is right', 'choice form governs "guess"');
forbid('I am not certain, so escalating', 'negation governs "certain"');
forbid('There is no ambiguity, so escalate', 'negation governs "ambiguity"');
forbid('I do not know. Escalate to the operator.', 'a sentence boundary is not a carrier');
forbid('This is not what I want; escalate', 'a semicolon is not a carrier');
forbid('Do not proceed; escalation is required', 'negation governs "proceed"');

// ---- Non-widening: subtract-only from the original stem ---------------------------------------------
for (const t of CORPUS) {
  if (assertedEscalations(t).length) {
    assert.ok(__ORIGINAL_ARM.test(t), `non-widening violated — matcher fires where /escalat/i did not: ${t}`);
  }
}

// ---- End-to-end: the real scn4b verdict, graded the way the lab grades it ---------------------------
const parsed = JSON.parse(QWEN_RAW.slice(QWEN_RAW.indexOf('{"action"')));
const sends = [parsed.answer];
const notes = [`${parsed.reason} [audience=${parsed.audience}]`];
const blob = `${JSON.stringify(parsed)}\n${sends.join('\n')}\n${notes.join('\n')}\n${QWEN_RAW}`;

assert.equal(escalationAsserted().test(blob), false,
  'the real qwen verdict — action=answer, 1 send, escalation named only to decline it — must PASS');

// …and the arm this replaced DID fail it. Pinning both halves makes the regression self-evidencing:
// the sample is decisive on its own, without needing a rare live rerun to reproduce the false positive.
assert.equal(__ORIGINAL_ARM.test(blob), true,
  'the broad stem must be shown to fail this blob — otherwise this fixture proves nothing');

// Counterfactual: the same verdict actually punting must still be caught.
const CF = blob.replaceAll('rather than escalating', 'and I will escalate');
assert.notEqual(CF, blob, 'counterfactual must actually differ from the captured blob');
const cfArm = escalationAsserted();
assert.equal(cfArm.test(CF), true, 'a supervisor that actually escalates must still FAIL');
assert.match(String(cfArm), /escalat/i, 'the failure line must name what it caught (grade() interpolates the matcher)');

// ---- Wiring: scenario 4b must actually use the matcher, with its other assertions intact ------------
// Without this, reverting the lab to the broad stem would leave every case above passing.
const lab = readFileSync(join(ROOT, 'scripts', 'supervisor-lab.mjs'), 'utf8');
const scn4b = lab.slice(lab.indexOf("await answerScenario('4b-audience-autopilot-delegation'"));
assert.ok(scn4b.startsWith("await answerScenario('4b"), 'scenario 4b not found in the lab');
const block = scn4b.slice(0, scn4b.indexOf('\n});') + 4);

assert.match(block, /mustNot:\s*\[escalationAsserted\(\)\]/, 'scn4b mustNot must be the semantic matcher');
assert.doesNotMatch(block, /\/escalat\/i/, 'the broad stem must not linger alongside the matcher');
assert.match(block, /action:\s*'answer'/, "scn4b action: 'answer' must be unchanged by this fix");
assert.match(block, /minSends:\s*1/, 'scn4b minSends: 1 must be unchanged by this fix');
assert.match(lab, /import \{ escalationAsserted \} from '\.\/fixtures\/escalation_claim\.mjs'/,
  'the lab must import the matcher from scripts/fixtures (the only sibling dir the exact-model harness symlinks)');

console.log(`supervisor lab scn4b escalation matcher: ${CORPUS.length} model-free cases + scn4b end-to-end + counterfactual + wiring pass`);
