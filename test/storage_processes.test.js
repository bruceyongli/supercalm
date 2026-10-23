import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
if (process.platform !== 'darwin') { console.log('storage process checkpoint: macOS-only fixture skipped'); process.exit(0); }
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-process-checkpoint-')));
const source = join(root, 'project'), data = join(root, 'data'), configFile = join(root, 'config.json');
const helper = fileURLToPath(new URL('../bin/storage-processes.mjs', import.meta.url));
let child, resumedPid;
try {
  await mkdir(source); await mkdir(data);
  await writeFile(configFile, JSON.stringify({ version: 1, id: 'checkpoint-fixture', mount: join(root, 'mounts', 'spark'),
    journalRoot: join(root, 'control', 'migrations'), mappings: [{ source, target: join(root, 'mounts', 'spark', 'project') }] }));
  const env = { ...process.env, AIOS_DATA: data, AIOS_LIVE_STORAGE_CONFIG: configFile, AIOS_CHECKPOINT_FIXTURE: 'spaced value = remains exact' };
  child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: source, env, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 300));
  const result = await exec(process.execPath, [helper, 'park', String(child.pid)], { env, timeout: 30_000 });
  const file = join(root, 'control', 'private-process-checkpoints', child.pid + '.json');
  const saved = JSON.parse(await readFile(file));
  assert.equal(saved.env.AIOS_CHECKPOINT_FIXTURE, env.AIOS_CHECKPOINT_FIXTURE);
  assert.equal(saved.cwd, source); assert.equal(saved.phase, 'parked');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes(env.AIOS_CHECKPOINT_FIXTURE));
  const resumed = await exec(process.execPath, [helper, 'resume', String(child.pid)], { env, timeout: 30_000 });
  resumedPid = JSON.parse(resumed.stdout).pid;
  process.kill(resumedPid, 0);
  assert.equal(JSON.parse(await readFile(file)).phase, 'resumed');
  await assert.rejects(exec(process.execPath, [helper, 'resume', String(child.pid)], { env, timeout: 30_000 }), /parked checkpoint/);
  console.log('storage process checkpoint: exact argv/env/cwd, private journal, graceful stop/restart passed');
} finally {
  if (resumedPid) try { process.kill(resumedPid, 'SIGTERM'); } catch {}
  if (child) try { child.kill('SIGTERM'); } catch {}
  await rm(root, { recursive: true, force: true });
}
