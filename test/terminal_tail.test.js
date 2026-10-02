import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { flushTerminalTail, watchTerminalTail, stopTerminalTail } from '../src/terminal_tail.js';

const root = await mkdtemp(join(tmpdir(), 'aios-terminal-tail-'));
let entry;
try {
  const file = join(root, 'terminal.log');
  await writeFile(file, 'old screen');
  const received = [];
  const client = { writableLength: 0, write: payload => received.push(payload) };
  entry = { logFile: file, offset: 10, subscribers: new Set([client]) };
  let reads = 0;
  const deps = { statFile: async () => ({ size: 14 }), read: async () => {
    reads++; await new Promise(resolve => setTimeout(resolve, 25)); return Buffer.from('next');
  } };
  await Promise.all(Array.from({ length: 8 }, () => flushTerminalTail(entry, deps)));
  assert.equal(reads, 1, 'polling/watch notifications share one read');
  assert.equal(received.length, 1, 'a frame is delivered exactly once');
  assert.equal(entry.offset, 14);
  await flushTerminalTail(entry, deps);
  assert.equal(received.length, 1, 'unchanged logs do not replay bytes');
  entry.subscribers.clear();
  let stats = 0;
  await flushTerminalTail(entry, { statFile: async () => { stats++; } });
  assert.equal(stats, 0, 'unviewed sessions do no log polling I/O');

  const slow = { writableLength: 2 * 1024 * 1024, destroy() { this.destroyed = true; }, write() { throw Error('must reconnect'); } };
  entry.subscribers.add(slow);
  await flushTerminalTail(entry, { statFile: async () => ({ size: 18 }), read: async () => Buffer.from('more') });
  assert.equal(slow.destroyed, true, 'backpressured clients reconnect to the current screen');
  assert.equal(entry.subscribers.size, 0);

  received.length = 0; entry.offset = 10; entry.subscribers.add(client);
  watchTerminalTail(entry);
  await appendFile(file, 'immediate');
  const deadline = Date.now() + 3000;
  while (!received.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.length, 1, 'filesystem notification delivers bytes without waiting for a poll tick');
  assert.equal(Buffer.from(received[0].match(/data: (.+)/)[1], 'base64').toString(), 'immediate');
  stopTerminalTail(entry);
  assert.equal(entry.tailWatcher, null);
  await writeFile(file, 'rotated');
  received.length = 0;
  await flushTerminalTail(entry);
  assert.equal(entry.offset, 7, 'a shorter rotated log re-baselines its byte offset');
  assert.equal(Buffer.from(received[0].match(/data: (.+)/)[1], 'base64').toString(), 'rotated');
} finally { if (entry) stopTerminalTail(entry); await rm(root, { recursive: true, force: true }); }
console.log('terminal_tail: immediate notifications, single reader, bounded backpressure and rotation passed');
