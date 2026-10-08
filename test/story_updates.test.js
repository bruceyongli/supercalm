import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createStoryUpdates } from '../src/story_updates.js';

const root = await mkdtemp(join(tmpdir(), 'aios-story-updates-'));
const bus = new EventEmitter();
let source = { file: join(root, 'native.jsonl'), state: ['working'] }, watches = 0, ignoreWatch = false;
const updates = createStoryUpdates({ bus, resolve: async () => source, debounceMs: 10, repairMs: 70, pingMs: 1000,
  watchFile: (file, options, callback) => { watches++; return watch(file, options, e => { if (!ignoreWatch) callback(e); }); } });
const client = () => ({ messages: [], writableLength: 0, write(s) { this.messages.push(s); },
  destroy() { this.destroyed = true; }, end() { this.writableEnded = true; } });
const wait = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Story watcher did not publish'); await new Promise(r => setTimeout(r, 5)); }
};
try {
  await writeFile(source.file, '{}\n');
  assert.equal(updates.size(), 0, 'unviewed sessions do no transcript watching');
  const a = client(), b = client();
  const closeA = updates.subscribe('s_own', a), closeB = updates.subscribe('s_own', b);
  await wait(() => watches === 1 && a.messages.length >= 2);
  assert.equal(updates.size(), 1, 'two devices share one watcher');
  const count = a.messages.length;
  await appendFile(source.file, '{"report":"Native completion"}\n');
  await wait(() => a.messages.length > count && b.messages.length > count);
  assert.equal(source.state[0], 'working', 'native completion needs no lifecycle transition');
  assert.match(a.messages.at(-1), /event: update/);
  assert.doesNotMatch(a.messages.at(-1), /Native completion|native\.jsonl/, 'notifications contain no transcript blobs/paths');
  const beforeMiss = a.messages.length;
  ignoreWatch = true;
  await appendFile(source.file, '{"report":"Missed fs notification"}\n');
  await wait(() => a.messages.length > beforeMiss);
  ignoreWatch = false;
  const beforeStatus = a.messages.length;
  bus.emit('session-status', { session: 's_other', source: 'reply', status: 'working', previousStatus: 'working' });
  bus.emit('session-status', { session: 's_own', source: 'activity', status: 'working', previousStatus: 'working' });
  await new Promise(r => setTimeout(r, 25));
  assert.equal(a.messages.length, beforeStatus, 'sibling/terminal heartbeat events do not invalidate Story');
  bus.emit('session-status', { session: 's_own', source: 'reply', status: 'working', previousStatus: 'working' });
  await wait(() => a.messages.length > beforeStatus);
  const beforeRotate = a.messages.length;
  const replacement = join(root, 'replacement.jsonl'); await writeFile(replacement, '{"report":"Rotated"}\n');
  await rename(replacement, source.file);
  await wait(() => a.messages.length > beforeRotate && watches >= 2);
  source = { file: join(root, 'resumed.jsonl'), state: ['working'] };
  await writeFile(source.file, '{}\n');
  const beforeResume = a.messages.length;
  bus.emit('session-status', { session: 's_own', source: 'transcript', status: 'working', previousStatus: 'working' });
  await wait(() => a.messages.length > beforeResume && watches >= 3);
  a.writableLength = 70 * 1024;
  await appendFile(source.file, '{"report":"After resume"}\n');
  await wait(() => a.destroyed);
  closeA(); assert.equal(updates.size(), 1);
  closeB(); assert.equal(updates.size(), 0, 'last viewer releases watcher and all timers');
  const reconnect = client(), close = updates.subscribe('s_own', reconnect);
  assert.match(reconnect.messages[0], /"initial":true/, 'reconnect always requests authoritative catch-up');
  close(); assert.equal(updates.size(), 0);
} finally { updates.close(); await rm(root, { recursive: true, force: true }); }
assert.equal(bus.listenerCount('session-status'), 0);
console.log('story_updates: shared native watcher, missed-event repair, isolation, rotation, backpressure and cleanup passed');
