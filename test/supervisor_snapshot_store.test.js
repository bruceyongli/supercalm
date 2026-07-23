import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-supervisor-snapshots-'));
process.env.AIOS_SUPERVISOR_INLINE_SNAPSHOT_RETAIN = '0';

const { db } = await import('../src/store.js');
const { makeDecision, persistDecision, decisionSnapshot, latestDecision, snapshotHash, maintainLedger } = await import('../src/agents/supervisor/decision_records.js');

const snapshot = {
  generatedAt: 123,
  session: { id: 's_snap', status: 'waiting', summary: 'Needs review' },
  currentTask: { id: 'task-1', version: 2 },
};
for (let i = 0; i < 2; i++) {
  const decision = makeDecision({ sessionId: 's_snap', snapshot, ruleId: 'test.snapshot', action: { type: 'wait', target: 'internal', payload: {} }, generatedAt: 1000 + i });
  persistDecision('s_snap', decision, snapshot);
}

assert.equal(db.prepare('SELECT COUNT(*) n FROM supervisor_decisions').get().n, 2, 'decision metadata remains one row per tick');
assert.equal(db.prepare('SELECT COUNT(*) n FROM supervisor_snapshots').get().n, 1, 'identical snapshots are stored once by hash');
assert.equal(db.prepare('SELECT COUNT(*) n FROM supervisor_decisions WHERE snapshot_json IS NOT NULL').get().n, 0, 'new decision rows never inline the blob');
const latest = latestDecision('s_snap');
assert.equal(latest.ruleId, 'test.snapshot');
assert.equal(decisionSnapshot(latest.snapshotHash).session.id, 's_snap', 'snapshot evidence resolves through its content hash');

// Existing databases contain inline snapshots. Maintenance must backfill verified content first, then
// clear the duplicate inside the same transaction; even a stale stored hash is repaired from the JSON.
const legacy = { generatedAt: 456, session: { id: 's_legacy', status: 'working' }, currentTask: { id: 'old', version: 1 } };
db.prepare(`INSERT INTO supervisor_decisions (id, session_id, ts, snapshot_hash, snapshot_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`).run('sd_legacy', 's_legacy', 10, 'stale-hash', JSON.stringify({ schema: 'supervisor.snapshot', ...legacy }), 10);
maintainLedger();
const migrated = db.prepare('SELECT snapshot_hash, snapshot_json FROM supervisor_decisions WHERE id=?').get('sd_legacy');
const legacyHash = snapshotHash(legacy);
assert.equal(migrated.snapshot_hash, legacyHash, 'legacy hash is recomputed from canonical snapshot content');
assert.equal(migrated.snapshot_json, null, 'inline evidence is cleared only after backfill');
assert.equal(decisionSnapshot(legacyHash).session.id, 's_legacy', 'migrated historical evidence remains resolvable');

console.log('supervisor_snapshot_store.test ok');
