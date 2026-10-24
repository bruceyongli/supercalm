import assert from 'node:assert/strict';
import { runStorageCopyPass } from '../src/storage_copy_baseline.js';

const makeJournal = () => ({ state: 'copied', createdAt: 1000, copyBaselineAt: 2000, copiedAt: 2500 });
function fixture(journal, { start = 10000, finish = 20000, copy } = {}) {
  const writes = [], times = [start, finish];
  return { journal, writes, options: { journal, incremental: true, now: () => times.shift(), pid: 123,
    save: async value => { writes.push(structuredClone(value)); Object.assign(journal, value); },
    copy: copy || (async () => ({ files: 3, copiedBytes: 9, unstableSources: [] })) } };
}

const stable = fixture(makeJournal(), { copy: async ({ baseline, startedAt }) => {
  assert.equal(baseline, 2000); assert.equal(startedAt, 10000);
  assert.equal(stable.journal.state, 'copying');
  assert.equal(stable.journal.copyBaselineAt, 2000, 'a running pass cannot publish a new completed baseline');
  return { files: 3, copiedBytes: 9, unstableSources: [] };
} });
await runStorageCopyPass(stable.options);
assert.equal(stable.journal.copyBaselineAt, 10000, 'completed stable pass advances to start, not finish');
assert.equal(stable.journal.copiedAt, 20000);
assert.equal(stable.journal.copyReceipt.startedAt, 10000);
assert.equal(stable.journal.copyReceipt.completedAt, 20000);
assert.deepEqual(stable.writes.map(w => w.state), ['copying', 'copied']);

// Use the copier's real --since predicate (with its one-second overlap) across
// successive passes. An already handled pre-pass edit is skipped; a late write
// to an earlier visited file must still be copied by the next reconciliation.
const source = new Map([
  ['already-reconciled', { ctime: 8000, mtime: 8000, text: 'handled by first pass' }],
  ['changed-after-visit', { ctime: 15000, mtime: 8000, text: 'written while first pass ran' }],
  ['unchanged', { ctime: 1500, mtime: 1500, text: 'old' }],
]);
const target = new Map([['already-reconciled', 'handled by first pass'], ['changed-after-visit', 'before'], ['unchanged', 'old']]);
let recopied;
const next = fixture(stable.journal, { start: 22000, finish: 25000, copy: async ({ baseline }) => {
  recopied = [...source].filter(([, f]) => Math.max(f.ctime, f.mtime) >= baseline - 1000).map(([path, f]) => {
    target.set(path, f.text); return path;
  });
  return { files: source.size, unstableSources: [] };
} });
await runStorageCopyPass(next.options);
assert.deepEqual(recopied, ['changed-after-visit'], 'no repeated earlier deltas and no missed during-pass write');
assert.equal(target.get('changed-after-visit'), 'written while first pass ran');
assert.equal(next.journal.copyBaselineAt, 22000);

const unstable = fixture(makeJournal(), { copy: async () => ({ files: 3, unstableSources: ['still-writing'] }) });
await runStorageCopyPass(unstable.options);
assert.equal(unstable.journal.state, 'staged-changing');
assert.equal(unstable.journal.copyBaselineAt, 2000, 'unstable pass retains its previous baseline');
assert.equal(unstable.journal.copyReceipt.startedAt, 10000);

const failed = fixture(makeJournal(), { copy: async () => { throw Error('copy interrupted'); } });
await assert.rejects(runStorageCopyPass(failed.options), /copy interrupted/);
assert.equal(failed.journal.copyBaselineAt, 2000, 'failure never advances the last completed baseline');
assert.equal(failed.journal.copiedAt, 2500, 'failure never publishes a completed receipt');
assert.equal(failed.writes.length, 1);

const initial = fixture({ state: 'planned', createdAt: 1000 });
await runStorageCopyPass({ ...initial.options, incremental: false });
assert.equal(initial.journal.copyBaselineAt, 10000, 'initial completed copy uses its own start');
const legacy = fixture({ state: 'copied', createdAt: 1000 });
await runStorageCopyPass({ ...legacy.options, copy: async ({ baseline }) => {
  assert.equal(baseline, 1000); return { unstableSources: [] };
} });
assert.equal(legacy.journal.copyBaselineAt, 10000);
const unfinished = fixture({ state: 'copying', createdAt: 1000 });
await assert.rejects(runStorageCopyPass(unfinished.options), /completed staging copy/);
assert.equal(unfinished.writes.length, 0, 'no incremental shortcut for a partially completed initial copy');
const invalid = fixture({ state: 'copied', createdAt: 1000, copyBaselineAt: 10001 });
await assert.rejects(runStorageCopyPass(invalid.options), /Invalid completed-copy baseline/);
assert.equal(invalid.writes.length, 0);
console.log('storage_copy_baseline.test passed: start-only advancement, during-pass writes, unstable/failure retention, incomplete-copy guard');
