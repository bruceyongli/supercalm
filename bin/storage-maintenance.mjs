#!/usr/bin/env node
// Explicit operator storage maintenance. Freeze/thaw keeps native agents and their conversations
// in memory; no input is sent, and no user Stop/attention/activity state is rewritten.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, DB_PATH, TMUX } from '../src/config.js';
import { durableJson, openFiles } from '../src/storage_migration.js';
import { readStorageMaintenance, storageMaintenanceFile } from '../src/storage_maintenance.js';

const exec = promisify(execFile);
const [operation, ...ids] = process.argv.slice(2);
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
try {
  if (operation === 'freeze') {
    if (job && !['frozen', 'freezing'].includes(job.phase)) throw Error('An unfinished maintenance transition exists; inspect/thaw it first');
    if (ids.some(id => job?.sessions.some(s => s.id === id))) throw Error('A selected session already belongs to this maintenance job');
    const selected = ids.map(id => {
      const s = session(id);
      if (!s || !['working', 'waiting'].includes(s.desired_status) || /\/proxy(?:\/|$)/.test(s.project_path || '')) throw Error('Session is not eligible: ' + id);
      return { id, tmux: s.tmux, token: randomUUID(), phase: 'prepared',
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
    const nativeFiles = await openFiles([join(process.env.HOME, '.codex', 'sessions')]);
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
      s.screenBackup = join(backup, s.id + '.terminal.txt');
      await writeFile(s.screenBackup, screen, { mode: 0o600 });
    }
    if (job) { job.sessions.push(...selected); job.phase = 'freezing'; }
    else job = { version: 1, kind: 'live-storage-migration', id: randomUUID(), phase: 'freezing',
      blockLaunches: true, createdAt: Date.now(), sessions: selected, processes: [] };
    await save();
    // Freeze roots first, then re-inventory descendants. No newly forked writer escapes the fence.
    for (let round = 0; round < 4; round++) {
      const current = await processes();
      const family = descendants(current, roots);
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
      // Persist restart intent BEFORE the terminal can disappear. Thaw can recover an
      // interruption between the server acknowledgement and the final parked checkpoint.
      s.phase = 'parking'; await save();
      await request(s, 'pause');
      const table = await processes();
      for (const p of job.processes.filter(p => s.processIds?.includes(p.pid))) {
        if (table.get(p.pid)?.started !== p.started) continue;
        try { process.kill(p.pid, 'SIGTERM'); process.kill(p.pid, 'SIGCONT'); }
        catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
      s.phase = 'parked'; await save();
      console.log(JSON.stringify({ parked: sid, native: s.codex_uuid || s.claude_transcript, historyPreserved: true }));
    }
  } else {
    if (!job) throw Error('No maintenance freeze to thaw');
    const restarted = [];
    for (const s of job.sessions.filter(s => ['parking', 'parked'].includes(s.phase))) {
      const current = session(s.id);
      if (current && ['working', 'waiting'].includes(current.desired_status) && !/^operator-/.test(current.status_reason || '')) {
        await request(s, 'resume');
        restarted.push(s.id);
      }
      s.phase = 'complete'; await save();
    }
    const table = await processes();
    for (const p of job.processes) {
      if (p.wasStopped || table.get(p.pid)?.started !== p.started) continue;
      try { process.kill(p.pid, 'SIGCONT'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    job.phase = 'complete'; job.completedAt = Date.now(); for (const s of job.sessions) s.phase = 'complete'; await save();
    console.log(JSON.stringify({ resumed: job.sessions.map(s => s.id), restartedWithExactHistory: restarted }));
  }
} finally { db.close(); }
