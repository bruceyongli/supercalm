import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'aios-session-storage-'));
process.env.AIOS_DATA = join(fixture, 'data');

const storage = await import('../src/session_storage.js');
const {
  cleanupSessionStorage,
  prepareSessionStorage,
  sessionStorageEnv,
  sessionStoragePaths,
  sweepSessionStorage,
} = storage;

// The exec-level seatbelt wrapper must STAY deleted: macOS seatbelt does not nest, so wrapping a
// tool that applies its own profile (codex workspace-write) kills every command it runs, and the
// home-root create-deny broke claude's own config writes (2026-08-11 fleet outage).
assert.equal(storage.guardAgentArgv, undefined, 'no exec-wrapper export may return');
assert.equal(storage.homeCreationGuardProfile, undefined, 'no seatbelt profile builder may return');

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
  assert.match(env.AIOS_BUILD_RUN, /\/bin\/build-run\.mjs$/);

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

  // A missing migrated parent must fail before recursive mkdir can recreate it
  // locally, even if the user is opening a brand-new session after a reboot.
  const parent = join(process.env.AIOS_DATA, 'session-storage'), mount = join(fixture, 'mounts', 'remote');
  await rm(parent, { recursive: true });
  await writeFile(join(process.env.AIOS_DATA, 'live-storage.json'), JSON.stringify({ version: 1, id: 'fixture-only', mount,
    mappings: [{ source: parent, target: join(mount, 'scratch'), active: true }] }));
  await assert.rejects(prepareSessionStorage('s_offline'), e => e.code === 'storage-unavailable');
  await assert.rejects(lstat(parent), { code: 'ENOENT' });
  await assert.rejects(lstat(sessionStoragePaths('s_offline').artifacts), { code: 'ENOENT' });
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('session_storage.test ok');
