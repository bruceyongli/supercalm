#!/usr/bin/env node
// Explicit, restartable maintenance for detached project-owned test services. Native
// coding sessions use storage-maintenance.mjs; launchd services use their own plists.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveStorageConfig } from '../src/live_storage.js';
import { durableJson, openFiles } from '../src/storage_migration.js';

const exec = promisify(execFile);
const [operation, ...rawArgs] = process.argv.slice(2);
const cdpArg = rawArgs.find(arg => /^--cdp=\d+$/.test(arg));
const cdpPort = cdpArg ? Number(cdpArg.slice(6)) : null;
const args = rawArgs.filter(arg => arg !== cdpArg);
if (!['park', 'resume'].includes(operation) || !args.length || args.some(x => !/^\d+$/.test(x))) throw Error('Usage: storage-processes.mjs park|resume PID...');
const config = liveStorageConfig();
if (!config?.journalRoot) throw Error('Configured live storage is required');
const journalRoot = join(dirname(config.journalRoot), 'private-process-checkpoints');
await mkdir(journalRoot, { recursive: true, mode: 0o700 });
const inside = (p, root) => p === root || p?.startsWith(root + '/');
const approved = p => !/\/proxy(?:\/|$)/.test(p || '') && config.mappings.some(m => inside(p, m.source) || inside(p, m.target));
async function processTable() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 8000 });
  return new Map(stdout.trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return [Number(m[1]), { pid: Number(m[1]), parent: Number(m[2]), started: m[3] }];
  }));
}
async function terminateSaved(entry) {
  let table = await processTable();
  if (table.get(entry.pid)?.started !== entry.started) return;
  if (cdpPort) {
    const owner = (await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(entry.pid), '-iTCP:' + cdpPort, '-sTCP:LISTEN', '-Fp'], { timeout: 8000 })).stdout;
    if (!owner.split('\n').includes('p' + entry.pid)) throw Error('The selected process does not own this browser endpoint');
    const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    const url = new URL(version.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== cdpPort) throw Error('Unexpected browser endpoint');
    await new Promise((yes, no) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); no(Error('Browser graceful close timed out')); }, 8000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.addEventListener('close', () => { clearTimeout(timer); yes(); });
      // Browser.close commonly tears down the socket without a WebSocket close frame.
      // The process identity check below, not a transport receipt, proves completion.
      ws.addEventListener('error', () => { clearTimeout(timer); yes(); });
    });
  } else {
    process.kill(entry.pid, 'SIGTERM');
    process.kill(entry.pid, 'SIGCONT');
  }
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    table = await processTable();
    if (table.get(entry.pid)?.started !== entry.started) return;
  }
  throw Error('Process did not exit gracefully; checkpoint preserved, no force-kill: ' + entry.pid);
}
for (const pid of args.map(Number)) {
  if (pid <= 1) throw Error('Invalid process');
  const file = join(journalRoot, pid + '.json');
  let entry;
  try { entry = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (operation === 'park') {
    const table = await processTable();
    for (let ancestor = process.pid; table.has(ancestor); ancestor = table.get(ancestor).parent) {
      if (ancestor === pid) throw Error('Cannot park this controller or its ancestors');
    }
    const current = table.get(pid);
    if (!current && entry && ['parking', 'parked'].includes(entry.phase)) {
      entry.phase = 'parked'; await durableJson(file, entry);
      console.log(JSON.stringify({ parked: pid, restartCheckpoint: file, recoveredCheckpoint: true }));
      continue;
    }
    if (!current) throw Error('Process no longer exists: ' + pid);
    if (entry && entry.started !== current.started) throw Error('Checkpoint PID was reused; preserve the previous checkpoint');
    const jobs = (await exec('/bin/launchctl', ['list'], { timeout: 8000 })).stdout;
    const service = jobs.split('\n').find(line => Number(line.split(/\s+/)[0]) === pid)?.split(/\s+/)[2];
    if (service && (!service.startsWith('application.') || !cdpPort)) throw Error('Use the exact launchd service to park this process');
    const handles = await openFiles(['/']);
    const cwd = handles.find(f => f.pid === pid && f.descriptor === 'cwd')?.path;
    const { stdout } = await exec('python3', [fileURLToPath(new URL('../scripts/storage-process-state.py', import.meta.url)), String(pid)], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    const native = JSON.parse(stdout); // private: never log argv or environment
    if (/(?:^|\/)(?:codex|claude(?:\.exe)?|agy|tmux|zsh|bash|sh)$/.test(native.executable)) throw Error('Use session maintenance for native coding agents and shells');
    if (!approved(cwd) && !approved(native.executable)) throw Error('Process does not own an approved project/storage root');
    if (!cwd) throw Error('Cannot checkpoint exact working directory');
    entry = { ...current, ...native, cwd, phase: 'parking', capturedAt: Date.now() };
    await durableJson(file, entry);
    await terminateSaved(entry);
    entry.phase = 'parked'; await durableJson(file, entry);
    console.log(JSON.stringify({ parked: pid, restartCheckpoint: file }));
  } else {
    if (!entry || entry.phase !== 'parked') throw Error('A parked checkpoint is required: ' + pid);
    if (!approved(entry.cwd) && !approved(entry.executable)) throw Error('Checkpoint no longer belongs to managed storage');
    const output = await open(join(journalRoot, pid + '.log'), 'a', 0o600);
    try {
      const child = spawn(entry.executable, entry.argv.slice(1), { cwd: entry.cwd, env: entry.env,
        argv0: entry.argv[0], detached: true, stdio: ['ignore', output.fd, output.fd] });
      await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
      child.unref();
      entry.phase = 'resumed'; entry.resumedPid = child.pid; entry.resumedAt = Date.now();
      await durableJson(file, entry);
      console.log(JSON.stringify({ resumed: pid, pid: child.pid }));
    } finally { await output.close(); }
  }
}
