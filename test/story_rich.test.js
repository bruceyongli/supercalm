// Rich report bodies — locks the "story view is not displaying reports with table or rich content"
// fix (2026-07-15). Contract: note/report bodies KEEP their markdown end-to-end (tables, headings,
// fences, inline code) so the client renders them as rich content; only XML/tool-tag noise is
// stripped, and never from inside code. fail bodies stay de-markdowned one-liners. The fallback
// spine's promoted reports keep line structure. Client wiring is source-locked (importing
// story-view.js needs a DOM; importing story_api.js boots the poll loop).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSessionLog } from '../src/story.js';
import { spineFromMessages } from '../src/story_spine.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ---- transcript parser: a claude report keeps its markdown, loses only tool-tag noise ----
{
  const report = [
    '## Results',
    '',
    '| name | status |',
    '|------|--------|',
    '| auth | pass   |',
    '',
    'Inline `<base href="/aios/">` mention survives, **bold** survives.',
    '',
    '```jsx',
    'const a = <div>kept: fenced code is content</div>;',
    '```',
    '',
    '<tool_use_error>tag noise outside code is stripped</tool_use_error>',
  ].join('\n');
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-07-15T10:00:00Z', message: { content: 'run the checks' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-15T10:00:05Z', message: { content: [{ type: 'text', text: report }] } }),
  ].join('\n');
  const evs = parseSessionLog(lines);
  const rep = evs[evs.length - 1];
  assert.equal(rep.kind, 'report', 'trailing assistant text is the report');
  assert.ok(rep.body.includes('## Results'), 'heading marker kept (client renders it)');
  assert.ok(rep.body.includes('| name | status |'), 'table row kept verbatim');
  assert.ok(/^\|-+\|-+\|$/m.test(rep.body), 'table separator row kept (renderMarkdown needs it)');
  assert.ok(rep.body.includes('**bold**'), 'bold marker kept');
  assert.ok(rep.body.includes('`<base href="/aios/">`'), 'inline-code tag mention NOT mangled');
  assert.ok(rep.body.includes('<div>kept: fenced code is content</div>'), 'fenced code keeps its tags');
  assert.ok(!rep.body.includes('<tool_use_error>'), 'tool tag outside code stripped');
  assert.ok(rep.body.includes('tag noise outside code is stripped'), 'tag CONTENT survives the strip');
}

// ---- fail bodies stay plain one-liners (deMd remains theirs) ----
{
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-07-15T10:00:00Z', message: { content: 'go' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-15T10:00:10Z', message: { content: [{ type: 'tool_result', is_error: true, content: '<tool_use_error>**boom**: `x` failed</tool_use_error>' }] } }),
  ].join('\n');
  const fail = parseSessionLog(lines).find((e) => e.kind === 'fail');
  assert.ok(fail, 'tool error still becomes a fail event');
  assert.ok(!fail.body.includes('**') && !fail.body.includes('<tool_use_error>'), 'fail body is de-markdowned + tag-stripped');
}

// ---- fallback spine: promoted reports keep line structure; mid-turn notes stay one-line stubs ----
{
  const md = '## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const s = spineFromMessages([
    { ts: 1, direction: 'in', source: 'task', text: 'go' },
    { ts: 2, direction: 'out', source: 'reply', text: 'line one\nline two' }, // mid-turn: stays a note
    { ts: 3, direction: 'out', source: 'reply', text: md },                   // turn-final: the report
  ]);
  assert.equal(s[2].kind, 'report');
  assert.ok(s[2].text.includes('\n| a | b |'), 'promoted report keeps newlines so its table renders');
  assert.equal(s[1].kind, 'note');
  assert.ok(!s[1].text.includes('\n'), 'mid-turn notes keep the compact single-line clip');
}

// ---- true end-to-end: transcript → parseSessionLog → the REAL client renderer → rich HTML ----
// common.js is importable in Node (DOM refs live inside function bodies), so this closes the loop
// the source-locks below can't: the exact body the server ships renders to an actual <table>.
{
  const { renderMarkdown } = await import('../web/common.js');
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-07-15T10:00:00Z', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-15T10:00:05Z', message: { content: [{ type: 'text', text: '## Results\n\n| name | status |\n|------|--------|\n| auth | pass |' }] } }),
  ].join('\n');
  const evs = parseSessionLog(lines);
  const html = renderMarkdown(evs[evs.length - 1].body);
  assert.ok(html.includes('<table><thead><tr><th>name</th><th>status</th>'), 'report table renders to a real <table>');
  assert.ok(html.includes('<h2>Results</h2>'), 'report heading renders to a real heading');
}

// ---- harness task-notifications are MACHINE turns, never operator bubbles ----
// Background-task events (Monitor/Agent completions) are injected into the CLI transcript as
// user-ROLE turns. Rendered as "you" they showed raw XML under the operator's own glyph AND became
// the story's round boundary — the default 1-round view started at the notification instead of the
// operator's real message (operator report 2026-07-16: "I did not send this message").
{
  const notif = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement.\n\n<task-notification>\n<task-id>bzikb67aa</task-id>\n<status>completed</status>\n<summary>Monitor "integration int_x" stream ended</summary>\n</task-notification>';
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:00Z', message: { content: 'please fix the sidebar' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-16T10:00:10Z', message: { content: [{ type: 'text', text: 'working on it' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:05:00Z', message: { content: notif } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-16T10:06:00Z', message: { content: [{ type: 'text', text: 'Done — sidebar shipped.' }] } }),
  ].join('\n');
  const evs = parseSessionLog(lines);
  const yous = evs.filter((e) => e.kind === 'you');
  assert.equal(yous.length, 1, 'the notification turn is dropped — exactly one operator bubble');
  assert.equal(yous[0].body, 'please fix the sidebar', 'the real operator message survives as the round boundary');
  assert.ok(!JSON.stringify(evs).includes('task-notification'), 'no event carries the raw notification XML');

  // An operator PASTING a notification to ask about it keeps their words; only the banner goes.
  const paste = 'why did this show up in my story?\n\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.';
  const evs2 = parseSessionLog([
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:00Z', message: { content: paste } }),
  ].join('\n'));
  const you2 = evs2.find((e) => e.kind === 'you');
  assert.ok(you2 && you2.body.includes('why did this show up'), 'operator commentary in a mixed paste survives');
  assert.ok(!you2.body.includes('SYSTEM NOTIFICATION'), 'the banner paragraph is stripped from the paste');

  // Attachment plumbing around an image message is not the operator's words either: the "[Image #N]"
  // numbering marker is stripped from their text, and a turn that is ONLY an "[Image: source: /path]"
  // pointer stub is dropped entirely (it rendered as a bare operator bubble).
  const evs3 = parseSessionLog([
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:00Z', message: { content: '[Image #1] please review the sidebar layout' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:05Z', message: { content: '[Image: source: /Users/x/.aios/attachments/s_1/shot.png]' } }),
  ].join('\n'));
  const yous3 = evs3.filter((e) => e.kind === 'you');
  assert.equal(yous3.length, 1, 'the pointer-stub-only turn is dropped');
  assert.equal(yous3[0].body, 'please review the sidebar layout', 'the [Image #N] marker is stripped from the real message');
}

// ---- source locks: the client render path + cache-key agreement ----
const storyView = read('web/story-view.js');
assert.ok(storyView.includes('story-body md') && storyView.includes('renderMarkdown(bodyText)'),
  'story view renders report/note bodies through common.js renderMarkdown');
const css = read('web/styles.css');
assert.ok(css.includes('.story-body.md table') && css.includes('.story-body.md pre'),
  'rich-body table/code styles exist on the story palette');
const svKey = storyView.match(/aios_story(\d+)_/)?.[1];
const shKey = read('web/shell.js').match(/aios_story(\d+)_/)?.[1];
assert.ok(svKey && svKey === shKey, `story cache-key version agrees between story-view.js (v${svKey}) and shell.js prefetch (v${shKey})`);
assert.ok(Number(svKey) >= 4, 'cache key bumped past v3 — cached notification bubbles must not merge back in');

// Round pagination: ‹ previous round (left) + ↑ show the full story (right); rounds ride the fetch.
assert.ok(storyView.includes('data-story-prev') && storyView.includes('data-story-earlier'), 'both load-earlier controls exist');
assert.ok(/rounds > 1 \? `\?rounds=\$\{rounds\}` : ''/.test(storyView), 'refreshStory passes the incremental rounds window');
assert.ok(/pendingAnchor/.test(storyView), 'load-earlier renders keep the viewport anchored (content prepends)');

console.log('story_rich: all assertions passed');
