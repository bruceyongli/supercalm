import assert from 'node:assert/strict';
import { classifyOperatorText } from '../src/agents/supervisor/interpret.js';

// Incident s_0e9e27b282 (the SECOND time on the same session): the operator wrote
//   "No need to stop, do not ever stop between tasks again. Bad behavior"
// — an unambiguous KEEP-GOING directive — and the supervisor STOOD DOWN, because the bare word
// "stop" matched OPERATOR_WAIT_RX. A negated "stop" (with any words wedged in: "do not EVER stop")
// is the opposite of a hold and must classify as 'continue', never 'wait'. Genuine imperatives with
// no negation ("stop and wait for me") must STILL be 'wait' — the fix must not blunt real holds.

const KEEP_GOING = [
  'No need to stop, do not ever stop between tasks again. Bad behavior',
  'do not ever stop between tasks',
  'never stop between tasks',
  'no need to stop',
  "don't stop between phases",
  'keep going, do not stop',
  'do not stop until all phases are done',
];
for (const t of KEEP_GOING) {
  assert.equal(classifyOperatorText(t).kind, 'continue', `negated-stop must be continue, not wait: ${JSON.stringify(t)}`);
}

// Genuine holds — the "stop" is a real imperative, no negation — must remain 'wait'.
const REAL_WAIT = ['stop and wait for me', 'stand down for now', 'please pause', 'hold on', 'do nothing'];
for (const t of REAL_WAIT) {
  assert.equal(classifyOperatorText(t).kind, 'wait', `genuine hold must stay wait: ${JSON.stringify(t)}`);
}

// The tick-level defense: the stand-down branch defers to the durable stance so a stray regex 'wait'
// can never override an explicit autopilot delegation (belt-and-suspenders with the classifier fix).
import { readFileSync } from 'node:fs';
const supSrc = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
assert.match(
  supSrc,
  /operatorIntent\?\.kind === 'wait' && resolveStance\(st\.operatorStance\) !== 'autopilot'/,
  'the operator-wait stand-down must defer to an autopilot durable stance',
);

console.log('supervisor_operator_intent.test ok');
