import assert from 'node:assert/strict';
import { SESSION_RECENCY_WINDOW_MS as DAY, sessionRecencyTimestamp, splitSessionRecency } from '../web/session-recency.js';

const now = 1_790_000_000_000;
const sessions = [
  { id: 'recent', started_at: now - 90 * DAY, last_activity: now - 60_000 },
  { id: 'older', last_activity: now - DAY - 1 },
  { id: 'boundary', last_activity: now - DAY },
  { id: 'new-report', last_activity: now - 2 * DAY, last_key: { ts: now - 5000 } },
  { id: 'unknown', last_activity: null },
  { id: 'started', started_at: now - 3 * DAY },
  { id: 'invalid', last_activity: 'not a timestamp', last_key: { ts: -1 } },
];
const before = structuredClone(sessions);
const { recent, older } = splitSessionRecency(sessions, now);
assert.deepEqual(recent.map(s => s.id), ['recent', 'boundary', 'new-report', 'unknown', 'invalid']);
assert.deepEqual(older.map(s => s.id), ['older', 'started']);
assert.deepEqual(sessions, before, 'grouping is presentation-only and never mutates read, dismissal or lifecycle state');
assert.equal(sessionRecencyTimestamp(sessions[3]), now - 5000);
assert.equal(splitSessionRecency([{ ...sessions[1], last_activity: now }], now).older.length, 0, 'fresh activity promotes a previously deferred session');
assert.equal(splitSessionRecency([{ ...sessions[1], last_key: { ts: now } }], now).older.length, 0, 'a fresh report also promotes it');
assert.deepEqual(splitSessionRecency([], now), { recent: [], older: [] });
console.log('session_recency: 24-hour boundary, fresh reports, unknown age, stable order and no mutations passed');
