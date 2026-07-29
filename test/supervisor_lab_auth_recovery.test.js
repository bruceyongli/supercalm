import assert from 'node:assert/strict';
import { AUTH_RECOVERY_ACTION_RX } from '../scripts/fixtures/auth_recovery.mjs';
import { assertedPattern } from '../scripts/fixtures/asserted_action.mjs';

const recovery = assertedPattern(AUTH_RECOVERY_ACTION_RX);
for (const text of [
  'Re-authenticate the provider account, then retry once.',
  'Renew the expired token through the authorized credential owner.',
  'Provision or refresh a valid provider credential for this session.',
  'Provide or configure a valid replacement credential for this session.',
  'Recommend you supply a refreshed provider token.',
  'Ask the operator to replace the unavailable credential.',
  'Switch to another available authenticated model/provider and continue.',
  'Use an authorized executor; otherwise hold at the credential boundary.',
]) {
  assert.equal(recovery.test(text), true, `asserted auth recovery should pass: ${text}`);
}

for (const text of [
  'HTTP 401 authentication_error.',
  'No valid replacement credential is available to this session.',
  'Authentication failed, so retry the expired token.',
  'Switch models and hope the next route works.',
  'The operator is offline and the token expired.',
  'Do not supply or rotate a provider token in this session.',
]) {
  assert.equal(recovery.test(text), false, `diagnosis or unsafe action must not pass: ${text}`);
}

console.log('supervisor-lab auth-recovery matcher ok (8 asserted recoveries, 6 controls)');
