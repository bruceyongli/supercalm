#!/usr/bin/env node
// Explicit operator storage maintenance. Freeze/thaw keeps native agents and their conversations
// in memory; no input is sent, and no user Stop/attention/activity state is rewritten.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, DB_PATH, TMUX } from '../src/config.js';
import { durableJson, openFiles } from '../src/storage_migration.js';
import { readStorageMaintenance, storageMaintenanceFile, storageRecoveryGate } from '../src/storage_maintenance.js';
import { codexRolloutFiles, pickRolloutByUuid } from '../src/codex_rollouts.js';
import { sameStoragePath } from '../src/live_storage.js';
import { assertNativeHistorySession, assertNativeHistoryProcesses, parseNativeListeners } from '../src/storage_native_history_guard.js';

const exec = promisify(execFile);
const [operation, ...args] = process.argv.slice(2);
const ids = args.filter(a => !a.startsWith('--'));
if (args.some(a => a.startsWith('--') && !a.startsWith('--native=') && !a.startsWith('--native-history-only='))) throw Error('Unknown maintenance option');
const nativeIds = new Map(args.filter(a => a.startsWith('--native=')).map(a => {
  const m = a.match(/^--native=(s_[a-zA-Z0-9_-]+):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
  if (!m || operation !== 'freeze' || !ids.includes(m[1])) throw Error('Invalid explicit native history');
  return [m[1], m[2]];
}));
const historyOnly = args.filter(a => a.startsWith('--native-history-only=')).map(a => a.slice('--native-history-only='.length));
if (historyOnly.length && (operation !== 'freeze' || historyOnly.length !== 1 || ids.length !== 1
    || historyOnly[0] !== ids[0] || !nativeIds.has(ids[0]))) throw Error('Native-history maintenance requires exactly one explicit session and native identity');
if (!['freeze', 'park', 'thaw'].includes(operation) || (operation === 'freeze' && !ids.length)
    || ids.some(id => !/^s_[a-zA-Z0-9_-]+$/.test(id))) throw Error('Usage: storage-maintenance.mjs freeze SID... | park SID... | thaw');
const db = new DatabaseSync(DB_PATH, { readOnly: true });
function session(id) { return db.prepare('SELECT s.*,p.path AS project_path FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?').get(id); }
async function processes() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { timeout: 10_000, env: { ...process.env, LC_ALL: 'C' } });
  return new Map(stdout.trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) throw Error('Cannot verify process identity');
    return [Number(m[1]), { pid: Number(m[1]), parent: Number(m[2]), state: m[3], started: m[4] }];
  }));
}
function descendants(table, roots) {
  const selected = new Set(roots); let changed;
  do { changed = false; for (const p of table.values()) if (selected.has(p.parent) && !selected.has(p.pid)) { selected.add(p.pid); changed = true; } } while (changed);
  return [...selected].map(pid => table.get(pid)).filter(Boolean);
}
async function commandIdentities(family) {
  const { stdout } = await exec('/bin/ps', ['-p', family.map(p => p.pid).join(','), '-o', 'pid=,uid=,comm='], { timeout: 10_000 });
  return new Map(stdout.trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) throw Error('Cannot verify protected process identity');
    return [Number(m[1]), { uid: Number(m[2]), executable: m[3] }];
  }));
}
async function listeningProcesses(family) {
  const result = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', family.map(p => p.pid).join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
    { timeout: 10_000 }).catch(e => { if (e.code === 1 && !e.stderr?.trim()) return { stdout: '' }; throw e; });
  return parseNativeListeners(result.stdout);
}
let job = readStorageMaintenance();
async function save() { job.updatedAt = Date.now(); await durableJson(storageMaintenanceFile, job); }
async function request(s, action) {
  const res = await fetch(`http://127.0.0.1:${process.env.AIOS_PORT || 8793}/api/session/${s.id}/storage-${action}`, {
    method: 'POST', headers: { 'x-aios-maintenance-token': s.token }, signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json();
  if (!res.ok) throw Error(`${s.id} storage ${action}: ${body.error || res.status}`);
  return body;
}
async function park(s) {
  // Record recovery intent before releasing the old terminal. SIGCONT alone is
  // unsafe for a job-control shell: the CLI can stay alive but lose the foreground.
  s.phase = 'parking'; await save();
  await request(s, 'pause');
  const table = await processes();
  for (const p of job.processes.filter(p => s.processIds?.includes(p.pid))) {
    if (table.get(p.pid)?.started !== p.started) continue;
    try { process.kill(p.pid, 'SIGTERM'); process.kill(p.pid, 'SIGCONT'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  s.phase = 'parked'; await save();
  console.log(JSON.stringify({ parked: s.id, native: s.codex_uuid || s.claude_transcript, historyPreserved: true }));
}
try {
  if (operation === 'freeze') {
    if (job && !['frozen', 'freezing'].includes(job.phase)) throw Error('An unfinished maintenance transition exists; inspect/thaw it first');
    if (ids.some(id => job?.sessions.some(s => s.id === id && s.phase !== 'complete'))) throw Error('A selected session already belongs to this maintenance job');
    const selected = ids.map(id => {
      const s = session(id);
      const nativeHistoryOnly = historyOnly.includes(id);
      if (nativeHistoryOnly) assertNativeHistorySession(s, nativeIds.get(id), join(homedir(), 'proxy'));
      if (!s || !['working', 'waiting'].includes(s.desired_status)
        || /\/proxy(?:\/|$)/.test(s.project_path || '') && !nativeHistoryOnly) throw Error('Session is not eligible: ' + id);
      return { id, tmux: s.tmux, token: randomUUID(), phase: 'prepared',
        ...(nativeHistoryOnly ? { nativeHistoryOnly: true } : {}),
        status: s.status, desired_status: s.desired_status, last_activity: s.last_activity,
        tool: s.tool, codex_uuid: s.codex_uuid, claude_transcript: s.claude_transcript,
        worktree_path: s.worktree_path, project_path: s.project_path };
    });
    const panes = (await exec(TMUX, ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'], { timeout: 8000 })).stdout.trim().split('\n').map(l => l.split('|'));
    const table = await processes();
    const roots = selected.flatMap(s => panes.filter(p => p[0] === s.tmux).map(p => Number(p[1])));
    if (roots.length < selected.length) throw Error('A selected terminal is missing; no process paused');
    const owned = descendants(table, roots);
    if (owned.some(p => p.pid === process.pid)) throw Error('Cannot freeze this controller; use a detached controller for its own session');
    const backup = join(DATA_DIR, 'storage-maintenance-evidence', randomUUID());
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const nativeRoot = join(homedir(), '.codex', 'sessions');
    const nativePhysical = await realpath(nativeRoot).catch(e => { if (e.code === 'ENOENT') return nativeRoot; throw e; });
    const nativeFiles = await openFiles([...new Set([nativeRoot, nativePhysical])]);
    for (const s of selected) {
      const paneRoots = panes.filter(p => p[0] === s.tmux).map(p => Number(p[1]));
      s.rootPids = paneRoots;
      const family = new Set(descendants(table, paneRoots).map(p => p.pid));
      s.processIds = [...family];
      if (s.tool === 'codex' && !s.codex_uuid) {
        const found = [...new Set(nativeFiles.filter(f => family.has(f.pid)).map(f => f.path.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1]).filter(Boolean))];
        if (found.length === 1) s.codex_uuid = found[0];
      }
      const screen = (await exec(TMUX, ['capture-pane', '-p', '-e', '-t', s.tmux, '-S', '-10000'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 })).stdout;
      s.originalInputGate = storageRecoveryGate(screen);
      if (nativeIds.has(s.id)) {
        const uuid = nativeIds.get(s.id);
        if (s.tool !== 'codex' || s.codex_uuid && s.codex_uuid !== uuid) throw Error('Explicit native identity conflicts with the live binding');
        const file = pickRolloutByUuid(await codexRolloutFiles(), uuid);
        if (!file) throw Error('Explicit native history is missing');
        const handle = await open(file, 'r');
        let row;
        try {
          const chunks = []; let size = 0, complete = false;
          while (size < 2 * 1024 * 1024) {
            const b = Buffer.alloc(16384), r = await handle.read(b, 0, b.length, size);
            if (!r.bytesRead) { complete = true; break; }
            const part = b.subarray(0, r.bytesRead), end = part.indexOf(10);
            chunks.push(end < 0 ? part : part.subarray(0, end)); size += r.bytesRead;
            if (end >= 0) { complete = true; break; }
          }
          if (!complete) throw Error('Native session header is too large to verify safely');
          // Headers include the harness instructions and often exceed 16 KiB. Never
          // log a malformed fragment, which may contain private conversation context.
          try { row = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { throw Error('Native session header is incomplete or invalid'); }
        }
        finally { await handle.close(); }
        if (row.type !== 'session_meta' || row.payload?.id !== uuid || !sameStoragePath(row.payload.cwd, s.worktree_path || s.project_path)) throw Error('Explicit native history belongs to another workspace');
        s.codex_uuid = uuid; s.explicitNativeIdentity = true;
      }
      if (s.nativeHistoryOnly) assertNativeHistoryProcesses({ roots: paneRoots, family: descendants(table, paneRoots),
        commands: await commandIdentities(descendants(table, paneRoots)), uid: process.getuid(), uuid: s.codex_uuid, openFiles: nativeFiles,
        listeners: await listeningProcesses(descendants(table, paneRoots)) });
      s.screenBackup = join(backup, s.id + '.terminal.txt');
      await writeFile(s.screenBackup, screen, { mode: 0o600 });
    }
    if (job) {
      job.sessions = [...job.sessions.filter(s => !ids.includes(s.id)), ...selected];
      job.processes = job.processes.filter(p => !owned.some(q => p.pid === q.pid && p.started === q.started));
      job.phase = 'freezing';
    }
    else job = { version: 1, kind: 'live-storage-migration', id: randomUUID(), phase: 'freezing',
      blockLaunches: true, createdAt: Date.now(), sessions: selected, processes: [] };
    await save();
    // Freeze roots first, then re-inventory descendants. No newly forked writer escapes the fence.
    for (let round = 0; round < 4; round++) {
      const current = await processes();
      const family = descendants(current, roots);
      if (historyOnly.length) {
        if (family.some(p => table.get(p.pid)?.started !== p.started)) throw Error('Protected coding client process tree changed; run thaw before retrying');
        assertNativeHistoryProcesses({ roots, family, commands: await commandIdentities(family), uid: process.getuid(), uuid: selected[0].codex_uuid,
          listeners: await listeningProcesses(family) });
      }
      const fresh = family.filter(p => !job.processes.some(q => q.pid === p.pid && q.started === p.started));
      if (!fresh.length) break;
      for (const p of fresh) {
        p.wasStopped = p.state.includes('T'); job.processes.push(p); await save();
        if (!p.wasStopped) { try { process.kill(p.pid, 'SIGSTOP'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
      }
      if (round === 3) throw Error('Process tree did not settle; originals are unchanged; run thaw');
    }
    job.phase = 'frozen';
    for (const s of selected) {
      s.phase = 'frozen';
      s.processIds = descendants(new Map(job.processes.map(p => [p.pid, p])), s.rootPids).map(p => p.pid);
    }
    await save();
    console.log(JSON.stringify({ frozen: selected.map(s => s.id), processes: job.processes.length,
      journal: storageMaintenanceFile, originalsPreserved: true }));
  } else if (operation === 'park') {
    if (!job || !ids.length) throw Error('Select already-frozen sessions to park');
    for (const sid of ids) {
      const s = job.sessions.find(s => s.id === sid);
      if (!s || !['frozen', 'parking'].includes(s.phase)) throw Error('Session is not frozen: ' + sid);
      await park(s);
    }
  } else {
    if (!job) throw Error('No maintenance freeze to thaw');
    const selected = ids.length ? job.sessions.filter(s => ids.includes(s.id)) : job.sessions;
    if (ids.some(id => !selected.some(s => s.id === id))) throw Error('Unknown maintenance session');
    const selectedPids = new Set(selected.flatMap(s => s.processIds || []));
    const restarted = [];
    for (const s of selected.filter(s => s.phase === 'frozen')) {
      const tty = (await exec('/bin/ps', ['-p', s.rootPids.join(','), '-o', 'tty=']).catch(() => ({ stdout: '' }))).stdout.trim();
      if (tty.split(/\s+/).some(value => value && value !== '??' && value !== '-')) await park(s);
    }
    for (const s of selected.filter(s => ['parking', 'parked', 'resuming'].includes(s.phase))) {
      const current = session(s.id);
      if (current && ['working', 'waiting'].includes(current.desired_status) && !/^operator-/.test(current.status_reason || '')) {
        s.phase = 'resuming'; await save();
        const result = await request(s, 'resume');
        s.resumedTmux = result.tmux; await save();
        if (result.input_ready !== true && !result.restored_existing_gate) throw Error(`${s.id} is loading its exact conversation; maintenance remains fenced. Retry thaw to check readiness, not to send input.`);
        s.restoredExistingGate = result.restored_existing_gate || null;
        restarted.push(s.id);
      }
      s.phase = 'complete'; await save();
    }
    const table = await processes();
    for (const p of job.processes) {
      if (!selectedPids.has(p.pid) || p.wasStopped || table.get(p.pid)?.started !== p.started) continue;
      try { process.kill(p.pid, 'SIGCONT'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    for (const s of selected) s.phase = 'complete';
    if (job.sessions.every(s => s.phase === 'complete')) { job.phase = 'complete'; job.completedAt = Date.now(); }
    await save();
    console.log(JSON.stringify({ resumed: selected.map(s => s.id), restartedWithExactHistory: restarted }));
  }
} finally { db.close(); }
