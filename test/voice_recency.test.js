import assert from 'node:assert/strict';
import { isRecentVoiceSession, voiceActivityTimestamp } from '../web/voice-recency.js';
import { nextOnTheGoAttention } from '../web/on-the-go-state.js';
const now = Date.now(), day = 86400000;
const session = { id: 's_recent', status: 'waiting', last_activity: now, last_key: { id: 1, ts: now - 2 * day } };
assert.equal(isRecentVoiceSession(session, now), false, 'heartbeats cannot revive an old voice report');
assert.equal(isRecentVoiceSession({ ...session, last_key: { ts: now - day } }, now), true, 'the 24-hour boundary is inclusive');
assert.equal(isRecentVoiceSession({ ...session, status: 'exited', last_key: { ts: now } }, now), false);
assert.equal(isRecentVoiceSession({ id: 'unknown' }, now), false, 'unknown activity cannot interrupt the operator');
assert.equal(isRecentVoiceSession({ ...session, last_key: null, started_at: now - 2 * day }, now), false,
  'an old session without an unread message cannot become recent from a heartbeat');
assert.equal(isRecentVoiceSession({ ...session, started_at: now - 2 * day }, now, [{ direction: 'in', source: 'supervisor', ts: now }]), false,
  'machine-only activity cannot fall back to heartbeat recency');
const messages = [{ direction: 'out', ts: now - 2 * day }, { direction: 'in', source: 'supervisor', ts: now }];
assert.equal(voiceActivityTimestamp(session, messages), now - 2 * day, 'machine steering is not operator activity');
messages.push({ direction: 'in', source: 'voice', ts: now - 1000 });
assert.equal(isRecentVoiceSession(session, now, messages), true, 'a genuine new operator request makes the session recent again');
const fresh = { ...session, id: 's_new', last_key: { id: 2, ts: now } };
assert.equal(nextOnTheGoAttention([session, fresh], new Set())?.id, 's_new');
assert.equal(nextOnTheGoAttention([session], new Set()), null);
console.log('voice_recency.test ok');
