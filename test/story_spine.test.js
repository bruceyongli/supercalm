// Story spine — locks the source-attribution that fixes the empty story + the "mystery unattributed
// messages" report. messageToEvent is pure (no store/server import), so it's tested directly; the wiring
// in story_api.js / story.js / story-view.js is source-locked (importing those boots the poll loop).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messageToEvent, spineFromMessages } from '../src/story_spine.js';

// ---- operator sources → real "you" bubble (the actual text, not a placeholder) ----
for (const source of ['text', 'task', 'voice', 'operator', 'operator-correction']) {
  const e = messageToEvent({ ts: 1, direction: 'in', source, text: 'do the thing' });
  assert.equal(e.kind, 'you', `${source} → you`);
  assert.equal(e.text, 'do the thing', `${source} keeps real text`);
  assert.ok(!e.chips, `${source} has no attachment chip`);
}
// attachments marker → chip, still operator text
const att = messageToEvent({ ts: 1, direction: 'in', source: 'text+attachments', text: 'see image' });
assert.equal(att.kind, 'you');
assert.deepEqual(att.chips, ['attachments']);

// ---- detect terminal snapshots (the "request failed 405" / gcm noise) → DROP ----
assert.equal(messageToEvent({ ts: 1, direction: 'out', source: 'detect', text: 'ERROR gcm registration 405' }), null);

// ---- supervisor nudges → DROP (machine steering, existing policy) ----
assert.equal(messageToEvent({ ts: 1, direction: 'in', source: 'agent:supervisor', text: 'Before sign-off…' }), null);
assert.equal(messageToEvent({ ts: 1, direction: 'in', source: 'supervisor', text: 'legacy nudge' }), null);

// ---- other agent / cross-session injections → labeled sys note, NEVER an operator "you" bubble ----
for (const source of ['codex', 'claude-session', 'codex-coordination', 'share-claude']) {
  const e = messageToEvent({ ts: 1, direction: 'in', source, text: 'BLOCKER from s_x retest' });
  assert.equal(e.kind, 'sys', `${source} is not a you bubble`);
  assert.ok(e.text.startsWith(`[${source}] `), `${source} is attributed: ${e.text}`);
}
// agent: prefix is stripped in the label
assert.ok(messageToEvent({ ts: 1, direction: 'in', source: 'agent:codex', text: 'coord' }).text.startsWith('[codex] '));

// ---- agent replies (out, non-detect) → note; empty text → drop ----
assert.equal(messageToEvent({ ts: 1, direction: 'out', source: 'reply', text: 'done' }).kind, 'note');
assert.equal(messageToEvent({ ts: 1, direction: 'in', source: 'text', text: '   ' }), null);
assert.equal(messageToEvent(null), null);

// ---- spineFromMessages: drops nulls, preserves order ----
const spine = spineFromMessages([
  { ts: 1, direction: 'in', source: 'task', text: 'start' },
  { ts: 2, direction: 'out', source: 'detect', text: 'noise' }, // dropped
  { ts: 3, direction: 'in', source: 'agent:supervisor', text: 'nudge' }, // dropped
  { ts: 4, direction: 'in', source: 'text', text: 'next' },
]);
assert.deepEqual(spine.map((e) => e.text), ['start', 'next']);

// ---- source locks: the wiring the pure module can't observe ----
const storyApi = readFileSync(new URL('../src/story_api.js', import.meta.url), 'utf8');
assert.ok(/spineFromMessages\(messagesFor\(sid, \d+\)\)/.test(storyApi), 'fallbackStory builds the spine from messagesFor');
assert.ok(!storyApi.includes("text isn't stored"), 'the placeholder wording is gone');

const story = readFileSync(new URL('../src/story.js', import.meta.url), 'utf8');
assert.ok(/hook feedback\\b/.test(story), 'transcript parser drops hook-injected "… hook feedback" turns');

const storyView = readFileSync(new URL('../web/story-view.js', import.meta.url), 'utf8');
assert.ok(storyView.includes('answeredAsks') && storyView.includes('askKey'), 'story view keeps sticky answered-ask memory');
assert.ok(/answeredAsks\.set\(/.test(storyView), 'answering an ask records it so a refresh does not bounce it back');

console.log('story_spine: all assertions passed');
