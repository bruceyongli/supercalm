import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryBytes, parseProcesses, parseFootprints, parseMacMemory, hostLevel,
  createHostSampler, accountResources, createResourceInventory, assertResourceHeadroom } from '../src/resource_usage.js';

assert.equal(memoryBytes('4.5G+'), 4.5 * 1024 ** 3);
assert.equal(memoryBytes('256K-'), 256 * 1024);
assert.equal(memoryBytes(undefined), null);
assert.equal(parseFootprints('PID MEM\n23 4519M\n24 150K+\nheader').get(23), 4519 * 1024 ** 2);
assert.deepEqual(parseMacMemory('kern.memorystatus_vm_pressure_level: 2\nvm.swapusage: total = 7000.00M used = 6000.00M free = 1000.00M'),
  { memory_pressure: 'warning', swap_used_bytes: 6000 * 1024 ** 2 });
assert.equal(parseMacMemory('').memory_pressure, 'unknown');
assert.doesNotThrow(() => assertResourceHeadroom({ memory_pressure: 'normal', free_memory_bytes: 1, swap_used_bytes: 20e9 }));
assert.doesNotThrow(() => assertResourceHeadroom({ memory_pressure: 'unknown' }));
assert.throws(() => assertResourceHeadroom({ memory_pressure: 'critical' }), e => e.code === 'host-memory-critical' && e.status === 503);
assert.equal(hostLevel({ memory_pressure: 'normal', cores: 8, load_average: [68], cpu_busy_percent: 99 }), 'warning');

let time = 1000, calls = 0, release;
const cpu = () => [{ times: { idle: time, user: time, sys: time } }];
const host = createHostSampler({ osPlatform: 'darwin', clock: () => time, cpuInfo: cpu, memoryTotal: () => 16e9,
  memoryFree: () => 100, loads: () => [1, 2, 3], ttl: 100,
  run: async () => { calls++; await new Promise(resolve => { release = resolve; }); return 'kern.memorystatus_vm_pressure_level: 1'; } });
const one = host(), two = host();
assert.equal(calls, 1, 'concurrent admissions share one pressure probe');
release(); assert.equal(await one, await two);
assert.equal((await host()).memory_pressure, 'normal');
assert.equal(host.peek().checked_at, 1000); assert.equal(calls, 1);
time += 200; assert.equal(host.peek(), null, 'stale critical samples never block forever');
const next = host(); release(); assert.ok((await next).cpu_busy_percent > 60);
const missing = createHostSampler({ osPlatform: 'darwin', run: async () => { throw Error('probe failed'); } });
assert.equal((await missing()).memory_pressure, 'unknown');
const linux = createHostSampler({ osPlatform: 'linux', memoryTotal: () => 16 * 1024 ** 3,
  read: async () => 'MemAvailable: 12000 kB\nSwapTotal: 5000 kB\nSwapFree: 1000 kB' });
assert.equal((await linux()).memory_pressure, 'critical');

const ps = `
1 0 0.0 100 /sbin/launchd
10 1 1.0 100 /bin/tmux
11 10 0.0 100 /bin/zsh
12 11 4.0 200 codex --secret do-not-expose
13 12 30.0 300 python script.py
21 10 0.0 100 /bin/zsh
22 21 8.0 200 claude --prompt /private/session-storage/s_first/reference
30 1 40.0 1000 python /private/session-storage/s_first/tmp/test.py --token SECRET
31 30 9.0 100 ffmpeg -i clip.mp4
40 1 3.0 400 node server.js /private/session-storage/s_first/log
41 40 2.0 100 node child.js
50 1 0.0 20 python /private/worktrees/fixture/s_second/test.py
60 1 0.0 20 python /private/session-storage/s_first/x /private/session-storage/s_second/x
70 71 0.0 20 loop
71 70 0.0 20 loop
`;
const sessions = [{ id: 's_first', tmux: 'tmux-one', title: 'First', project_id: 'p', status: 'working' },
  { id: 's_second', tmux: 'tmux-two', title: 'Second', project_id: 'p', status: 'waiting' }];
const groups = accountResources({ processes: parseProcesses(ps), sessions, projects: [{ id: 'p', name: 'Fixture' }],
  panes: 'tmux-one|11\ntmux-two|21', services: '40\t0\tlocal.service', footprints: new Map([[30, 4e9]]) });
const first = groups.find(g => g.session_id === 's_first'), second = groups.find(g => g.session_id === 's_second');
assert.equal(first.process_count, 5); assert.equal(first.cpu_percent, 83);
assert.equal(first.detached_count, 2, 'detached worker and ffmpeg attributed through managed path');
assert.equal(first.footprint_bytes, 4e9); assert.equal(first.footprint_processes, 1);
assert.equal(second.process_count, 3, 'pane ancestry wins over a reference to another session');
assert.equal(second.detached_count, 1, 'detached worktree process attributed');
assert.equal(groups.find(g => g.id === 'service:local.service').process_count, 2, 'shared service stays separate');
assert.equal(groups.find(g => g.id === 'process:60').kind, 'unattributed', 'ambiguous path evidence is not guessed');
assert.equal(groups.reduce((n, g) => n + g.process_count, 0), parseProcesses(ps).length - 1, 'processes counted once');
assert.doesNotMatch(JSON.stringify(groups), /SECRET|do-not-expose|--prompt|private\/session/);

let at = 1000, scans = 0, unblock, fail = false;
const inventory = createResourceInventory({ clock: () => at, ttl: 100, osPlatform: 'linux', sessions: () => sessions,
  sampleHost: async () => ({ memory_pressure: 'normal' }), run: async file => {
    if (file === '/bin/ps') { scans++; if (fail) throw Error('failed'); await new Promise(r => { unblock = r; }); return ps; }
    return 'tmux-one|11\ntmux-two|21';
  } });
assert.equal(inventory.get().state, 'sampling'); inventory.get(); inventory.refresh();
assert.equal(scans, 1, 'many browsers / refreshes share a bounded sample');
unblock(); await inventory.refresh();
assert.equal(inventory.get().state, 'ready');
await inventory.refresh(); assert.equal(scans, 1, 'explicit refresh cannot bypass the cache floor');
at += 300; fail = true; await inventory.refresh();
assert.equal(inventory.get().checked_at, 1000); assert.equal(inventory.get().stale, true);
assert.match(inventory.get().error, /retaining/);
inventory.get(); assert.equal(scans, 2, 'failed sampling is also throttled');

const source = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
assert.match(source.slice(source.indexOf('async function completeLaunch'), source.indexOf('export function queueLaunch')),
  /resource-headroom[\s\S]+assertResourceHeadroom\(await sampleHostResources\(\)\)/);
assert.doesNotMatch(source.slice(source.indexOf('async function resumeNow'), source.indexOf('export function sessionBusyForCleanup')),
  /assertResourceHeadroom/, 'resource admission does not break existing-session recovery');
console.log('resource_usage.test passed: pressure, cache, detached ownership, service separation, redaction and new-launch-only guard');
