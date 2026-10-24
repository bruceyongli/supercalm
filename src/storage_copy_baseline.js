// A completed reconciliation covers everything older than its START. Advancing to
// its finish would skip writes made after a file was visited during that pass.
// This is staging bookkeeping only, never an integrity proof or cutover consent.
import { posix } from 'node:path';

// A completed-but-changing pass still covered its other paths. Reuse that work
// only as a path-scoped START watermark; unstable subtrees get a complete
// quick-check (their old receipt lacks per-directory identity proofs). The
// global baseline and receipt remain untouched until a new pass
// completes. Malformed/legacy-incomplete evidence simply gets the conservative
// older baseline, never a guessed coverage boundary.
export function storageCopyCoverage(journal, baseline, startedAt) {
  const receipt = journal.copyReceipt;
  if (journal.state !== 'staged-changing' || !receipt || receipt.exitCode !== 0
      || receipt.quiesced !== true || receipt.completedAt !== journal.copiedAt
      || !Number.isFinite(receipt.startedAt) || receipt.startedAt <= baseline
      || !Number.isFinite(receipt.completedAt) || receipt.completedAt < receipt.startedAt
      || receipt.completedAt > startedAt || !Array.isArray(journal.unstableSources)
      || !journal.unstableSources.length || !Array.isArray(receipt.result?.unstableSources)
      || JSON.stringify(journal.unstableSources) !== JSON.stringify(receipt.result.unstableSources)
      || !Number.isSafeInteger(receipt.result.files) || receipt.result.files < 0) return null;
  const retryPaths = [...new Set(journal.unstableSources)];
  // A changed root has no unaffected scope. Keep command arguments bounded and
  // reject any name that can escape or reinterpret its source-relative scope.
  if (retryPaths.some(path => typeof path !== 'string' || !path || path.includes('\0')
      || posix.isAbsolute(path) || posix.normalize(path) !== path || path === '..'
      || path === '.' || path.endsWith('/') || path.startsWith('../'))
      || Buffer.byteLength(JSON.stringify(retryPaths)) > 32 * 1024) return null;
  return { coveredSince: receipt.startedAt, retryPaths,
    priorReceiptStartedAt: receipt.startedAt, priorReceiptCompletedAt: receipt.completedAt };
}

export async function runStorageCopyPass({ journal, incremental, quiesced = false, copy, save,
  now = Date.now, pid = process.pid }) {
  if (incremental && !['copied', 'staged-changing', 'verified', 'transfer-checked'].includes(journal.state)) {
    throw Error('Reconciliation requires a completed staging copy; run copy first');
  }
  const startedAt = now();
  const baseline = incremental ? (journal.copyBaselineAt || journal.createdAt) : startedAt;
  if (!Number.isFinite(baseline) || baseline <= 0 || baseline > startedAt) throw Error('Invalid completed-copy baseline');
  const coverage = incremental ? storageCopyCoverage(journal, baseline, startedAt) : null;
  await save({ state: 'copying', error: null, pid });
  const result = await copy({ baseline, startedAt, coverage });
  const unstable = result.unstableSources || [];
  if (!Array.isArray(unstable)) throw Error('Invalid copy stability result');
  const copiedAt = now();
  await save({ state: unstable.length ? 'staged-changing' : 'copied', error: null, pid: null,
    unstableSources: unstable, copyBaselineAt: unstable.length ? baseline : startedAt, copiedAt,
    copyReceipt: { startedAt, completedAt: copiedAt, exitCode: 0, quiesced, result,
      ...(coverage ? { incrementalCoverage: coverage } : {}) } });
  return result;
}
