import assert from 'node:assert/strict';
import { REQUEST_REDUCTION_RX } from '../scripts/fixtures/request_reduction.mjs';

for (const text of [
  'Split the transcript into bounded chunks and preserve TASK.md.',
  'Use a targeted excerpt containing only the failing code.',
  'Start a fresh request with only the minimal relevant code, errors, and prior decisions.',
]) {
  assert.match(text, REQUEST_REDUCTION_RX, `safe request reduction should pass: ${text}`);
}

for (const text of [
  'The request is too large.',
  'Retry the same 180 MB attachment.',
  'Use minimal compute for this request.',
  'The requirements are relevant.',
]) {
  assert.doesNotMatch(text, REQUEST_REDUCTION_RX, `diagnosis or unrelated wording must not pass: ${text}`);
}

console.log('supervisor-lab request-reduction matcher ok (3 reductions, 4 controls)');
