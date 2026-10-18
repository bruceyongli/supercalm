import assert from 'node:assert/strict';
import { createSessionLiveness, confirmedMissing, sessionHealthError } from '../src/session_liveness.js';

let time = 0, failure = null, output = '_aios_keep\nlive-one\nlive-two\n', count = 0;
const errors = [];
const liveness = createSessionLiveness({ clock: () => time, onError: e => errors.push(e), run: async (...args) => {
  assert.deepEqual(args, ['list-sessions', '-F', '#{session_name}']);
  count++; if (failure) throw failure; return output;
} });
assert.equal(await liveness.probe('live-one'), 'alive');
assert.equal(await liveness.probe('absent'), 'missing');
let before = count;
await Promise.all(Array.from({ length: 20 }, () => liveness.inventory()));
assert.equal(count - before, 1, 'concurrent monitors use one inventory instead of per-session forks');
let releaseOld;
let reads = 0;
const racing = createSessionLiveness({ run: async () => ++reads === 1
  ? new Promise(resolve => { releaseOld = resolve; }) : 'new-pane' });
const oldPoll = racing.inventory();
assert.equal(await racing.probe('new-pane'), 'alive', 'explicit resume does not join an older poll observation');
releaseOld(''); await oldPoll;
for (const code of ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 1, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
  failure = Object.assign(new Error('upstream-secret-must-not-leak'), { code, stderr: 'resource busy' });
  assert.equal(await liveness.probe('live-one'), 'unknown');
}
failure = { code: 1, killed: true, signal: 'SIGKILL', stderr: 'no server running on /tmp/mock' };
assert.equal(await liveness.probe('live-one'), 'unknown', 'timeout cannot masquerade as absent server');
assert.equal(errors.length, 1, 'failure logging is throttled during host-wide outages');
time += 30001; await liveness.inventory(); assert.equal(errors.length, 2);
assert.doesNotMatch(JSON.stringify(errors), /secret|resource busy/);
failure = { code: 1, stderr: 'no server running on /tmp/mock' };
assert.equal(await liveness.probe('live-one'), 'missing', 'explicit absent server is a known observation');
failure = { code: 1, stderr: 'error connecting to /tmp/mock (Connection refused)' };
assert.equal(await liveness.probe('live-one'), 'unknown');
failure = null;
assert.equal(await liveness.probe('live-one'), 'alive');
const entry = { tmux: 'live-one' }, absent = { known: true, names: new Set() };
assert.equal(confirmedMissing(entry, absent, 0), false);
assert.equal(confirmedMissing(entry, absent, 100), false, 'two observations cannot be the same instant');
assert.equal(confirmedMissing(entry, { known: false }, 1500), false, 'unknown breaks the evidence streak');
assert.equal(confirmedMissing(entry, absent, 2000), false);
assert.equal(confirmedMissing(entry, absent, 4000), true);
assert.equal(confirmedMissing(entry, await liveness.inventory(), 5000), false, 'positive evidence clears absence');
assert.equal(confirmedMissing(entry, absent, 6000), false);
entry.tmux = 'replacement'; assert.equal(confirmedMissing(entry, absent, 8000), false, 'replacement cannot inherit absence');
assert.equal(sessionHealthError().status, 503);
console.log('session_liveness: resource failures remain unknown, shared probes, bounded diagnostics, confirmed absence and generation reset PASS');
