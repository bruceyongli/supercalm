import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoryPage, readStoryImage } from '../src/story_reader.js';

const root = await mkdtemp(join(tmpdir(), 'aios-story-images-'));
const file = join(root, 'native.jsonl');
const record = (n, type, content, extra = {}) => JSON.stringify({ timestamp: new Date(1700000000000 + n * 1000).toISOString(),
  type, message: { id: `message-${n}`, content, stop_reason: type === 'assistant' ? 'end_turn' : undefined }, ...extra }) + '\n';
const raw = Buffer.alloc(450000, 42);
const screenshot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: raw.toString('base64') } };
const report = '## Finished\n\n完整报告，不截断。\n\n| Check | Result |\n|---|---|\n| Rendering | Correct |\n\n[Report](https://example.test/report.html)';
const round = n => record(n, 'user', 'Inspect the 中文 screenshot')
  + record(n + 1, 'assistant', [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: 'inspect', description: 'Inspect screenshot' } }])
  + record(n + 2, 'user', [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: [screenshot] }])
  + record(n + 3, 'assistant', [{ type: 'text', text: report }]);
const reject = args => assert.rejects(readStoryImage(args), { code: 'STORY_IMAGE_MISSING' });
try {
  await writeFile(file, round(0) + round(10));
  const recent = await readStoryPage({ file });
  assert.equal(recent.events.find(e => e.kind === 'report').body, report);
  assert.ok(Buffer.byteLength(JSON.stringify(recent)) < 5000, 'screenshots never inflate the report payload');
  assert.equal(recent.events.some(e => e.shot), false, 'no embedded image bytes in JSON');
  const ref = recent.events.find(e => e.shotRef).shotRef;
  const image = await readStoryImage({ file, ref });
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(Buffer.from(image.data), raw, 'lazy image is byte-for-byte original');
  const older = await readStoryPage({ file, cursor: recent.meta.cursor });
  const oldRef = older.events.find(e => e.shotRef).shotRef;
  assert.notEqual(ref, oldRef, 'earlier pages retain their own record offsets');
  assert.deepEqual(Buffer.from((await readStoryImage({ file, ref: oldRef })).data), raw);
  await appendFile(file, record(20, 'user', 'Next request'));
  assert.deepEqual(Buffer.from((await readStoryImage({ file, ref })).data), raw, 'append-only updates preserve cached references');
  const sibling = join(root, 'sibling.jsonl');
  await writeFile(sibling, round(0) + round(10));
  await reject({ file: sibling, ref });
  for (const invalid of [null, '', 'x'.repeat(2000), Buffer.from('null').toString('base64url')]) await reject({ file, ref: invalid });
  const parsed = JSON.parse(Buffer.from(ref, 'base64url'));
  for (const patch of [{ offset: -1 }, { offset: 1e20 }, { length: 9000000 }, { index: 99 }, { hash: 'a'.repeat(64) }]) {
    await reject({ file, ref: Buffer.from(JSON.stringify({ ...parsed, ...patch })).toString('base64url') });
  }
  await writeFile(file, round(0) + round(10).replace('Inspect screenshot', 'Changed screenshot'));
  // Replacing the actual referenced record without changing its length must fail the content hash.
  await writeFile(file, (round(0) + round(10)).replaceAll(raw.toString('base64'), Buffer.alloc(raw.length, 43).toString('base64')));
  await reject({ file, ref });
  await rename(file, join(root, 'rotated.jsonl'));
  await writeFile(file, round(0) + round(10));
  await reject({ file, ref });
  const unsupported = round(0).replace('image/png', 'image/svg+xml');
  await writeFile(file, unsupported);
  assert.equal((await readStoryPage({ file })).events.some(e => e.shotRef), false, 'active document formats are not image previews');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('story_images: compact reports, exact lazy images, UTF-8 offsets, history, append, rotation and session isolation');
