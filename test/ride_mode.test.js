import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextRideAttention, rideAttentionKey } from '../web/ride-state.js';

const report = (id, reportId, activity = reportId) => ({
  id,
  status: 'waiting',
  unread: 1,
  category: 'decision',
  last_activity: activity,
  last_key: { id: reportId },
});

const first = report('s_one', 11);
const second = report('s_two', 21);
assert.equal(rideAttentionKey(first), 's_one:11', 'the durable report id identifies one attention episode');
assert.equal(nextRideAttention([first, second], new Set())?.id, 's_one', 'the first unseen report is announced');
assert.equal(nextRideAttention([first, second], new Set(['s_one:11']))?.id, 's_two', 'an announced report is skipped');
assert.equal(nextRideAttention([first], new Set(['s_one:11'])), null, 'an unchanged report never speaks twice');
assert.equal(nextRideAttention([{ ...first, last_key: { id: 12 } }], new Set(['s_one:11']))?.id, 's_one',
  'a genuinely new work-status report for the same session speaks again');
assert.equal(
  rideAttentionKey({ ...first, last_key: null, summary: 'Still waiting for the same choice', last_activity: 99 }),
  rideAttentionKey({ ...first, last_key: null, summary: 'Still waiting for the same choice', last_activity: 999 }),
  'heartbeat activity cannot turn one report into repeated Ride interruptions',
);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ride = read('web/ride-mode.js');
const voice = read('web/voicemode.js');
const voiceServer = read('src/voice.js');
const push = read('src/push.js');
const sw = read('web/sw.js');
const dashboard = read('web/views/dashboard.js');
const phone = read('web/phone.js');

assert.match(ride, /enablePush\(\{ ride: true \}\)/, 'Ride mode enables its device push preference');
assert.match(ride, /markAnnounced\(currentNeeds\)/, 'one spoken queue pass deduplicates its complete snapshot');
assert.match(ride, /if \(!enabled && !pendingFocus\) markAnnounced\(currentNeeds\)/,
  'a normal launch baselines old work, while an enabled Ride device can discover an unseen report after reload');
assert.match(ride, /document\.hidden/, 'foreground speech never pretends to run from a suspended page');
assert.match(voice, /prepareVoiceMode[\s\S]*getUserMedia/, 'the enable tap primes microphone permission');
assert.match(voice, /focusSessionId, source/, 'the focused Ride report reaches the voice start API');
assert.match(voiceServer, /a\.id === focusSessionId/, 'the newly announced project is presented before the older queue');
assert.match(push, /sub\.aios\?\.ride/, 'push delivery honors each device Ride preference');
assert.match(push, /rideUrl: `\.\/\?ride=1&focus=/, 'background notifications deep-link back to focused voice');
assert.match(sw, /action: 'talk'/, 'supporting browsers expose a Talk now notification action');
assert.match(sw, /silent: false/, 'the background notification asks the OS to use an audible alert');
assert.match(dashboard, /id="dk-ride"/, 'the canonical Needs You dashboard exposes the Ride switch');
assert.match(phone, /id="ride-mode"/, 'the phone companion exposes the same Ride switch');
assert.match(phone, /observeRideNeeds\(phoneNeeds\(\)\)/, 'phone SSE/home updates feed the Ride coordinator');

console.log('ride_mode.test ok');
