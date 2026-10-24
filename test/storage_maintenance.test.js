import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
const root = await mkdtemp(join(tmpdir(), 'aios-storage-maintenance-'));
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
process.env.AIOS_DATA = join(root, 'data'); process.env.AIOS_WORKTREE_ROOT = join(root, 'worktrees');
process.env.AIOS_TMUX = '/usr/bin/true'; process.env.AIOS_HOST = '127.0.0.1'; process.env.AIOS_PORT = String(port);
process.env.AIOS_CODEX_SESSIONS_DIR = join(root, 'native-history');
process.env.AIOS_SUMMARY_PORT = '1'; delete process.env.AIOS_NO_LISTEN;
process.env.AIOS_RESUME_INPUT_READY_MS = '1';
let store;
try {
  const { featureReady } = await import('../src/server.js'); await featureReady;
  store = await import('../src/store.js');
  const api = await import('../src/sessions.js');
  const m = await import('../src/storage_maintenance.js');
  const path = join(root, 'project'); await mkdir(path);
  const project = store.createProject({ id: 'p_maintenance', name: 'Storage fixture', path });
  store.createSession({ id: 's_maintenance', project_id: project.id, tool: 'codex', tmux: 'fixture-maintenance', status: 'waiting' });
  store.updateSession('s_maintenance', { last_activity: 1234, desired_status: 'waiting', question: 'Original question' });
  const before = store.getSession('s_maintenance');
  const job = { version: 1, kind: 'live-storage-migration', phase: 'frozen', blockLaunches: true,
    sessions: [{ id: before.id, tmux: before.tmux, token: 'fixture', phase: 'frozen' }] };
  await writeFile(m.storageMaintenanceFile, JSON.stringify(job));
  assert.equal(m.storageMaintenanceFor(before.id).token, 'fixture');
  const blocked = error => error.code === 'storage-maintenance' && error.status === 503;
  await assert.rejects(api.sendText(before.tmux, 'must not be delivered'), blocked);
  await assert.rejects(api.sendRaw(before.tmux, 'x'), blocked);
  await assert.rejects(api.sendKey(before.tmux, 'Enter'), blocked);
  await assert.rejects(api.resume(before.id), blocked);
  assert.throws(() => api.queueLaunch({ project, tool: 'codex', task: 'must not launch' }), blocked);
  api.noteAgentStatus(before.id, 'working');
  assert.equal(store.getSession(before.id).last_activity, before.last_activity);
  assert.equal(store.getSession(before.id).status, 'waiting');
  const post = async (path, data, token = null) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-aios-maintenance-token': token } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const result = await post('/api/hook/codex', { session_id: before.id, event: 'agent-turn-complete' });
  assert.equal(result.status, 200); assert.equal(result.body.ignored, 'storage-maintenance');
  const settings = await post(`/api/session/${before.id}/settings`, { effort: 'high' });
  assert.equal(settings.status, 503);
  assert.equal(store.getSession(before.id).last_activity, before.last_activity);
  assert.equal((await post(`/api/session/${before.id}/storage-pause`, {})).status, 403);
  assert.equal((await post(`/api/session/${before.id}/storage-pause`, {}, 'fixture')).status, 409, 'missing native identity cannot stop an agent');
  const native = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await mkdir(process.env.AIOS_CODEX_SESSIONS_DIR);
  await writeFile(join(process.env.AIOS_CODEX_SESSIONS_DIR, `rollout-fixture-${native}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: native, cwd: path } }) + '\n');
  job.sessions[0].codex_uuid = native; await writeFile(m.storageMaintenanceFile, JSON.stringify(job));
  const paused = await post(`/api/session/${before.id}/storage-pause`, {}, 'fixture');
  assert.equal(paused.status, 200, JSON.stringify(paused));
  assert.equal(store.getSession(before.id).codex_uuid, native);
  assert.equal(store.getSession(before.id).last_activity, before.last_activity);
  job.sessions[0].phase = 'parked'; await writeFile(m.storageMaintenanceFile, JSON.stringify(job));
  const resumed = await post(`/api/session/${before.id}/storage-resume`, {}, 'fixture');
  assert.equal(resumed.status, 200, JSON.stringify(resumed));
  assert.equal(resumed.body.input_ready, false, 'an empty terminal cannot complete maintenance recovery');
  assert.equal(store.getSession(before.id).last_activity, before.last_activity);
  assert.equal(store.getSession(before.id).question, before.question);
  assert.match(await readFile(join(process.env.AIOS_DATA, 'launch', before.id + '.sh'), 'utf8'), new RegExp('resume[\\s\\S]*' + native));

  // A real isolated worktree switched branches before maintenance. Only its
  // nonce-bound pre-freeze checkpoint permits this branch-only birth-record drift.
  const repo = join(root, 'git-project'); await mkdir(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'source'), 'source'); git(['add', '.']); git(['commit', '-qm', 'initial']);
  const gitProject = store.createProject({ id: 'p_branch_checkpoint', name: 'Branch fixture', path: repo });
  const { ensureWorktree } = await import('../src/worktrees.js');
  const { writeManifest } = await import('../src/launch_contract.js');
  const sid = 's_branch_checkpoint', uuid = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
  const worktree = await ensureWorktree({ repoPath: repo, sid, project: gitProject });
  store.createSession({ id: sid, project_id: gitProject.id, tool: 'codex', tmux: 'fixture-branch', status: 'waiting' });
  store.updateSession(sid, { desired_status: 'waiting', worktree_path: worktree.path, branch: worktree.branch, codex_uuid: uuid, last_activity: 1234 });
  await writeFile(join(process.env.AIOS_CODEX_SESSIONS_DIR, `rollout-fixture-${uuid}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: worktree.path } }) + '\n');
  await writeManifest(sid, { tool: 'codex', worktree_path: worktree.path, cwd: worktree.path, project_path: repo, branch: worktree.branch });
  execFileSync('git', ['-C', worktree.path, 'switch', '-qc', 'design/site-refresh-dark']);
  const checkpointEntry = { id: sid, token: 'branch-job-nonce', phase: 'parked', tool: 'codex', codex_uuid: uuid,
    tmux: 'fixture-branch', worktree_path: worktree.path, project_path: repo };
  job.sessions.push(checkpointEntry); await writeFile(m.storageMaintenanceFile, JSON.stringify(job));
  const refused = await post(`/api/session/${sid}/storage-resume`, {}, checkpointEntry.token);
  assert.equal(refused.status, 409); assert.match(refused.body.error, /launch-contract mismatch/);
  checkpointEntry.branchCheckpoint = m.createStorageBranchCheckpoint(checkpointEntry, 'design/site-refresh-dark');
  await writeFile(m.storageMaintenanceFile, JSON.stringify(job));
  const kept = await post(`/api/session/${sid}/storage-resume`, {}, checkpointEntry.token);
  assert.equal(kept.status, 200, JSON.stringify(kept));
  assert.equal(store.getSession(sid).codex_uuid, uuid); assert.equal(store.getSession(sid).last_activity, 1234);
  assert.equal(execFileSync('git', ['-C', worktree.path, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'design/site-refresh-dark');
  assert.match(await readFile(join(process.env.AIOS_DATA, 'launch', sid + '.sh'), 'utf8'), new RegExp('resume[\\s\\S]*' + uuid));
  // Explicit operator Kill is never fenced by migration and takes precedence over recovery.
  await api.killSession(before.id);
  assert.equal(store.getSession(before.id).desired_status, 'exited');
  assert.equal(store.getSession(before.id).status_reason, 'operator-kill');
  job.phase = 'complete'; await writeFile(m.storageMaintenanceFile, JSON.stringify(job));
  assert.equal(m.storageMaintenanceFor(before.id), null);
  console.log('storage maintenance: real handlers fence input/launch/settings/hooks; clocks/history preserved; operator Kill wins');
} finally {
  store?.db.close(); await rm(root, { recursive: true, force: true });
}
process.exit(0);
