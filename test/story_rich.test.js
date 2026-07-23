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

// ---- attachment previews: one send = one bubble, image thumbnails inside it ----
// The composer sends text + a manifest ("Attached files available locally… N. name (PNG): /path");
// the harness may ALSO deliver the image as its own "[Image: source: /path]" stub turn. The story
// folds both into the operator's single bubble as image previews (operator: "It should be in the
// same message as we send in one shot, and the image should be previewed").
{
  const { extractAttachmentImages } = await import('../src/story.js');
  const manifest = 'please fix the sidebar\n\nAttached files available locally to this coding CLI:\n1. Screenshot 2026-07-16 at 19.27.36.png (PNG, image/png): /Users/x/aios/.aios/attachments/s_1/1784201262058-u_a-Screenshot 2026-07-16 at 19.27.36.png\n2. notes.txt (TXT, text/plain): /Users/x/aios/.aios/attachments/s_1/1784201262059-u_b-notes.txt\n\nOpen these paths directly when you need the uploaded content.';
  const imgs = extractAttachmentImages(manifest);
  assert.deepEqual(imgs, ['1784201262058-u_a-Screenshot 2026-07-16 at 19.27.36.png'], 'extracts image basenames (spaces kept), skips non-images');

  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:00Z', message: { content: manifest } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:02Z', message: { content: '[Image: source: /Users/x/aios/.aios/attachments/s_1/1784201262058-u_a-Screenshot 2026-07-16 at 19.27.36.png]' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-16T10:01:00Z', message: { content: [{ type: 'text', text: 'On it.' }] } }),
  ].join('\n');
  const evs = parseSessionLog(lines);
  const yous = evs.filter((e) => e.kind === 'you');
  assert.equal(yous.length, 1, 'text turn + image-stub turn fold into ONE bubble');
  assert.equal(yous[0].body, 'please fix the sidebar', 'the manifest is stripped from the bubble text');
  assert.deepEqual(yous[0].images, ['1784201262058-u_a-Screenshot 2026-07-16 at 19.27.36.png'], 'the bubble carries the image preview (deduped across manifest + stub)');

  // an image-only send with no nearby bubble keeps a bubble of its own (preview, not vanished)
  const solo = parseSessionLog([
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T12:00:00Z', message: { content: '[Image: source: /Users/x/aios/.aios/attachments/s_1/shot-alone.png]' } }),
  ].join('\n'));
  const soloYou = solo.find((e) => e.kind === 'you');
  assert.ok(soloYou && !soloYou.body && soloYou.images?.length === 1, 'image-only send → image-only bubble');

  // fallback spine: the stored composed text also strips the manifest + carries previews
  const s = spineFromMessages([{ ts: 1, direction: 'in', source: 'text+attachments', text: manifest }]);
  assert.equal(s[0].text, 'please fix the sidebar', 'spine bubble text drops the manifest');
  assert.deepEqual(s[0].images, ['1784201262058-u_a-Screenshot 2026-07-16 at 19.27.36.png'], 'spine bubble carries the preview');

  // client renders previews inside the bubble via the session-scoped attachment route
  const sv = read('web/story-view.js');
  assert.ok(sv.includes('story-imgs') && sv.includes('attachment/${encodeURIComponent(f)}'), 'story view renders ev.images through api/session/:id/attachment');
  assert.ok(read('web/styles.css').includes('.story-imgs'), 'preview strip style exists');
}

// ---- round windowing: a round = request → COMPLETED report; in-flight requests don't count ----
// Operator (2026-07-16): "when a user sends a new request and the agent is still working, we should
// not consider that as one round" — the default 1-round view must keep the previous completed
// exchange visible instead of collapsing to just the new request + live progress.
{
  const { trimToRecentRounds, completedRoundStarts } = await import('../src/story.js');
  const you = (ts, body) => ({ kind: 'you', ts, body });
  const rep = (ts) => ({ kind: 'report', ts, body: 'report' });
  const work = (ts) => ({ kind: 'work', ts, title: 'worked' });

  // completed round + a NEW in-flight request → 1-round window starts at the COMPLETED round's request
  const evs = [{ kind: 'sys', ts: 1 }, you(2, 'first ask'), work(3), rep(4), you(5, 'new ask — agent still working'), work(6)];
  const t1 = trimToRecentRounds(evs, 1);
  assert.equal(t1.trimmed, false, 'only one completed round exists — nothing to trim');
  assert.ok(t1.events.some((e) => e.body === 'first ask'), 'the completed exchange stays visible');

  // two completed rounds + in-flight → 1-round window starts at the SECOND completed request
  const evs2 = [you(1, 'ask A'), rep(2), you(3, 'ask B'), rep(4), you(5, 'ask C in-flight'), work(6)];
  const t2 = trimToRecentRounds(evs2, 1);
  assert.equal(t2.trimmed, true);
  assert.equal(t2.events[0].body, 'ask B', 'window anchors at the last COMPLETED round, in-flight rides along');
  assert.ok(t2.events.some((e) => e.body === 'ask C in-flight'), 'the new request is still shown');

  // the old (wrong) anchor: counting the in-flight message as a round would have started at ask C
  assert.deepEqual(completedRoundStarts(evs2).map((i) => evs2[i].body), ['ask A', 'ask B'], 'in-flight ask C is not a round boundary');

  // no reports at all (poked a stuck agent repeatedly) → everything is ONE in-flight round, no trim
  const t3 = trimToRecentRounds([you(1, 'a'), work(2), you(3, 'b'), work(4)], 1);
  assert.equal(t3.trimmed, false, 'a report-less session is a single in-flight round');

  // supervisor nudges never count as boundaries
  const evs4 = [you(1, 'ask A'), rep(2), { kind: 'you', ts: 3, body: '[Supervisor] nudge' }, rep(4), you(5, 'ask B'), rep(6), you(7, 'live'), work(8)];
  assert.equal(trimToRecentRounds(evs4, 1).events[0].body, 'ask B', 'supervisor messages are not round anchors');
}

// ---- asks: one card per question; the tool_result is the DURABLE answer record ----
// Menu selections leave NO operator text turn in the transcript, so the old you-after-ask rule never
// marked them answered — the option buttons resurrected whenever the client's local memory reset on a
// session switch. And multi-question prompts only surfaced questions[0], showing stale options while
// the terminal had moved to question 2 (operator report 2026-07-16, s_07814eddc4).
{
  const ask = { type: 'tool_use', id: 'tu_1', name: 'AskUserQuestion', input: { questions: [
    { question: 'Default STT for CLI-authed users?', header: 'Default STT', options: [{ label: 'Match the session agent' }, { label: 'Keep Spark' }] },
    { question: 'How much to build in this first pass?', header: 'Build scope', options: [{ label: 'Codex first' }, { label: 'Both now' }] },
  ] } };
  const result = 'Your questions have been answered: "Default STT for CLI-authed users?"="Match the session agent", "How much to build in this first pass?"="Codex first". You can now continue with these answers in mind.';
  const mk = (parts) => JSON.stringify(parts);
  const before = parseSessionLog([
    mk({ type: 'user', timestamp: '2026-07-16T10:00:00Z', message: { content: 'design the STT flow' } }),
    mk({ type: 'assistant', timestamp: '2026-07-16T10:01:00Z', message: { content: [ask] } }),
  ].join('\n'));
  const pending = before.filter((e) => e.kind === 'ask');
  assert.equal(pending.length, 2, 'a two-question prompt renders TWO ask cards');
  assert.ok(pending[1].body.includes('How much to build'), 'question 2 is visible (not just questions[0])');
  assert.ok(pending.every((e) => !e.answered), 'both pending until the tool completes');

  const after = parseSessionLog([
    mk({ type: 'user', timestamp: '2026-07-16T10:00:00Z', message: { content: 'design the STT flow' } }),
    mk({ type: 'assistant', timestamp: '2026-07-16T10:01:00Z', message: { content: [ask] } }),
    mk({ type: 'user', timestamp: '2026-07-16T10:05:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: result }] } }),
  ].join('\n'));
  const answered = after.filter((e) => e.kind === 'ask');
  assert.ok(answered.every((e) => e.answered), 'the tool_result answers BOTH questions — no operator text turn needed');
  assert.equal(answered[0].answeredWith, 'Match the session agent', 'per-question answer extracted');
  assert.equal(answered[1].answeredWith, 'Codex first', 'per-question answer extracted (q2)');

  // codex: request_user_input's function_call_output is the same durable record
  const codex = parseSessionLog([
    JSON.stringify({ timestamp: '2026-07-16T10:00:00Z', payload: { type: 'response_item' }, type: 'response_item' }),
    JSON.stringify({ timestamp: '2026-07-16T10:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'c1', arguments: JSON.stringify({ question: 'Ship now?', options: ['yes', 'no'] }) } }),
    JSON.stringify({ timestamp: '2026-07-16T10:02:00Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'yes' } }),
  ].join('\n'));
  const cAsk = codex.find((e) => e.kind === 'ask');
  assert.ok(cAsk?.answered && cAsk.answeredWith === 'yes', 'codex ask answered via its function_call_output');
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


// Source-switch dedupe (E2E finding #3): the fallback-spine story arrives BEFORE the CLI transcript is
// locatable; when the source switches the client must REPLACE the feed, not merge two copies of the
// same conversation. And the story header must not say "session starting" once a report is in (#4).
{
  const svSrc = read('web/story-view.js');
  assert.ok(/const src = r\.meta\?\.source \|\| 'transcript'/.test(svSrc)
      && /const identity = `\$\{src\}\|\$\{r\.meta\?\.file \|\| ''\}`/.test(svSrc)
      && /storyIdentity && identity !== storyIdentity/.test(svSrc),
    'story view replaces the feed when source or transcript-file identity changes');
  assert.ok(/storySource = null/.test(svSrc) && /storyIdentity = null/.test(svSrc), 'source identity tracking resets on session switch');
  assert.ok(svSrc.includes("report in — waiting for you"), 'rollup fallback reflects waiting-with-report, not "session starting"');
  const apiSrc = read('src/story_api.js');
  assert.ok(/source: 'transcript'/.test(apiSrc) && /source: 'fallback'/.test(apiSrc), 'the story API tags both sources in meta');
}

console.log('story_rich: all assertions passed');
