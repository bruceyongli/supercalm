import assert from 'node:assert/strict';
import { isStaleSessionPatch, mergeSessionPatch, mergeSessionSnapshot } from '../web/session-state.js';

const working = { id: 's1', status: 'working', revision: 4, title: 'new' };
const stale = { id: 's1', status: 'starting', revision: 3, title: 'old' };
assert.equal(isStaleSessionPatch(working, stale), true);
assert.equal(mergeSessionPatch(working, stale), working, 'a delayed response cannot roll state backward');

const newer = mergeSessionPatch(working, { id: 's1', status: 'waiting', revision: 5 });
assert.equal(newer.status, 'waiting');
assert.equal(newer.revision, 5);
assert.equal(newer.title, 'new');

const scoped = mergeSessionPatch(newer, { id: 's1', unread: 0 });
assert.equal(scoped.status, 'waiting', 'unversioned scoped metadata remains compatible');
assert.equal(scoped.revision, 5);
assert.equal(scoped.unread, 0);

const snapshot = mergeSessionSnapshot(
  [
    { id: 's1', status: 'waiting', revision: 8, title: 'stream won' },
    { id: 's2', status: 'starting', revision: 1 },
  ],
  [
    { id: 's1', status: 'working', revision: 7, title: 'stale snapshot' },
  ],
  new Set(['s2']),
);
assert.deepEqual(snapshot, [
  { id: 's1', status: 'waiting', revision: 8, title: 'stream won' },
  { id: 's2', status: 'starting', revision: 1 },
], 'an in-flight snapshot cannot overwrite or remove rows changed by the stream after its request began');

const equalRevisionMetadata = mergeSessionSnapshot(
  [{ id: 's1', status: 'waiting', revision: 8, unread: 0 }],
  [{ id: 's1', status: 'waiting', revision: 8, unread: 1 }],
  new Set(['s1']),
);
assert.equal(equalRevisionMetadata[0].unread, 0,
  'a same-revision snapshot cannot roll back independent metadata changed after the request began');

const laterSnapshot = mergeSessionSnapshot(snapshot, [
  { id: 's1', status: 'exited', revision: 9, title: 'authoritative snapshot' },
]);
assert.deepEqual(laterSnapshot, [
  { id: 's1', status: 'exited', revision: 9, title: 'authoritative snapshot' },
], 'a later authoritative snapshot can update rows and remove rows not changed during its request');

console.log('session_state_browser_contract.test ok');
