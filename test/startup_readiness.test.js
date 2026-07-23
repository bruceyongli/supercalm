import assert from 'node:assert/strict';
import { bootPayload, createBootState, loadSequentially, trafficAllowed } from '../src/startup.js';

const order = [];
const state = createBootState(100);
await loadSequentially(['one', 'two', 'three'], {
  state,
  load: async (name) => {
    order.push(`start:${name}`);
    await Promise.resolve();
    order.push(`end:${name}`);
  },
});
assert.deepEqual(order, [
  'start:one', 'end:one',
  'start:two', 'end:two',
  'start:three', 'end:three',
]);
assert.equal(state.phase, 'ready');
assert.equal(state.ready, true);
assert.deepEqual(state.loaded, ['one', 'two', 'three']);
assert.equal(trafficAllowed('/api/state', state), true);

const loading = createBootState();
assert.equal(trafficAllowed('/healthz', loading), true);
assert.equal(trafficAllowed('/readyz', loading), true);
assert.equal(trafficAllowed('/api/state', loading), false);
assert.equal(bootPayload(loading).ready, false);

const attempted = [];
const failed = createBootState();
await assert.rejects(
  loadSequentially(['good', 'bad', 'never'], {
    state: failed,
    load: async (name) => {
      attempted.push(name);
      if (name === 'bad') throw new Error('broken feature');
    },
  }),
  /broken feature/,
);
assert.deepEqual(attempted, ['good', 'bad'], 'bootstrap stops at the first failed feature');
assert.equal(failed.ready, false);
assert.equal(failed.phase, 'failed');
assert.deepEqual(failed.loaded, ['good']);
assert.equal(failed.failed.module, 'bad');
assert.equal(bootPayload(failed).failedFeature, 'bad');

console.log('startup_readiness.test ok');
