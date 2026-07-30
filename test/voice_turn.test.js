import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  asksForConfirmation,
  confirmationFrom,
  confirmedPendingReply,
  providerFailureReply,
} from '../src/voice_turn.js';

const pending = 'Fix the report ordering and keep dismissed sessions hidden.';

assert.deepEqual(confirmationFrom('Yes.'), { additional: '' });
assert.deepEqual(confirmationFrom('Okay, go ahead and send it.'), { additional: '' });
assert.deepEqual(
  confirmationFrom('Yes, and also make the controls larger on iPhone.'),
  { additional: 'make the controls larger on iPhone.' },
);
assert.equal(confirmationFrom('No, change the layout first.'), null, 'a correction is not mistaken for confirmation');
assert.equal(confirmationFrom('Okay, but change the layout first.'), null, 'a qualified correction still needs reasoning');

const confirmed = confirmedPendingReply(pending, 'Yes, and also make the controls larger on iPhone.');
assert.equal(confirmed.action, 'send');
assert.match(confirmed.say, /additional request/);
assert.match(confirmed.message, /Fix the report ordering/);
assert.match(confirmed.message, /Additional request from the operator: make the controls larger/);

assert.equal(confirmedPendingReply('', 'Yes'), null, 'a bare yes cannot send without a pending instruction');
assert.equal(asksForConfirmation('I understood the change. Should I send that?'), true);
assert.equal(asksForConfirmation('Here is more detail about the report.'), false);

// Exact outage recovery: the transcript is preserved, then confirmation succeeds locally without
// calling another model and without repeating "I had trouble understanding."
const failed = providerFailureReply('Add the new request to the same session.', 'AIOS');
assert.equal(failed.action, 'await');
assert.equal(failed.message, 'Add the new request to the same session.');
assert.match(failed.say, /response service is temporarily unavailable/);
assert.doesNotMatch(failed.say, /trouble understanding|say that again/i);
const recovered = confirmedPendingReply(failed.message, 'Send it');
assert.equal(recovered.action, 'send');
assert.equal(recovered.message, failed.message);

const voiceSource = readFileSync(new URL('../src/voice.js', import.meta.url), 'utf8');
assert.doesNotMatch(
  voiceSource,
  /\.\.\.vs\.history,\s*\{\s*role:\s*['"]user['"]/,
  'the current transcript is not appended a second time after it was recorded in history',
);

console.log('voice_turn.test ok');
