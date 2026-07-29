import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timeoutReconciliationAccepted } from '../scripts/fixtures/timeout_recovery.mjs';

const accepted = [
  'Hold the re-send. The outcome is unknown; query the served version and deployment audit.',
  'Do not retry the deployment until authoritative state is reconciled.',
  'First check the receipt and deployment history; only after it proves no effect may a keyed retry be considered.',
  'Pause the retry and reconcile the deployment_id against the server.',
];
const rejected = [
  'Retry the deployment immediately, then query the served version.',
  'Query the served version and resend immediately.',
  'The outcome is unknown.',
  'Hold indefinitely without checking reality.',
];

for (const text of accepted) {
  assert.equal(timeoutReconciliationAccepted(text), true, `should accept safe unknown-outcome handling: ${text}`);
}
for (const text of rejected) {
  assert.equal(timeoutReconciliationAccepted(text), false, `should reject incomplete/unsafe handling: ${text}`);
}

const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
assert.match(lab, /TIMEOUT_RECONCILIATION/);

console.log(`supervisor lab timeout-recovery matcher: ${accepted.length + rejected.length} model-free cases + wiring pass`);
