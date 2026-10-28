import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'aios-project-release-api-'));
const probe = createServer(); await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port; await new Promise(ok => probe.close(ok));
process.env.AIOS_DATA = join(dir, 'data'); process.env.AIOS_WORKTREE_ROOT = join(dir, 'worktrees');
process.env.AIOS_TMUX = '/usr/bin/false'; process.env.AIOS_HOST = '127.0.0.1'; process.env.AIOS_PORT = String(port);
process.env.AIOS_SUMMARY_PORT = '1'; delete process.env.AIOS_NO_LISTEN;
let store;
async function request(path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
try {
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  const project = join(dir, 'project'); await mkdir(project);
  store.createProject({ id: 'p_release_api', name: 'Release fixture', path: project });
  store.createSession({ id: 's_release_api', project_id: 'p_release_api', tool: 'codex', tmux: 'fixture-release', status: 'exited' });
  const entry = '/api/project/p_release_api/release';
  const context = '/api/session/s_release_api/release-context';
  assert.equal((await request(context)).body.context.auto_release, false);
  assert.equal((await request(entry, { auto_release: true })).status, 400, 'cannot grant unspecified release permission');
  const policy = { auto_release: true, source_dir: project, source_branch: 'release', release_scripts: [{ cwd: '.', script: 'deploy' }] };
  let r = await request(entry, policy);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.target.auto_release, true); assert.deepEqual(r.body.target.release_scripts, policy.release_scripts);
  r = await request(context);
  assert.equal(r.body.context.project_id, 'p_release_api'); assert.equal(r.body.context.auto_release, true);
  assert.equal(r.body.context.self_deploy, false); assert.equal(r.body.context.source_dir, project);
  assert.equal(r.body.context.lock_dir, join(process.env.AIOS_DATA, 'project-release-locks'));
  assert.equal((await request(entry, { source_branch: '' })).status, 400, 'partial config cannot overwrite permission');
  assert.equal((await request(entry, { release_scripts: [{ cwd: '../escape', script: 'deploy' }] })).status, 400);
  r = await request('/api/session/s_release_api/integrate', {});
  assert.equal(r.body.code, 'unsupported_target'); assert.match(r.body.error, /release-context/);
  await request(entry, { auto_release: false });
  assert.equal((await request(context)).body.context.auto_release, false, 'live revocation, no session relaunch');
  console.log(JSON.stringify({ handlers: ['project release contract', 'session release-context', 'integration refusal'], permission: 'live and scoped', validation: 'fail closed', productionTouched: false }));
} finally { store?.db.close(); await rm(dir, { recursive: true, force: true }); }
process.exit(0);
