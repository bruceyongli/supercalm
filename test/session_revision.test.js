import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-session-revision-'));
const store = await import('../src/store.js');
const { projectSession, sessionStatusPayload } = await import('../src/session_projection.js');

const first = projectSession(store.createSession({
  id: 's_revision',
  project_id: null,
  tool: 'codex',
  tmux: 'tmux-revision',
  status: 'starting',
}));
assert.equal(first.revision, 1);
const second = projectSession(store.updateSession('s_revision', { status: 'working' }));
assert.equal(second.revision, 2);
assert.equal(store.updateSession('s_revision', { summary: 'progress' }).revision, 3);
const event = sessionStatusPayload(second, { previousStatus: 'starting', source: 'test', ts: 42 });
assert.equal(event.revision, 2);
assert.equal(event.status, 'working');
assert.equal(event.previousStatus, 'starting');
assert.equal(event.ts, 42);

console.log('session_revision.test ok');
