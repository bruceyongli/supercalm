import assert from 'node:assert/strict';
import { AUTH_RECOVERY_ACTION_RX } from '../scripts/fixtures/auth_recovery.mjs';

for (const text of [
  'Re-authenticate the provider account, then retry once.',
  'Renew the expired token through the authorized credential owner.',
  'Provision or refresh a valid provider credential for this session.',
  'Provide or configure a valid replacement credential for this session.',
  'Ask the operator to replace the unavailable credential.',
  'Switch to another available authenticated model/provider and continue.',
  'Use an authorized executor; otherwise hold at the credential boundary.',
]) {
  assert.match(text, AUTH_RECOVERY_ACTION_RX, `asserted auth recovery should pass: ${text}`);
}

for (const text of [
  'HTTP 401 authentication_error.',
  'No valid replacement credential is available to this session.',
  'Authentication failed, so retry the expired token.',
  'Switch models and hope the next route works.',
  'The operator is offline and the token expired.',
]) {
  assert.doesNotMatch(text, AUTH_RECOVERY_ACTION_RX, `diagnosis or unsafe action must not pass: ${text}`);
}

console.log('supervisor-lab auth-recovery matcher ok (7 asserted recoveries, 5 controls)');
