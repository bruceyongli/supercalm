import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeScenarioResponseAccepted } from '../scripts/fixtures/route_identity.mjs';

const accepted = [
  'HTTP 404 model_not_found. Switch to claude-opus-5.',
  'The configured model ID does not exist. Correct the configuration.',
  'The old route was retired; use the catalog replacement.',
  'Switch the configuration to the exact available model ID claude-opus-5.',
  'The unavailable old-opus-beta ID should be replaced with the catalog-listed ID.',
  'The unavailable model identifier needs an exact replacement from the catalog.',
];
const rejected = [
  'The screenshot is unavailable. Switch to claude-opus-5.',
  'The provider is temporarily unavailable. Switch providers.',
  'The route is available and healthy.',
  'The model ID is healthy.',
  'The route was selected from the catalog and is healthy.',
  'The screenshot is missing.',
  'Switch to the catalog-listed replacement.',
  'The old route was retired.',
];

for (const text of accepted) {
  assert.equal(routeScenarioResponseAccepted(text), true, `should accept route repair: ${text}`);
}
for (const text of rejected) {
  assert.equal(routeScenarioResponseAccepted(text), false, `should reject incomplete/unrelated response: ${text}`);
}

const lab = readFileSync(new URL('../scripts/supervisor-lab.mjs', import.meta.url), 'utf8');
assert.match(lab, /ROUTE_FAILURE_OR_IDENTITY_RX/);
assert.match(lab, /EXACT_ROUTE_REPAIR_RX/);

console.log(`supervisor lab route-identity matcher: ${accepted.length + rejected.length} model-free cases + wiring pass`);
