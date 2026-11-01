import assert from 'node:assert/strict';
import { uniqueDiskRoots, createSessionDiskUsage, sessionResourceSummary } from '../src/session_resource_summary.js';

assert.deepEqual(uniqueDiskRoots(['/work/tree/uploads/s_1', '/work/tree', '/work/tree', '/work/tree-two', '/log']),
  ['/log', '/work/tree', '/work/tree-two']);
let now = 1000, calls = 0, active = 0, maxActive = 0, fail = false, unblock;
let gate = new Promise(r => { unblock = r; });
const disk = createSessionDiskUsage({ clock: () => now, ttl: 100, measure: async (_path, options) => {
  calls++; active++; maxActive = Math.max(active, maxActive);
  assert.ok(options.timeoutMs <= 5000); await gate; active--;
  return fail ? { bytes: 0, error: 'permission failure' } : { bytes: 100 };
} });
const scopes = [{ id: 's_one', paths: ['/work/one', '/work/one/uploads'] }, { id: 's_two', paths: ['/work/two'] }];
assert.equal(disk.get(scopes)[0].disk_bytes, null, 'unknown is not zero');
disk.get(scopes); disk.get(scopes); assert.equal(calls, 1, 'HTTP polling shares the same scan');
unblock(); await disk.settled();
assert.equal(maxActive, 1); assert.equal(calls, 2);
assert.equal(disk.get(scopes)[0].disk_bytes, 100, 'nested scopes counted once');
now += 50; disk.get(scopes); assert.equal(calls, 2, 'one minute floor (test 100ms)');
now += 300; fail = true; disk.get(scopes); await disk.settled();
const stale = disk.get(scopes)[0];
assert.equal(stale.disk_bytes, 100, 'last successful size survives measurement failure');
assert.equal(stale.disk_checked_at, 1000); assert.equal(stale.disk_stale, true);
assert.equal(stale.disk_error, 'Disk measurement incomplete');
const before = calls; disk.get(scopes); assert.equal(calls, before, 'errors do not create retry loops');
const changed = disk.get([{ id: 's_one', paths: ['/new/worktree'] }])[0];
assert.equal(changed.disk_bytes, null, 'changed ownership cannot reuse an old size');
await disk.settled();

let remoteCalls = 0, pressure = false, broken = false;
const remote = createSessionDiskUsage({ clock: () => now, ttl: 100, remoteTtl: 1500,
  canMeasure: () => !pressure, measure: async () => { remoteCalls++; return broken ? { error: 'timeout' } : { bytes: 42 }; } });
const remoteScope = [{ id: 's_remote', paths: ['/mount/worktree'], remote: true }];
remote.get(remoteScope); await remote.settled();
now += 200; remote.get(remoteScope); await remote.settled();
assert.equal(remoteCalls, 1, 'network scopes are not walked at the local polling cadence');
now += 1600; pressure = true; remote.get(remoteScope); await remote.settled();
assert.equal(remoteCalls, 1, 'memory pressure defers recursive network disk scans');
assert.equal(remote.get(remoteScope)[0].disk_bytes, 42, 'deferral keeps the last known size');
await remote.settled(); pressure = false; broken = true;
remote.get(remoteScope); await remote.settled();
assert.equal(remoteCalls, 2);
now += 1600; remote.get(remoteScope); await remote.settled();
assert.equal(remoteCalls, 2, 'a failed network scan backs off instead of timing out every minute');
now += 1500; broken = false; remote.get(remoteScope); await remote.settled();
assert.equal(remoteCalls, 3, 'a recovered path eventually refreshes');
assert.equal(remote.get(remoteScope)[0].disk_stale, false);

const snapshot = { checked_at: 2000, groups: [{ session_id: 's_one', cpu_percent: 143.1, footprint_bytes: 3e9, rss_bytes: 1e9,
  footprint_processes: 1, process_count: 2 }], errors: [] };
const sessions = [{ id: 's_one', status: 'working', started_at: 1 }, { id: 's_absent', status: 'waiting' }, { id: 's_new', status: 'starting' }];
const summary = sessionResourceSummary(snapshot, sessions, [stale]);
assert.equal(summary[0].memory_bytes, 3e9); assert.equal(summary[0].memory_partial, true);
assert.equal(summary[0].disk_bytes, 100); assert.equal(summary[0].disk_stale, true);
assert.equal(summary[1].cpu_percent, 0); assert.equal(summary[2].cpu_percent, null);
assert.equal(sessionResourceSummary({ ...snapshot, errors: ['Session ownership unavailable'] }, sessions, [])[1].cpu_percent, null);
assert.equal(sessionResourceSummary({ groups: [] }, sessions, [])[1].cpu_percent, null);
assert.equal(sessionResourceSummary({ ...snapshot, error: 'failed' }, sessions, [])[0].stale, true);
assert.doesNotMatch(JSON.stringify(summary), /processes|args|title|path/);
console.log('session_resource_summary: bounded serial scans, scope deduplication, cache, failed/stale samples and compact projection passed');
