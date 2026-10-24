import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, lstat, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-storage-cleanup-')));
process.env.AIOS_DATA = join(root, 'data');
delete process.env.AIOS_LIVE_STORAGE_CONFIG;
const { provisionLiveStorageRoot, cleanupProvisionedSessionRoot } = await import('../src/storage_provision.js');
const { durableJson } = await import('../src/storage_migration.js');
const mount = join(root, 'mounts', 'remote'), parent = join(process.env.AIOS_DATA, 'session-storage');
const configFile = join(root, 'config.json');
const read = async () => JSON.parse(await readFile(configFile, 'utf8'));
const options = { configFile, checkMounted: async () => {}, checkUnused: async () => {} };
const config = { version: 1, id: 'cleanup-fixture', mount, journalRoot: join(root, 'journal'), mappings: [],
  newRoots: [{ kind: 'session', sourceParent: parent, targetParent: join(mount, 'scratch') }] };
async function create(name) {
  const source = join(parent, name), target = join(mount, 'scratch', name);
  await provisionLiveStorageRoot(source, 'session', options);
  await writeFile(join(source, 'temporary.txt'), 'owned disposable data');
  return { source, target };
}
try {
  await mkdir(process.env.AIOS_DATA); await mkdir(mount, { recursive: true }); await durableJson(configFile, config);
  const clean = await create('s_clean');
  assert.equal((await cleanupProvisionedSessionRoot(clean.source, options)).removed, true);
  await assert.rejects(lstat(clean.source), { code: 'ENOENT' }); await assert.rejects(lstat(clean.target), { code: 'ENOENT' });
  assert.equal((await read()).mappings.length, 0, 'no orphaned target or stale active mapping');
  const busy = await create('s_busy');
  await assert.rejects(cleanupProvisionedSessionRoot(busy.source, { ...options, checkUnused: async () => { throw Error('active reader'); } }), /active reader/);
  assert.equal(await readFile(join(busy.target, 'temporary.txt'), 'utf8'), 'owned disposable data');
  assert.equal((await read()).mappings[0].disposableCleanup, undefined);
  await assert.rejects(cleanupProvisionedSessionRoot(busy.source, { ...options, checkMounted: async () => { throw Error('offline'); } }), /offline/);
  assert.equal((await lstat(busy.source)).isSymbolicLink(), true);
  const preserved = { ...await read(), preserveMigratedData: true }; await durableJson(configFile, preserved);
  assert.deepEqual(await cleanupProvisionedSessionRoot(busy.source, options), { removed: false, reason: 'storage-migration' });
  delete preserved.preserveMigratedData; await durableJson(configFile, preserved);
  const interrupted = await create('s_interrupted');
  await assert.rejects(cleanupProvisionedSessionRoot(interrupted.source, { ...options,
    removeTree: async (target, opts) => { await rm(target, opts); throw Error('simulated interruption after target removal'); },
  }), /simulated interruption/);
  assert.ok((await read()).mappings.find(m => m.source === interrupted.source).disposableCleanup);
  assert.equal((await lstat(interrupted.source)).isSymbolicLink(), true);
  assert.equal((await cleanupProvisionedSessionRoot(interrupted.source, options)).removed, true, 'retry finishes the exact journaled cleanup');
  assert.equal((await read()).mappings.some(m => m.source === interrupted.source), false);
  await assert.rejects(lstat(interrupted.source), { code: 'ENOENT' });
  const replaced = await create('s_replaced'), unrelated = join(root, 'unrelated'); await mkdir(unrelated);
  await writeFile(join(unrelated, 'keep.txt'), 'not owned by cleanup');
  await assert.rejects(cleanupProvisionedSessionRoot(replaced.source, { ...options, removeTree: async () => { throw Error('interrupted'); } }), /interrupted/);
  await unlink(replaced.source); await symlink(unrelated, replaced.source);
  await assert.rejects(cleanupProvisionedSessionRoot(replaced.source, options), /alias changed/);
  assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'not owned by cleanup');
  assert.equal(await readFile(join(replaced.target, 'temporary.txt'), 'utf8'), 'owned disposable data');
  const manualSource = join(parent, 's_manual'), manualTarget = join(mount, 'manual');
  await mkdir(manualTarget); await symlink(manualTarget, manualSource);
  const current = await read(); current.mappings.push({ source: manualSource, target: manualTarget, active: true });
  await durableJson(configFile, current);
  assert.deepEqual(await cleanupProvisionedSessionRoot(manualSource, options), { removed: false, reason: 'registered-storage' });
  assert.equal((await lstat(manualSource)).isSymbolicLink(), true);
  console.log('provisioned scratch cleanup passed: actual target reclaimed, mappings retained on failure, exact retry, active readers/offline/manual mappings protected');
} finally { await rm(root, { recursive: true, force: true }); }
