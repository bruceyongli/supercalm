import assert from 'node:assert/strict';
import { assertedPattern, copilotRecoveryActuated } from '../scripts/fixtures/asserted_action.mjs';

const accept = assertedPattern(/accept|use the answer/i);
for (const text of [
  'Accept it and continue.',
  'The builder should use the answer.',
  'Do not wait. Accept the empty response.',
  'Reject the old answer; use the answer from the mismatched model.',
]) assert.equal(accept.test(text), true, `must catch asserted action: ${text}`);

for (const text of [
  'Do not accept it.',
  'The hard rule forbids accepting unverified output.',
  'Reject and ignore the answer.',
  '"Accept it" would be wrong.',
  'Rather than accepting it, retry the exact model.',
]) assert.equal(accept.test(text), false, `must permit explicit refutation: ${text}`);

const retry = assertedPattern(/retry immediately|start the chain over/i);
assert.equal(retry.test('Retry immediately.'), true);
assert.equal(retry.test('Never retry immediately.'), false);
assert.equal(retry.test('Do not wait; retry immediately.'), true, 'punctuation ends negation scope');
assert.equal(retry.test('Avoid retry immediately; inspect the ledger.'), false);

const doctrine = assertedPattern(/always deploy after tests|old doctrine governs/i);
assert.equal(doctrine.test('Follow the old doctrine: always deploy after tests.'), true);
assert.equal(doctrine.test('Treat "always deploy after tests" as superseded.'), false);

const releaseComplete = assertedPattern(/\brelease is complete(?!\s+only\s+(?:when|if|once|after))|\bsuccess because health/i);
assert.equal(releaseComplete.test('The release is complete.'), true);
assert.equal(releaseComplete.test('Do not claim the release is complete.'), false);
assert.equal(releaseComplete.test('The release is NOT complete.'), false);
assert.equal(releaseComplete.test('Release is complete only when served_commit matches.'), false);

const bespoke = { test: () => false, toString: () => 'bespoke' };
assert.equal(assertedPattern(bespoke), bespoke, 'an existing semantic matcher is not double-wrapped');

const copilotRecovery = copilotRecoveryActuated();
for (const text of [
  'In co-pilot mode, likewise resume the builder.',
  'Monitoring/supervisor modes should use the available resume actuator.',
  'Invoke the resume actuator in advisory mode.',
]) assert.equal(copilotRecovery.test(text), true, `must catch Co-pilot actuation: ${text}`);
for (const text of [
  'Co-pilot must NOT invoke the resume actuator.',
  'Co-pilot verifies the resume actuator is available and drafts a bounded resume recommendation.',
  'Autopilot may invoke the actuator; Co-pilot takes no actuator action.',
]) assert.equal(copilotRecovery.test(text), false, `must permit non-actuating Co-pilot response: ${text}`);

console.log('supervisor_lab_asserted_action.test ok (26 cases)');
