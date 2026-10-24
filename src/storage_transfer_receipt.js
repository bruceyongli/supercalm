// Explicit operator waiver of content rereads, NOT an integrity proof. Switching under
// this policy always retains the original directory and requires a quiesced reconcile.
import { lstat, realpath } from 'node:fs/promises';

export function transferOnlyAuthorized(config, journal) {
  const policy = config.migrationVerification;
  if (!policy || policy.mode === 'full') return false;
  if (policy.version !== 1 || policy.mode !== 'transfer-only' || policy.retainOriginals !== true
      || policy.storageId !== config.id || !Number.isFinite(policy.approvedAt)
      || policy.approvedAt <= 0 || policy.approvedAt > Date.now() || !Array.isArray(policy.roots)) {
    throw Error('Invalid operator transfer-only authorization');
  }
  return policy.roots.some(root => root.source === journal.source && root.target === journal.target
    && root.sourceInode === journal.sourceInode && root.sourceDevice === journal.sourceDevice);
}

async function rootIdentity(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw Error('Transfer roots must remain physical directories');
  }
  return { inode: info.ino, device: info.dev };
}

export async function checkStorageTransfer(config, journal, { quiesced = false } = {}) {
  if (!transferOnlyAuthorized(config, journal)) throw Error('Transfer-only check was not authorized for this exact operation');
  if (!['copied', 'verified', 'transfer-checked'].includes(journal.state) || journal.error
      || !Number.isFinite(journal.copiedAt) || !journal.copyReceipt
      || journal.copyReceipt.completedAt !== journal.copiedAt || journal.copyReceipt.exitCode !== 0
      || !Array.isArray(journal.unstableSources) || journal.unstableSources.length) {
    throw Error('A completed stable transfer receipt is required; reconcile the existing copy');
  }
  const source = await rootIdentity(journal.source), target = await rootIdentity(journal.target);
  if (source.inode !== journal.sourceInode || source.device !== journal.sourceDevice) throw Error('Source identity changed');
  if (quiesced && journal.copyReceipt.quiesced !== true) throw Error('Transfer-only cutover requires a fresh quiesced reconciliation');
  return { algorithm: 'transfer-receipt', contentVerified: false,
    scope: 'successful-copy,source-root-identity,target-root-identity; no file-content verification',
    source: journal.source, target: journal.target, sourceIdentity: source, targetIdentity: target,
    copyCompletedAt: journal.copiedAt, checkedAt: Date.now(), quiesced,
    operatorApprovedAt: config.migrationVerification.approvedAt, retainOriginals: true,
    transfer: journal.copyReceipt.result };
}

export async function assertTransferReceipt(config, journal, evidence) {
  if (evidence?.algorithm !== 'transfer-receipt' || evidence.contentVerified !== false
      || !evidence.quiesced || !evidence.retainOriginals || evidence.source !== journal.source
      || evidence.target !== journal.target || evidence.copyCompletedAt !== journal.copiedAt
      || !Number.isFinite(evidence.checkedAt) || Date.now() - evidence.checkedAt > 10 * 60_000
      || evidence.checkedAt > Date.now() || evidence.operatorApprovedAt !== config.migrationVerification?.approvedAt) {
    throw Error('Invalid or stale transfer receipt; originals retained');
  }
  const current = await checkStorageTransfer(config, journal, { quiesced: true });
  for (const field of ['sourceIdentity', 'targetIdentity']) {
    if (current[field].inode !== evidence[field]?.inode || current[field].device !== evidence[field]?.device) {
      throw Error('Transfer root identity changed; originals retained');
    }
  }
}
