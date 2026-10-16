import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createStoryLive } from '../web/story-live.js';

globalThis.document = new EventTarget(); document.hidden = false;
globalThis.window = new EventTarget();
const streams = [];
globalThis.EventSource = class extends EventTarget {
  constructor(url) { super(); this.url = url; streams.push(this); }
  close() { this.closed = true; }
};
let pauses = 0, requests = 0, finish;
const held = new Promise(resolve => finish = resolve);
const live = createStoryLive({ sessionId: 's_mobile', recoveryMs: 25, minIntervalMs: 5,
  refresh: () => { requests++; return held; }, pause: () => pauses++ });
try {
  live.setActive(true);
  const deadline = Date.now() + 2000;
  while (streams.length < 2 && Date.now() < deadline) await delay(10);
  assert.ok(streams.length >= 2, 'missing mobile heartbeats reconnect the SSE socket');
  assert.ok(streams[0].closed);
  assert.ok(requests > 0);
  assert.equal(pauses, 0, 'SSE repair does not cancel a healthy in-flight HTTP download');
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(pauses, 1, 'backgrounding still cancels requests to save mobile resources');
  const stoppedAt = requests; await delay(70); assert.equal(requests, stoppedAt);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  await delay(20); assert.ok(requests > stoppedAt, 'foregrounding catches up without reload');
} finally { live.close(); finish(true); }
console.log('story_live_controller: silent SSE repair preserves HTTP work; lifecycle cancellation and wake remain intact');
