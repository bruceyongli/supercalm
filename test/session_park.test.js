import assert from 'node:assert/strict';

const { parkVerdict, PARK_AFTER_MS } = await import('../src/park.js');

const H = 60 * 60_000;

// live sessions park only past the threshold; exited/starting never park
assert.deepEqual(parkVerdict({ status: 'waiting', parked: false, idleMs: PARK_AFTER_MS - 1 }), { park: false, unpark: false });
assert.deepEqual(parkVerdict({ status: 'waiting', parked: false, idleMs: PARK_AFTER_MS + 1 }), { park: true, unpark: false });
assert.deepEqual(parkVerdict({ status: 'working', parked: false, idleMs: 26 * H }), { park: true, unpark: false }, 'a byte-frozen "working" pane parks too (the ×295 class)');
assert.equal(parkVerdict({ status: 'exited', parked: false, idleMs: 90 * H }).park, false);
assert.equal(parkVerdict({ status: 'starting', parked: false, idleMs: 90 * H }).park, false);

// movement un-parks instantly; stillness keeps it parked without re-parking
assert.deepEqual(parkVerdict({ status: 'waiting', parked: true, idleMs: 5_000 }), { park: false, unpark: true }, 'any pane movement wakes a parked session');
assert.deepEqual(parkVerdict({ status: 'waiting', parked: true, idleMs: PARK_AFTER_MS + H }), { park: false, unpark: false }, 'still-frozen stays parked, no re-park churn');
assert.deepEqual(parkVerdict({ status: 'exited', parked: true, idleMs: 90 * H }), { park: false, unpark: true }, 'exited sessions shed the flag');

// threshold is configurable per call (env is the production knob)
assert.equal(parkVerdict({ status: 'waiting', parked: false, idleMs: 10 }, { parkAfterMs: 5 }).park, true);

console.log('session_park: all assertions passed');
