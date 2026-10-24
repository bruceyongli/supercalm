import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runStorageCopyPass } from '../src/storage_copy_baseline.js';
import { checkStorageTransfer } from '../src/storage_transfer_receipt.js';

if (process.platform !== 'darwin') {
  console.log('storage_copy_races.test: native macOS copier cases skipped on this platform');
} else {
  const exec = promisify(execFile);
  const { stdout } = await exec('python3', ['-B',
    fileURLToPath(new URL('./fixtures/storage_copy_races.py', import.meta.url)),
    fileURLToPath(new URL('../scripts/storage-copy.py', import.meta.url))],
  { env: { ...process.env, AIOS_STORAGE_COPY_WORKERS: '4' }, timeout: 30000, maxBuffer: 1024 * 1024 });
  const { cases, unstableResult } = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(cases.length, 26);
  assert.ok(unstableResult.unstableSources.length);

  // A successful background staging pass is not permission to switch storage.
  // Even a caller claiming quiescence cannot use the race result as a receipt.
  const baseline = Date.now() - 10000;
  const journal = { source: '/fixture/source', target: '/fixture/mount/project', sourceInode: 11, sourceDevice: 22,
    state: 'copied', createdAt: baseline, copyBaselineAt: baseline, copiedAt: baseline };
  await runStorageCopyPass({ journal, incremental: true, quiesced: true,
    copy: async () => unstableResult, save: async changes => Object.assign(journal, changes) });
  assert.equal(journal.state, 'staged-changing');
  assert.equal(journal.copyBaselineAt, baseline, 'an unstable pass never advances the completed baseline');
  const config = { id: 'fixture', migrationVerification: { version: 1, mode: 'transfer-only', retainOriginals: true,
    storageId: 'fixture', approvedAt: baseline, roots: [{ source: journal.source, target: journal.target,
      sourceInode: journal.sourceInode, sourceDevice: journal.sourceDevice }] } };
  await assert.rejects(checkStorageTransfer(config, journal, { quiesced: true }), /completed stable transfer receipt/);
  console.log('storage_copy_races.test passed: 26 isolated producer/destination races; namespace churn, scoped coverage, ancestry, originals/revisions retained; quiesced unstable receipt rejected');
}
