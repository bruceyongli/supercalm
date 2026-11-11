import assert from 'node:assert/strict';
import { overlayStoryInputs, reconcileStoryInputs, nativeInputEvidence } from '../src/story_inputs.js';
import { parseSessionLog } from '../src/story.js';

const row = (id, text, ts = 100000 + id * 1000) => ({ id, ts, text, direction: 'in', source: 'text',
  client_message_id: `send-${id}`, delivery_state: 'queued' });
const native = (text, ts, uuid = 'native-user') => parseSessionLog(JSON.stringify({ type: 'user', uuid,
  timestamp: new Date(ts).toISOString(), message: { content: text } }));
const report = { kind: 'report', ts: 100000, body: 'Latest completed update' };
const rows = [row(1, 'What is the TypeScript switch?'), row(2, 'Is Rust migration finished?'), row(3, 'Why still Python?')];
let events = overlayStoryInputs([report], rows);
assert.deepEqual(events.filter(e => e.kind === 'you').map(e => e.delivery), ['queued', 'queued', 'queued']);
assert.deepEqual(overlayStoryInputs([report], rows), events, 'reload has no page-local dependencies');
assert.deepEqual([report], [{ kind: 'report', ts: 100000, body: 'Latest completed update' }], 'native cache is immutable');
events = overlayStoryInputs([report, ...native(rows[0].text, rows[0].ts)], rows);
assert.equal(events.filter(e => e.kind === 'you').length, 3);
assert.equal(events.find(e => e.inputMessageId === 1).delivery, 'read');
assert.equal(events.filter(e => e.delivery === 'queued').length, 2);
assert.equal(overlayStoryInputs([report], [...rows, { ...row(4, 'Helper report'), source: 'agent:review' },
  { ...row(5, 'Automatic report'), source: 'supervisor' }, { ...row(6, 'CLI noise'), direction: 'out' }]).length, 4);
assert.equal(overlayStoryInputs([report], [row(1, 'Earlier request', 1000)], { historical: true }).length, 1);
assert.equal(overlayStoryInputs([report], rows, { historical: true }).length, 1, 'old page never includes future sends');
assert.equal(overlayStoryInputs([], rows).length, 3, 'native file containing only queue records still shows accepted messages');
assert.equal(overlayStoryInputs([], rows, { historical: true }).length, 0);
const long = 'Shared start. ' + 'Keep all requirements. 中文。 '.repeat(1000);
const distinct = [row(1, long + 'Keep it.'), row(2, long + 'Remove it.')];
events = overlayStoryInputs([report, ...native(distinct[1].text, distinct[1].ts)], distinct);
assert.equal(events.find(e => e.inputMessageId === 1).delivery, 'queued', 'shared prefix is not a receipt');
assert.equal(events.find(e => e.inputMessageId === 2).delivery, 'read');
const repeats = [row(1, 'continue', 101000), row(2, 'continue', 106000)];
events = overlayStoryInputs([...native('continue', 106000, 'second')], repeats);
assert.equal(events.length, 1, 'paged repeat does not resurrect an older identical input');
assert.equal(events[0].inputMessageId, 2);
events = overlayStoryInputs([report, ...native('continue', 101000, 'first'), ...native('continue', 106000, 'second')], repeats);
assert.deepEqual(events.filter(e => e.kind === 'you').map(e => e.inputMessageId), [1, 2]);
const upload = 'Inspect this.\n\nAttached files available locally to this coding CLI:\n1. test.txt (TXT, text/plain): /fixture/test.txt';
events = overlayStoryInputs(native(`<pasted_content id="p">${upload}</pasted_content>`, 101000), [row(1, upload)]);
assert.equal(events.length, 1); assert.equal(events[0].delivery, 'read');
events = overlayStoryInputs([report], [{ ...row(1, 'Legacy accepted input'), delivery_state: null }]);
assert.equal(events[1].delivery, 'sent', 'legacy receipt cannot invent read/queue evidence');
const allConsumed = rows.flatMap((r, i) => native(r.text, r.ts, `consumed-${i}`));
const evidence = nativeInputEvidence(allConsumed);
const paged = reconcileStoryInputs(allConsumed.slice(-1), rows, { receipts: evidence.inputReceipts, windowStart: evidence.inputWindowStart });
assert.deepEqual(paged.readInputIds, [1, 2, 3], 'consumption proof survives recent-round trimming');
assert.equal(paged.events.length, 1, 'read inputs outside this page do not resurrect historical bubbles');
const pendingPastRound = reconcileStoryInputs([report, { kind: 'report', ts: 200000, body: 'Later helper report' }].slice(-1),
  rows, { receipts: [], windowStart: 100000 });
assert.equal(pendingPastRound.events.filter(e => e.delivery === 'queued').length, 3, 'unconsumed sends inside the scanned native window remain visible');
console.log('story_inputs: durable queue, full content, uploads, repeated sends, paging and attribution passed');
