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
assert.equal(first.desired_status, 'starting');
assert.equal(first.runtime_status, 'starting');
assert.ok(first.runtime_boot_id);
const second = projectSession(store.updateSession('s_revision', { status: 'working' }));
assert.equal(second.revision, 2);
assert.equal(second.desired_status, 'working');
assert.equal(second.runtime_status, 'running');
assert.equal(store.updateSession('s_revision', { summary: 'progress' }).revision, 3);
const event = sessionStatusPayload(second, { previousStatus: 'starting', source: 'test', ts: 42 });
assert.equal(event.revision, 2);
assert.equal(event.status, 'working');
assert.equal(event.previousStatus, 'starting');
assert.equal(event.ts, 42);
assert.equal(event.desired_status, 'working');
assert.equal(event.runtime_status, 'running');

const beforeHeartbeatRevision = store.getSession('s_revision').revision;
assert.equal(store.touchSessionRuntime('s_revision', 'test-boot', 99), true);
assert.equal(store.getSession('s_revision').runtime_boot_id, 'test-boot');
assert.equal(store.getSession('s_revision').runtime_heartbeat_at, 99);
assert.equal(store.getSession('s_revision').revision, beforeHeartbeatRevision, 'heartbeats do not churn public revisions');

const unexpectedlyExited = store.updateSession('s_revision', {
  status: 'exited',
  status_reason: 'unexpected-exit',
});
assert.equal(unexpectedlyExited.status, 'exited');
assert.equal(unexpectedlyExited.desired_status, 'working', 'a process observation cannot erase running intent');
assert.equal(unexpectedlyExited.runtime_status, 'exited');
const deliberatelyStopped = store.updateSession('s_revision', {
  desired_status: 'exited',
  status_reason: 'operator-stop',
});
assert.equal(deliberatelyStopped.desired_status, 'exited');
assert.equal(deliberatelyStopped.status_reason, 'operator-stop');

console.log('session_revision.test ok');
