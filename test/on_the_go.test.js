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
const player = read('web/tts-player.js');

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
assert.match(sw, /action: 'talk'/, 'supporting browsers expose a Voice Assistant notification action');
assert.match(sw, /silent: false/, 'the background notification asks the OS to use an audible alert');
assert.match(dashboard, /id="dk-on-the-go"/, 'the canonical Needs You dashboard exposes the on-the-go switch');
assert.match(phone, /id="on-the-go-mode"/, 'the phone companion exposes the same on-the-go switch');
assert.match(phone, /observeOnTheGoNeeds\(phoneNeeds\(\)\)/, 'phone SSE/home updates feed the on-the-go coordinator');
assert.match(phone, /phoneVoiceConstraints[\s\S]*noiseSuppression/,
  'the iPhone capture path requests platform noise suppression before semantic filtering');
assert.match(phone, /onSegment:[\s\S]*paintVoiceSegment\(segment\)/, 'sentence progress updates only the spoken line');
assert.doesNotMatch(phone, /onSegment:[\s\S]{0,180}V\.segment = segment;\s*render\(\)/,
  'sentence synchronization never rebuilds the full phone app');
assert.match(phone, /previousId[\s\S]*nextId[\s\S]*V\.lastHeard = ''/, 'a phone transcript is cleared when the next session is actually presented');
assert.match(voice, /vm-ongo/, 'on-the-go narration has a presentation distinct from manual Voice mode');
assert.match(voice, /NOW READING/, 'the distinct presentation identifies the sentence currently being spoken');
assert.match(voice, /YOUR LAST RESPONSE/, 'the operator transcript remains a first-class part of the conversation');
assert.match(voice, /Ask a follow-up or give feedback naturally/,
  'proactive reports continue as a normal Voice Assistant conversation');
assert.match(voice, /api\/transcribe\?language=auto&polish=true/,
  'Voice Assistant uses Spark transcript cleanup before intent reasoning');
assert.match(voice, /markIgnoredSpeech\(state\.ignoredReason\)/,
  'nearby or silent speech is visibly ignored instead of becoming a response');
assert.match(player, /onSegment/, 'the shared TTS stack exposes sentence progress to its presentation');
assert.doesNotMatch(voice, /ui\.heard\.textContent = ''/,
  'starting the next spoken turn never erases the operator’s visible response');
assert.match(voice, /Sent to/, 'the briefing renders a visible per-session delivery receipt');
assert.match(voice, /ui\.sessionId !== cur\.sessionId[\s\S]*Your words will stay here/,
  'desktop on-the-go also scopes the visible response to one session');
assert.match(phone, /feedback message.*sent/, 'the phone reports the completed handoff count');
assert.match(styles, /\.ongo-report/, 'the on-the-go report has its own responsive visual structure');
assert.match(voiceServer, /isNeedsYouSession/, 'the spoken count uses the same unread and undismissed Needs You rule');
assert.match(voiceServer, /originalRequest/, 'spoken items retain the operator’s original request');
assert.match(voiceServer, /latestReport/, 'spoken items retain the latest curated report');
assert.match(voiceServer, /storyFor\(it\.sessionId, \{ rounds: 4 \}\)/,
  'briefing and follow-up answers use recent session conversation, not only the thin status card');
assert.match(voiceServer, /getContext\(project\.id\)/,
  'follow-up questions can use maintained project knowledge when the owner asks for it');
assert.match(voiceServer, /taskCard\(runtime\.active_task_id\)/,
  'briefing knows the current task contract and verification criteria');
assert.match(voiceServer, /normalizeVoiceAddress\(rawUserText\)/,
  'proactive and manual speech enter the same conversation path');
assert.match(voiceServer, /AIOS_VOICE_CONVERSATION_CHAIN[\s\S]*claude-opus-5[\s\S]*gpt-5\.6-luna[\s\S]*qwen36-a3b-nvfp4-marlin/,
  'follow-up reasoning prioritizes Opus 5 and retains GPT-5.6 and the local model as fallbacks');
assert.doesNotMatch(voiceServer, /ON_THE_GO_SYS/,
  'Voice updates does not maintain a separate lower-quality assistant prompt');
assert.doesNotMatch(voiceServer, /onTheGoImmediateReply/,
  'no transcript bypasses contextual intent reasoning into immediate delivery');
assert.match(voiceServer, /current: currentBeforeTurn/, 'delivery confirmation remains labeled with the session that received it');
for (const content of [onTheGo, dashboard, phone, push, sw]) {
  assert.doesNotMatch(content, /\bRide mode\b/i, 'the bicycle example is not used as the feature name');
}
for (const content of [dashboard, phone, voice]) {
  assert.doesNotMatch(content, />\s*ON THE GO\s*</i, 'the old activity-specific label is no longer user-facing');
}
assert.match(dashboard, /Voice updates/, 'the proactive control is named for what it does');
assert.match(dashboard, /Voice Assistant/, 'the manual and proactive paths share one assistant identity');

console.log('on_the_go.test ok');
