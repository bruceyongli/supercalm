import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextOnTheGoAttention, onTheGoAttentionKey } from '../web/on-the-go-state.js';

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
assert.equal(onTheGoAttentionKey(first), 's_one:11', 'the durable report id identifies one attention episode');
assert.equal(nextOnTheGoAttention([first, second], new Set())?.id, 's_one', 'the first unseen report is announced');
assert.equal(nextOnTheGoAttention([first, second], new Set(['s_one:11']))?.id, 's_two', 'an announced report is skipped');
assert.equal(nextOnTheGoAttention([first], new Set(['s_one:11'])), null, 'an unchanged report never speaks twice');
assert.equal(nextOnTheGoAttention([{ ...first, last_key: { id: 12 } }], new Set(['s_one:11']))?.id, 's_one',
  'a genuinely new work-status report for the same session speaks again');
assert.equal(
  onTheGoAttentionKey({ ...first, last_key: null, summary: 'Still waiting for the same choice', last_activity: 99 }),
  onTheGoAttentionKey({ ...first, last_key: null, summary: 'Still waiting for the same choice', last_activity: 999 }),
  'heartbeat activity cannot turn one report into repeated interruptions',
);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const onTheGo = read('web/on-the-go.js');
const voice = read('web/voicemode.js');
const voiceServer = read('src/voice.js');
const push = read('src/push.js');
const sw = read('web/sw.js');
const dashboard = read('web/views/dashboard.js');
const phone = read('web/phone.js');
const styles = read('web/styles.css');

assert.match(onTheGo, /enablePush\(\{ onTheGo: true \}\)/, 'on-the-go mode enables its device push preference');
assert.match(onTheGo, /markAnnounced\(currentNeeds\)/, 'one spoken queue pass deduplicates its complete snapshot');
assert.match(onTheGo, /if \(!enabled && !pendingFocus\) markAnnounced\(currentNeeds\)/,
  'a normal launch baselines old work, while an enabled device can discover an unseen report after reload');
assert.match(onTheGo, /document\.hidden/, 'foreground speech never pretends to run from a suspended page');
assert.match(voice, /prepareVoiceMode[\s\S]*getUserMedia/, 'the enable tap primes microphone permission');
assert.match(voice, /focusSessionId, source/, 'the focused on-the-go report reaches the voice start API');
assert.match(voiceServer, /a\.id === focusSessionId/, 'the newly announced project is presented before the older queue');
assert.match(push, /sub\.aios\?\.onTheGo/, 'push delivery honors each device preference');
assert.match(push, /onTheGoUrl: `\.\/\?on-the-go=1&focus=/, 'background notifications deep-link back to focused voice');
assert.match(sw, /action: 'talk'/, 'supporting browsers expose a Talk now notification action');
assert.match(sw, /silent: false/, 'the background notification asks the OS to use an audible alert');
assert.match(dashboard, /id="dk-on-the-go"/, 'the canonical Needs You dashboard exposes the on-the-go switch');
assert.match(phone, /id="on-the-go-mode"/, 'the phone companion exposes the same on-the-go switch');
assert.match(phone, /observeOnTheGoNeeds\(phoneNeeds\(\)\)/, 'phone SSE/home updates feed the on-the-go coordinator');
assert.match(voice, /vm-ongo/, 'on-the-go narration has a presentation distinct from manual Voice mode');
assert.match(voice, /WHAT HAPPENED/, 'the distinct presentation leads with the human-readable outcome');
assert.match(voice, /Sent to/, 'the briefing renders a visible per-session delivery receipt');
assert.match(phone, /feedback message.*sent/, 'the phone reports the completed handoff count');
assert.match(styles, /\.ongo-report/, 'the on-the-go report has its own responsive visual structure');
assert.match(voiceServer, /isNeedsYouSession/, 'the spoken count uses the same unread and undismissed Needs You rule');
assert.match(voiceServer, /originalRequest/, 'spoken items retain the operator’s original request');
assert.match(voiceServer, /latestReport/, 'spoken items retain the latest curated report');
for (const content of [onTheGo, dashboard, phone, push, sw]) {
  assert.doesNotMatch(content, /\bRide mode\b/i, 'the bicycle example is not used as the feature name');
}

console.log('on_the_go.test ok');
