// A completed reconciliation covers everything older than its START. Advancing to
// its finish would skip writes made after a file was visited during that pass.
// This is staging bookkeeping only, never an integrity proof or cutover consent.
export async function runStorageCopyPass({ journal, incremental, quiesced = false, copy, save,
  now = Date.now, pid = process.pid }) {
  if (incremental && !['copied', 'staged-changing', 'verified', 'transfer-checked'].includes(journal.state)) {
    throw Error('Reconciliation requires a completed staging copy; run copy first');
  }
  const startedAt = now();
  const baseline = incremental ? (journal.copyBaselineAt || journal.createdAt) : startedAt;
  if (!Number.isFinite(baseline) || baseline <= 0 || baseline > startedAt) throw Error('Invalid completed-copy baseline');
  await save({ state: 'copying', error: null, pid });
  const result = await copy({ baseline, startedAt });
  const unstable = result.unstableSources || [];
  if (!Array.isArray(unstable)) throw Error('Invalid copy stability result');
  const copiedAt = now();
  await save({ state: unstable.length ? 'staged-changing' : 'copied', error: null, pid: null,
    unstableSources: unstable, copyBaselineAt: unstable.length ? baseline : startedAt, copiedAt,
    copyReceipt: { startedAt, completedAt: copiedAt, exitCode: 0, quiesced, result } });
  return result;
}
