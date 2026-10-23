import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'aios-storage-freeze-'));
process.env.AIOS_DATA = join(root, 'data'); process.env.AIOS_NO_LISTEN = '1';
const heartbeat = join(root, 'heartbeat');
const mock = join(root, 'tmux-fixture.mjs');
process.env.AIOS_TMUX = mock;
await mkdir(join(root, 'project'));
const agent = spawn(process.execPath, ['-e', `const fs=require('node:fs');let n=0;setInterval(()=>fs.writeFileSync(process.argv[1],String(++n)),25);`, heartbeat], { stdio: 'ignore' });
let store;
try {
  await writeFile(mock, `#!/usr/bin/env node\nif(process.argv[2]==='list-panes')console.log('fixture-storage|${agent.pid}');else if(process.argv[2]==='capture-pane')console.log('unsent terminal draft');\n`);
  await chmod(mock, 0o755);
  store = await import('../src/store.js');
  store.createProject({ id: 'p_freeze', name: 'Freeze fixture', path: join(root, 'project') });
  store.createSession({ id: 's_freeze', project_id: 'p_freeze', tool: 'codex', tmux: 'fixture-storage', status: 'waiting' });
  store.updateSession('s_freeze', { desired_status: 'waiting', last_activity: 1234 });
  const before = store.getSession('s_freeze');
  const run = action => exec(process.execPath, ['bin/storage-maintenance.mjs', action, ...(action === 'freeze' ? ['s_freeze'] : [])],
    { env: process.env, timeout: 25_000 });
  await run('freeze');
  const value = await readFile(heartbeat, 'utf8');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await readFile(heartbeat, 'utf8'), value, 'actual process is frozen');
  const journal = JSON.parse(await readFile(join(process.env.AIOS_DATA, 'storage-maintenance.json'), 'utf8'));
  assert.equal(journal.phase, 'frozen');
  assert.deepEqual(journal.processes.map(p => p.pid), [agent.pid], 'only the selected fixture process');
  assert.match(await readFile(journal.sessions[0].screenBackup, 'utf8'), /unsent terminal draft/);
  await run('thaw');
  await new Promise(r => setTimeout(r, 100));
  assert.notEqual(await readFile(heartbeat, 'utf8'), value, 'same process continues');
  assert.deepEqual(store.getSession('s_freeze'), before, 'no state or attention/activity clock writes');
  console.log('storage freeze: real SIGSTOP/SIGCONT, exact PID scope, draft snapshot, unchanged session row');
} finally {
  try { agent.kill('SIGCONT'); agent.kill('SIGTERM'); } catch {}
  await new Promise(resolve => agent.exitCode !== null ? resolve() : agent.once('exit', resolve));
  store?.db.close(); await rm(root, { recursive: true, force: true });
}
