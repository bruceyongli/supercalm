import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'aios-disk-storage-'));
process.env.AIOS_DATA = join(dir, 'data');
try {
  const { diskCapacity, assertDiskHeadroom } = await import('../src/disk_pressure.js');
  const info = { blocks: 1000, bsize: 1024, bavail: 50, bfree: 60 };
  assert.equal(diskCapacity(info, { reserveBytes: 10_000, warningBytes: 20_000 }).level, 'warning');
  assert.equal(diskCapacity(info, { reserveBytes: 100_000 }).level, 'critical');
  assert.equal(diskCapacity({ ...info, bavail: 700 }, { reserveBytes: 10_000, warningBytes: 20_000 }).level, 'healthy');
  const store = await import('../src/store.js');
  const { exclusiveStorageRows, measureStoragePath, createStorageInventory, cleanupEligibility, databaseStorage } = await import('../src/disk_storage.js');
  store.db.exec('CREATE TABLE disk_free_fixture(payload BLOB); INSERT INTO disk_free_fixture VALUES(zeroblob(262144)); DELETE FROM disk_free_fixture;');
  const dbStats = databaseStorage();
  assert.ok(dbStats.reusable_bytes > 0, 'deleted records leave reusable pages, not returned disk space');
  assert.equal(dbStats.reusable_bytes + dbStats.occupied_page_bytes,
    store.db.prepare('PRAGMA page_count').get().page_count * store.db.prepare('PRAGMA page_size').get().page_size);
  assert.ok(Number.isFinite(dbStats.file_bytes)); assert.ok(Number.isFinite(dbStats.allocated_bytes));
  const rows = exclusiveStorageRows([{ path: '/p', bytes: 1000 }, { path: '/p/data', bytes: 400 },
    { path: '/p/data/s', bytes: 100 }, { path: '/other', bytes: 200 }]);
  assert.deepEqual(rows.map(r => r.exclusive_bytes), [600, 300, 100, 200]);
  assert.equal(rows.reduce((n, r) => n + r.exclusive_bytes, 0), 1200, 'nested ownership never double-counts');
  await mkdir(join(dir, 'source')); await writeFile(join(dir, 'source', 'keep'), 'important project content');
  await symlink(join(dir, 'source'), join(dir, 'link'));
  assert.match((await measureStoragePath(join(dir, 'link'))).error, /Symlink/);
  assert.equal((await measureStoragePath(join(dir, 'missing'))).missing, true);
  let calls = 0, unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const inventory = createStorageInventory({ projects: () => [{ id: 'p1', name: 'Fixture', path: '/p1' }], sessions: () => [],
    canonical: async p => p, measure: async () => { calls++; await gate; return { bytes: 100 }; } });
  assert.equal(inventory.get().state, 'scanning');
  inventory.get(); inventory.get({ refresh: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 2, 'at most two off-thread measurements; repeated GETs share one scan');
  unblock(); const snapshot = await inventory.settled(); const done = calls;
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.projects[0].source_bytes, 100);
  inventory.get(); assert.equal(calls, done, 'cached Health polling does not rescan directories');
  const killed = store.createSession({ id: 's_killed', tool: 'codex', tmux: 'fixture', status: 'exited' });
  store.updateSession(killed.id, { status_reason: 'operator-kill' });
  assert.equal(cleanupEligibility(store.getSession(killed.id)).deletable, true);
  store.updateSession(killed.id, { desired_status: 'working', status_reason: 'unexpected-exit' });
  assert.equal(cleanupEligibility(store.getSession(killed.id)).cleanable, false, 'recoverable exits are protected');
  process.env.AIOS_DISK_RESERVE_BYTES = '1e30';
  assert.throws(() => assertDiskHeadroom(dir), error => error.code === 'disk-space-critical');
  delete process.env.AIOS_DISK_RESERVE_BYTES;
  store.db.close();
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('disk_storage.test passed: nested accounting, pressure thresholds, symlink safety, bounded async scan/cache');
