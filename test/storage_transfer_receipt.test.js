import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, readlink, rename, rmdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await realpath(await mkdtemp(join(tmpdir(), 'aios-transfer-receipt-')));
process.env.AIOS_DATA = join(root, 'local-data');
const { durableJson, switchStorageRoot } = await import('../src/storage_migration.js');
const { transferOnlyAuthorized, checkStorageTransfer, assertTransferReceipt } = await import('../src/storage_transfer_receipt.js');
try {
  const source = join(root, 'original'), mount = join(root, 'mounts', 'remote'), target = join(mount, 'project');
  await mkdir(source); await mkdir(target, { recursive: true });
  for (const path of [source, target]) await writeFile(join(path, 'report.txt'), 'original report');
  const st = await lstat(source), copiedAt = Date.now();
  const journal = { id: 'receipt-fixture', source, target, sourceInode: st.ino, sourceDevice: st.dev,
    state: 'copied', copiedAt, error: null, unstableSources: [],
    copyReceipt: { completedAt: copiedAt, exitCode: 0, quiesced: true,
      result: { files: 1, copiedBytes: 15, unstableSources: [] } } };
  const policy = { version: 1, mode: 'transfer-only', storageId: 'fixture', approvedAt: Date.now(), retainOriginals: true,
    roots: [{ source, target, sourceInode: st.ino, sourceDevice: st.dev }] };
  const config = { version: 1, id: 'fixture', mount, mappings: [{ source, target }], migrationVerification: policy };
  assert.equal(transferOnlyAuthorized({ ...config, migrationVerification: undefined }, journal), false, 'full content checks remain default');
  assert.equal(transferOnlyAuthorized({ ...config, migrationVerification: { ...policy, roots: [] } }, journal), false);
  assert.equal(transferOnlyAuthorized(config, { ...journal, sourceInode: st.ino + 1 }), false, 'waiver pins the original root inode');
  assert.throws(() => transferOnlyAuthorized({ ...config, migrationVerification: { ...policy, retainOriginals: false } }, journal), /Invalid operator/);
  assert.throws(() => transferOnlyAuthorized({ ...config, migrationVerification: { ...policy, storageId: 'other' } }, journal), /Invalid operator/);
  for (const changes of [{ state: 'copying' }, { state: 'staged-changing' }, { error: 'copy failed' },
    { copiedAt: undefined }, { copyReceipt: undefined }, { unstableSources: ['report.txt'] },
    { copyReceipt: { ...journal.copyReceipt, exitCode: 1 } }]) {
    await assert.rejects(checkStorageTransfer(config, { ...journal, ...changes }), /completed stable transfer/);
  }
  await assert.rejects(checkStorageTransfer(config, { ...journal, copyReceipt: { ...journal.copyReceipt, quiesced: false } }, { quiesced: true }), /quiesced reconciliation/);
  const prepared = await checkStorageTransfer(config, journal);
  assert.equal(prepared.contentVerified, false); assert.equal(prepared.algorithm, 'transfer-receipt');
  assert.equal(prepared.digest, undefined, 'a copy receipt must never masquerade as a SHA proof');
  await assert.rejects(assertTransferReceipt(config, journal, prepared), /Invalid or stale/);
  const receipt = await checkStorageTransfer(config, journal, { quiesced: true });
  await assertTransferReceipt(config, journal, receipt);
  await assert.rejects(assertTransferReceipt(config, journal, { ...receipt, checkedAt: Date.now() - 11 * 60_000 }), /stale/);
  await assert.rejects(assertTransferReceipt(config, journal, { ...receipt, copyCompletedAt: 1 }), /Invalid/);
  await rename(target, target + '-previous'); await mkdir(target);
  await assert.rejects(assertTransferReceipt(config, journal, receipt), /root identity changed/);
  await rmdir(target); await rename(target + '-previous', target);
  const configFile = join(root, 'config.json'); await durableJson(configFile, config);
  const states = [], save = async changes => { states.push(changes.state); Object.assign(journal, changes); };
  const args = { source, target, configFile, journal, save, evidence: receipt,
    verifyMetadata: async () => { throw Error('Transfer-only must not start a full-file scan'); },
    checkMounted: async () => {}, checkUnused: async () => {} };
  await assert.rejects(switchStorageRoot({ ...args, checkUnused: async () => { throw Error('live writer'); } }), /live writer/);
  assert.equal((await lstat(source)).isDirectory(), true);
  await durableJson(configFile, { ...config, migrationVerification: { ...policy, roots: [] } });
  await assert.rejects(switchStorageRoot(args), /not authorized/);
  await durableJson(configFile, config);
  // The reduced check cannot detect arbitrary nested corruption. Keep that limitation
  // explicit and preserve the original, rather than silently deleting the good copy.
  await writeFile(join(target, 'report.txt'), 'same-size bad!!');
  const result = await switchStorageRoot(args);
  assert.equal(result.contentVerified, false); assert.equal(result.sourceRetained, true);
  assert.deepEqual(states, ['switching', 'switched', 'complete']);
  assert.equal(await readlink(source), target);
  assert.equal(journal.reclaimedBytes, 0); assert.equal(journal.quarantine, null);
  assert.equal(journal.retainedOriginal.inode, st.ino);
  assert.equal((await lstat(journal.retainedOriginal.path)).ino, st.ino);
  assert.equal(await readFile(join(journal.retainedOriginal.path, 'report.txt'), 'utf8'), 'original report');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).mappings[0].active, true);
  console.log('transfer-only: explicit exact-operation consent, no full scans, fresh quiesced receipt, guards and original retention passed');
} finally { await rm(root, { recursive: true, force: true }); }
