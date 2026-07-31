import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asksForSessionOverview, isNeedsYouSession, isStaleSessionTitleEcho, latestReliableReport, originalRequestFrom } from '../src/voice_attention.js';

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

const oldTitle = 'UI improvements. The session list is refreshing and reordering too fast, and the status indicator keeps flashing.';
const rolling = [
  { id: 1, direction: 'in', source: 'task', text: oldTitle },
  { id: 2, direction: 'out', source: 'detect', text: 'The original flashing issue was fixed.' },
  { id: 3, direction: 'in', source: 'text', text: 'Add Call and Walkie-talkie choices for Voice updates.' },
  { id: 4, direction: 'out', source: 'detect', text: oldTitle.slice(0, 78) },
  { id: 5, direction: 'in', source: 'text', text: 'This later question belongs to the next episode.' },
];
assert.equal(originalRequestFrom(rolling, oldTitle, { reportId: 4 }),
  'Add Call and Walkie-talkie choices for Voice updates.',
  'a long session uses the request immediately preceding this attention report, not its first prompt or a later turn');
assert.equal(isStaleSessionTitleEcho(oldTitle.slice(0, 78), oldTitle), true);
assert.match(latestReliableReport(rolling.slice(0, 4), {
  title: oldTitle,
  summary: oldTitle.slice(0, 78),
  question: oldTitle.slice(0, 78),
}), /repeated the older session title/i, 'a detector title echo is disclosed, never narrated as a new outcome');
const sessionsSource = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
assert.doesNotMatch(sessionsSource, /question \|\| s\.summary \|\| s\.title/,
  'an uncaptured later completion never unconditionally reopens Needs You with the session\'s ancient first request');
assert.match(sessionsSource, /freshAttention && !getLatestAttentionReport\(s\.id\) \? s\.title : ''/,
  'the useful title fallback is limited to a session\'s first attention episode');

assert.equal(asksForSessionOverview('What is the status of each session?'), true);
assert.equal(asksForSessionOverview("Is there a new session that isn't working?"), true);
assert.equal(asksForSessionOverview('Tell me more about this update.'), false,
  'ordinary follow-up questions must not inject or narrate unrelated session status');

console.log('voice_attention.test ok');
