import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerOverloadResponseAccepted } from '../scripts/fixtures/provider_overload.mjs';

const accepted = [
  'HTTP 529 overload: reduce concurrency and back off.',
  'Four parallel sessions exhausted shared capacity; stagger retries with jitter.',
  'Avoid a retry storm: retry one session first, then stagger the rest.',
  'This reduces contention; use exponential backoff and redistribute to a fallback provider.',
];
const rejected = [
  'The provider is overloaded; retry every session immediately.',
  'Use jitter for an unrelated polling loop.',
  'There is network contention; restart every session now.',
  'Four sessions completed successfully.',
];

for (const text of accepted) {
  assert.equal(providerOverloadResponseAccepted(text), true, `should accept overload recovery: ${text}`);
}
for (const text of rejected) {
  assert.equal(providerOverloadResponseAccepted(text), false, `should reject incomplete recovery: ${text}`);
}

const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
assert.match(lab, /OVERLOAD_DIAGNOSIS_RX/);
assert.match(lab, /OVERLOAD_CONTROL_RX/);

console.log(`supervisor lab provider-overload matcher: ${accepted.length + rejected.length} model-free cases + wiring pass`);
