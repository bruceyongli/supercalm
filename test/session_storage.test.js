import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'aios-session-storage-'));
process.env.AIOS_DATA = join(fixture, 'data');

const {
  cleanupSessionStorage,
  guardAgentArgv,
  homeCreationGuardProfile,
  prepareSessionStorage,
  sessionStorageEnv,
  sessionStoragePaths,
  sweepSessionStorage,
} = await import('../src/session_storage.js');

try {
  const prepared = await prepareSessionStorage('s_keep');
  assert.equal(existsSync(prepared.tmp), true);
  assert.equal(existsSync(prepared.artifacts), true);
  const env = sessionStorageEnv('s_keep');
  assert.equal(env.AIOS_SESSION_TMPDIR, prepared.tmp);
  assert.equal(env.AIOS_SESSION_ARTIFACTS, prepared.artifacts);
  assert.equal(env.TMP, prepared.tmp);
  assert.equal(env.TEMP, prepared.tmp);
  assert.equal(env.TMPDIR, prepared.tmp + '/');

  await writeFile(join(prepared.tmp, 'throwaway.txt'), 'temporary');
  await writeFile(join(prepared.artifacts, 'reported.txt'), 'durable evidence');
  const orphan = await prepareSessionStorage('s_orphan');
  const swept = await sweepSessionStorage(['s_keep']);
  assert.deepEqual(swept, ['s_orphan']);
  assert.equal(existsSync(sessionStoragePaths('s_keep').root), true, 'live session scratch is retained');
  assert.equal(existsSync(sessionStoragePaths('s_orphan').root), false, 'orphan scratch is removed');
  assert.equal(existsSync(orphan.artifacts), false, 'empty orphan artifact directories do not accumulate');

  await cleanupSessionStorage('s_keep');
  assert.equal(existsSync(prepared.root), false);
  assert.equal(existsSync(prepared.artifacts), true, 'reported artifacts survive disposable scratch cleanup');
  await assert.rejects(() => prepareSessionStorage('../escape'), /invalid session id/);

  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const fakeHome = join(fixture, 'home');
    const existing = join(fakeHome, 'existing-project');
    await mkdir(existing, { recursive: true });
    const direct = join(fakeHome, 'qa-pollution.png');
    const nested = join(existing, 'allowed.txt');
    const probe = spawnSync('/usr/bin/sandbox-exec', [
      '-p', homeCreationGuardProfile(fakeHome),
      process.execPath,
      '-e',
      `const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(direct)},'blocked')}catch{};fs.writeFileSync(${JSON.stringify(nested)},'allowed')`,
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(existsSync(direct), false, 'agent cannot create a new direct child in home');
    assert.equal(existsSync(nested), true, 'agent can still write inside an existing assigned project');
    assert.deepEqual(
      guardAgentArgv(['codex', '--version'], { platform: 'darwin', executable: '/usr/bin/sandbox-exec', home: fakeHome }).slice(0, 2),
      ['/usr/bin/sandbox-exec', '-p'],
    );
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('session_storage.test ok');
