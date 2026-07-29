import assert from 'node:assert/strict';
import { asksForSessionOverview, isNeedsYouSession, originalRequestFrom } from '../src/voice_attention.js';

const waiting = { id: 's_need', status: 'waiting', category: 'review' };
assert.equal(isNeedsYouSession(waiting, { unread: 1 }), true, 'an unread undismissed report needs the operator');
assert.equal(isNeedsYouSession(waiting, { unread: 0 }), false, 'a read waiting session is not in Needs You');
assert.equal(isNeedsYouSession(waiting, { unread: 1, dismissed: true }), false, 'a dismissed report is not in Needs You');
assert.equal(isNeedsYouSession({ ...waiting, status: 'exited' }, { unread: 1 }), false, 'a stopped session is not in Needs You');
assert.equal(isNeedsYouSession({ ...waiting, category: 'working' }, { unread: 1 }), false, 'a false-positive working report is not in Needs You');

assert.equal(originalRequestFrom([
  { direction: 'out', source: 'detect', text: 'latest agent report' },
  { direction: 'in', source: 'task', text: 'Build the mobile controls and fix the layout.' },
  { direction: 'in', source: 'voice', text: 'Yes, continue.' },
]), 'Build the mobile controls and fix the layout.');

assert.equal(asksForSessionOverview('What is the status of each session?'), true);
assert.equal(asksForSessionOverview("Is there a new session that isn't working?"), true);
assert.equal(asksForSessionOverview('Tell me more about this update.'), false,
  'ordinary follow-up questions must not inject or narrate unrelated session status');

console.log('voice_attention.test ok');
