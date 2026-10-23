import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'aios-live-storage-')));
process.env.AIOS_DATA = join(fixture, 'data');
const { validateLiveStorage, expectedStoragePath, isManagedStoragePath, assertLiveStorage, liveStorageConfig,
  liveStorageStatus, storageMigrationProtected } = await import('../src/live_storage.js');
const mount = join(fixture, 'mounts', 'spark'), source = join(fixture, 'data', 'session-artifacts');
const target = join(mount, 'bb1', 'artifacts'), statusFile = join(fixture, 'connection.json');
const config = { version: 1, id: 'fixture-only', mount, statusFile, mappings: [{ source, target }] };
try {
  await mkdir(source, { recursive: true }); await mkdir(target, { recursive: true });
  assert.equal(liveStorageConfig(), null);
  assert.equal(liveStorageStatus(null), null);
  assert.equal(validateLiveStorage(config), config);
  assert.equal(storageMigrationProtected(source, config), false);
  assert.equal(storageMigrationProtected(join(source, 's_test'), { ...config, retainDuringMigration: true }), true);
  assert.equal(storageMigrationProtected(join(fixture, 'unrelated'), { ...config, retainDuringMigration: true }), false);
  for (const bad of [homedir(), '/', join(fixture, 'data'), join(fixture, 'proxy'), join(fixture, 'data', 'aios.db')]) {
    assert.throws(() => validateLiveStorage({ ...config, mappings: [{ source: bad, target }] }), /Unsafe/);
  }
  assert.throws(() => validateLiveStorage({ ...config, mappings: [config.mappings[0], config.mappings[0]] }), /Duplicate/);
  assert.throws(() => validateLiveStorage({ ...config, mappings: [{ source, target: join(fixture, 'elsewhere') }] }), /Unsafe/);
  assert.equal(expectedStoragePath(join(source, 's_test'), config), join(source, 's_test'), 'a copy plan does not relocate a live source');
  await assertLiveStorage(source, config);
  assert.equal(await isManagedStoragePath(source, { config }), true);
  const moved = { ...config, mappings: [{ source, target, active: true }] };
  assert.throws(() => expectedStoragePath(source, moved), e => e.code === 'storage-unavailable', 'active mapping cannot silently revert to a physical local folder');
  await rm(source, { recursive: true });
  assert.throws(() => expectedStoragePath(source, moved), e => e.code === 'storage-unavailable', 'missing registered links fail closed');
  await symlink(target, source);
  assert.equal(expectedStoragePath(join(source, 's_test'), config), join(target, 's_test'));
  assert.equal(await isManagedStoragePath(source, { config }), true);
  assert.equal(await isManagedStoragePath(join(source, 's_new', 'out.txt'), { config, allowMissing: true }), true);
  const outside = join(fixture, 'elsewhere'); await mkdir(outside);
  await symlink(outside, join(target, 'escape'));
  assert.equal(await isManagedStoragePath(join(source, 'escape'), { config }), false, 'registered root does not authorize nested escapes');
  assert.equal(await isManagedStoragePath(join(source, 'escape', 'missing'), { config, allowMissing: true }), false);
  await assert.rejects(assertLiveStorage(source, moved), e => e.code === 'storage-unavailable');
  await writeFile(join(mount, '.aios-storage-id'), config.id);
  const now = Date.now();
  await writeFile(statusFile, JSON.stringify({ id: config.id, checkedAt: now, available: true,
    volume: { available_bytes: 100 }, backing: { available_bytes: 200 } }));
  assert.equal(liveStorageStatus(moved, now).available, true);
  assert.equal(liveStorageStatus(moved, now).migrated_roots, 1);
  assert.equal(liveStorageStatus(moved, now + 60_001).available, false);
  assert.equal(liveStorageStatus(moved, now - 1).available, false);
  await assert.rejects(assertLiveStorage(source, moved), e => e.code === 'storage-unavailable', 'a marker on the local filesystem is not a mounted volume');
  await writeFile(statusFile, JSON.stringify({ id: 'other-volume', checkedAt: now, available: true }));
  assert.equal(liveStorageStatus(moved, now).available, false);
  await writeFile(join(fixture, 'machine-config.json'), JSON.stringify(config));
  await writeFile(join(fixture, 'data', 'live-storage.json'), JSON.stringify({ configFile: join(fixture, 'machine-config.json') }));
  assert.equal(liveStorageConfig().id, config.id);
  await writeFile(join(fixture, 'machine-config.json'), JSON.stringify({ ...config, retainDuringMigration: true }));
  await mkdir(join(target, 's_keep'));
  await writeFile(join(target, 's_keep', 'evidence.txt'), 'must survive a service restart');
  const { cleanupSessionStorage } = await import('../src/session_storage.js');
  assert.deepEqual(await cleanupSessionStorage('s_keep'), { removed: false, reason: 'storage-migration' });
  assert.equal(await readFile(join(target, 's_keep', 'evidence.txt'), 'utf8'), 'must survive a service restart');
  await unlink(source); await symlink(outside, source);
  assert.throws(() => expectedStoragePath(source, moved), e => e.code === 'storage-unavailable');
} finally { await rm(fixture, { recursive: true, force: true }); }
console.log('live_storage.test passed: explicit mapping, missing mount, stale connection and escape guards');
