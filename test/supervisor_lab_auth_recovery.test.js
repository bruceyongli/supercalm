import assert from 'node:assert/strict';
import { AUTH_RECOVERY_ACTION_RX } from '../scripts/fixtures/auth_recovery.mjs';
import { assertedPattern } from '../scripts/fixtures/asserted_action.mjs';

const recovery = assertedPattern(AUTH_RECOVERY_ACTION_RX);
for (const text of [
  'Re-authenticate the provider account, then retry once.',
  'Restore authentication through the approved credential mechanism.',
  'Renew the expired token through the authorized credential owner.',
  'Provision or refresh a valid provider credential for this session.',
  'Provide or configure a valid replacement credential for this session.',
  'Recommend you supply a refreshed provider token.',
  'The operator supplies a rotated token from the secret store.',
  'Ask the operator to replace the unavailable credential.',
  'Switch to another available authenticated model/provider and continue.',
  'Provide access to another already-authorized provider/model.',
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
  'Do not restore authentication or provide access to another provider.',
]) {
  assert.equal(recovery.test(text), false, `diagnosis or unsafe action must not pass: ${text}`);
}

console.log('supervisor-lab auth-recovery matcher ok (11 asserted recoveries, 7 controls)');
