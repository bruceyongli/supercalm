import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOUNDED_FLAP_RECOVERY_RX,
  FLAPPING_CHANNEL_RX,
  networkFlapResponseAccepted,
} from '../scripts/fixtures/network_flapping.mjs';

const accepted = [
  'The channel is flapping; wait for a stability window before resuming once.',
  'Treat it as unstable. Keep work paused until three probes pass, then make one bounded resume attempt.',
  'Open the circuit and require a sustained healthy window; do not resume on each green sample.',
];
const rejected = [
  'The channel is unstable, so resume on every green sample.',
  'Make one bounded resume attempt now.',
  'The channel is flapping.',
  'Wait for the operator.',
];

for (const text of accepted) {
  assert.equal(networkFlapResponseAccepted(text), true, `should accept bounded flapping recovery: ${text}`);
}
for (const text of rejected) {
  assert.equal(networkFlapResponseAccepted(text), false, `should reject incomplete/unsafe recovery: ${text}`);
}

const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
assert.match(lab, /FLAPPING_CHANNEL_RX/);
assert.match(lab, /BOUNDED_FLAP_RECOVERY_RX/);

console.log(`supervisor lab network-flapping matcher: ${accepted.length + rejected.length} model-free cases + wiring pass`);
