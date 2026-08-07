import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const port = await freePort();
const data = await mkdtemp(join(tmpdir(), 'aios-server-boot-'));
const projectRoot = await mkdtemp(join(tmpdir(), 'aios-server-projects-'));
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('../', import.meta.url),
  env: {
    ...process.env,
    AIOS_DATA: data,
    AIOS_PORT: String(port),
    AIOS_HOST: '127.0.0.1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const base = `http://127.0.0.1:${port}`;

async function waitForReady() {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try {
      const live = await fetch(base + '/healthz');
      if (live.ok) {
        const body = await live.json();
        assert.equal(body.ok, true);
        assert.equal(typeof body.ready, 'boolean');
        const ready = await fetch(base + '/readyz');
        if (ready.ok) return ready.json();
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready: ' + stderr.slice(-1000));
}

try {
  const ready = await waitForReady();
  assert.equal(ready.ready, true);
  assert.equal(ready.phase, 'ready');
  assert(ready.loadedFeatures > 20);
  for (const path of ['/usage.html', '/records.html', '/session.html?id=s_bookmark']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /<script type="module" src="router\.js"><\/script>/, `${path} serves the canonical SPA shell`);
  }
  await fetch(base + '/api/version');
  const performance = await fetch(base + '/api/performance').then((response) => response.json());
  assert(performance.routes.some((row) => row.route === 'GET /api/version' && row.requests >= 1));
  assert(performance.routes.some((row) => row.route === 'GET static' && row.requests >= 3));

  const newProjectPath = join(projectRoot, 'created-by-api');
  const createdResponse = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Created by API', path: newProjectPath }),
  });
  assert.equal(createdResponse.status, 201);
  const createdProject = await createdResponse.json();
  assert.equal(createdProject.path, newProjectPath);
  assert.equal(createdProject.createdDirectory, true);
  assert.equal(createdProject.initializedGit, true);
  assert.equal((await stat(join(newProjectPath, '.git'))).isDirectory(), true,
    'POST /api/projects creates a missing folder and initializes Git before persisting it');
  const projects = await fetch(base + '/api/projects').then((response) => response.json());
  assert(projects.some((project) => project.id === createdProject.id && project.path === newProjectPath));
  const deletedResponse = await fetch(base + `/api/projects/${createdProject.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delete_folder: true, confirm_path: newProjectPath }),
  });
  assert.equal(deletedResponse.status, 200);
  const deletedProject = await deletedResponse.json();
  assert.equal(deletedProject.folderDeleted, true);
  await assert.rejects(stat(newProjectPath), (error) => error?.code === 'ENOENT',
    'DELETE /api/projects/:id removes the exact project folder only after explicit path confirmation');

  const db = new DatabaseSync(join(data, 'aios.db'), { readOnly: true });
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id));
  db.close();
  for (const id of [
    '0001_sessions_complete_shape',
    '0002_message_read_state',
    '0003_attention_dismissals',
    '0004_project_lifecycle',
    '0100_project_helpers_complete_shape',
    '0101_session_labels_semantic_grouping',
    '0102_session_label_preferences',
    '0103_supervisor_decision_task_identity',
    '0104_project_memory_task_provenance',
    '0105_supervisor_doctrine_enforcement',
    '0106_council_thread_complete_shape',
    '0107_supervisor_review_complete_shape',
    '0108_project_memory_standard_usage',
    '0109_unpin_rollout_inspector',
  ]) {
    assert(applied.has(id), `startup applies and records ${id}`);
  }
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
  await rm(projectRoot, { recursive: true, force: true });
}

console.log('server_boot_http.test ok');
