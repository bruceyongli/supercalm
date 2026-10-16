import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'aios-session-resources-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
process.env.AIOS_DATA = join(dir, 'data'); process.env.AIOS_WORKTREE_ROOT = join(dir, 'worktrees');
process.env.AIOS_TMUX = '/usr/bin/false'; process.env.AIOS_HOST = '127.0.0.1'; process.env.AIOS_PORT = String(port);
process.env.AIOS_SUMMARY_PORT = '1'; delete process.env.AIOS_NO_LISTEN;
const get = async path => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
};
let store;
try {
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  const project = join(dir, 'project'); await mkdir(project);
  await writeFile(join(project, 'shared-source'), Buffer.alloc(1024 * 1024, 42));
  store.createProject({ id: 'p_resources', name: 'Resources fixture', path: project });
  store.createSession({ id: 's_resources', project_id: 'p_resources', tool: 'codex', tmux: 'fixture-resources', status: 'exited' });
  store.updateSession('s_resources', { worktree_path: project, status_reason: 'operator-kill' });
  await writeFile(join(process.env.AIOS_DATA, 'logs', 's_resources.log'), 'Owned terminal output');
  const endpoint = '/api/product/resources/sessions';
  assert.equal((await get(`${endpoint}?ids=bad`)).status, 400);
  assert.equal((await get(`${endpoint}?ids=${Array.from({ length: 81 }, (_, i) => `s_${i}`).join(',')}`)).status, 400);
  assert.deepEqual((await get(endpoint)).body.sessions, []);
  const path = `${endpoint}?ids=s_resources,s_resources,s_missing`;
  let result = await get(path);
  assert.equal(result.status, 200); assert.equal(result.body.sessions.length, 1, 'deduplicate IDs and omit missing sessions');
  assert.equal(result.body.sessions[0].disk_bytes, null, 'first response returns immediately, without waiting on du');
  assert.equal(result.body.sessions[0].disk_pending, true);
  const deadline = Date.now() + 20_000;
  while (result.body.sessions[0].disk_pending && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100)); result = await get(path);
  }
  const row = result.body.sessions[0];
  assert.equal(row.disk_pending, false); assert.equal(row.disk_error, null);
  assert.ok(row.disk_bytes > 0 && row.disk_bytes < 1024 * 1024, 'owned log counted; shared project source excluded');
  assert.ok(row.disk_checked_at > 0);
  assert.doesNotMatch(JSON.stringify(result.body), /shared-source|fixture-resources|processes|command|project_id|worktree_path/);
  assert.equal((await get(path)).body.sessions[0].disk_checked_at, row.disk_checked_at, 'poll reuses disk cache');
  const health = await get('/api/product/resources');
  assert.equal(health.status, 200); assert.ok(Number.isFinite(health.body.capacity.available_bytes));
  assert.ok(Array.isArray(health.body.session_disk));
  console.log(JSON.stringify({ handler: 'real resources/sessions HTTP route', validation: '400', batch: 'deduplicated',
    firstResponse: 'nonblocking', disk: 'measured and cached', sharedSource: 'excluded', healthCapacity: 'available', liveDataTouched: false }));
} finally {
  store?.db.close(); await rm(dir, { recursive: true, force: true });
}
process.exit(0);
