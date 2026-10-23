import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-storage-provision-')));
process.env.AIOS_DATA = join(root, 'data');
const { provisionLiveStorageRoot, withStorageConfigLock } = await import('../src/storage_provision.js');
const { durableJson } = await import('../src/storage_migration.js');
const { assertDiskHeadroom } = await import('../src/disk_pressure.js');
const { validateLiveStorage } = await import('../src/live_storage.js');
const parent = join(root, 'projects'), mount = join(root, 'mounts', 'spark');
const configFile = join(root, 'config.json'), targetParent = join(mount, 'bb1', 'projects');
const config = { version: 1, id: 'provision-fixture', mount, journalRoot: join(root, 'control'),
  statusFile: join(root, 'status.json'), mappings: [], newRoots: [{ kind: 'project', sourceParent: parent, targetParent, exclude: ['runtime'] }] };
const options = { configFile, checkMounted: async () => {} };
try {
  await mkdir(parent); await mkdir(targetParent, { recursive: true }); await mkdir(process.env.AIOS_DATA);
  await durableJson(configFile, config);
  const source = join(parent, 'new-project');
  assert.equal(await provisionLiveStorageRoot(source, 'project', options), true);
  assert.equal((await lstat(source)).isSymbolicLink(), true);
  assert.equal(await realpath(source), join(targetParent, 'new-project'));
  await writeFile(join(source, 'evidence.txt'), 'new writes live remotely');
  assert.equal(await readFile(join(targetParent, 'new-project', 'evidence.txt'), 'utf8'), 'new writes live remotely');
  assert.equal(await provisionLiveStorageRoot(source, 'project', options), false);
  assert.equal(await provisionLiveStorageRoot(join(parent, 'proxy'), 'project', options), false);
  assert.equal(await provisionLiveStorageRoot(join(parent, 'runtime'), 'project', options), false);
  assert.equal(await provisionLiveStorageRoot(join(root, 'outside'), 'project', options), false);
  const existing = join(parent, 'existing'); await mkdir(existing);
  assert.equal(await provisionLiveStorageRoot(existing, 'project', options), false);
  assert.equal((await lstat(existing)).isSymbolicLink(), false);
  await assert.rejects(provisionLiveStorageRoot(join(parent, 'offline'), 'project', {
    configFile, checkMounted: async () => { throw Error('offline'); },
  }), /offline/);
  await assert.rejects(lstat(join(parent, 'offline')), { code: 'ENOENT' });
  await mkdir(join(targetParent, 'foreign'));
  await assert.rejects(provisionLiveStorageRoot(join(parent, 'foreign'), 'project', options), { code: 'EEXIST' });
  await withStorageConfigLock(config, async () => {
    await assert.rejects(provisionLiveStorageRoot(join(parent, 'locked'), 'project', options), /being updated/);
  });
  assert.throws(() => validateLiveStorage({ ...config, newRoots: [{ ...config.newRoots[0], sourceParent: '/' }] }), /Unsafe/);
  await writeFile(join(process.env.AIOS_DATA, 'live-storage.json'), JSON.stringify({ configFile }));
  await writeFile(config.statusFile, JSON.stringify({ id: config.id, available: true, checkedAt: Date.now(),
    volume: { available_bytes: 100 * 1024 ** 3 }, backing: { available_bytes: 1 } }));
  assert.throws(() => assertDiskHeadroom(parent), e => e.code === 'disk-space-critical' && /Spark backing disk/.test(e.message));
  console.log('storage provision: new remote writes, existing roots untouched, no fallback, config lease, backing capacity passed');
} finally { await rm(root, { recursive: true, force: true }); }
