#!/usr/bin/env node
// Explicit operator migration driver. All mutations use the normal handoff API;
// the production DB is inventory-only. Re-running resumes the exact recorded ops.
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DB_PATH } from '../src/config.js';

const [projectId, device, ...flags] = process.argv.slice(2);
if (!/^p_[a-zA-Z0-9_-]+$/.test(projectId || '') || !/^[a-z][a-z0-9_-]{0,39}$/.test(device || '') || device === 'local'
  || flags.some(f => !['--stop-active', '--preserve-history'].includes(f))) throw Error('Usage: AIOS_DATA=... node bin/move-execution-project.mjs PROJECT DEVICE [--stop-active] [--preserve-history]');
const root = join(homedir(), '.local/share/aios/execution-moves');
await mkdir(root, { recursive: true, mode: 0o700 });
const file = join(root, `${projectId}-${device}.json`);
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const project = db.prepare('SELECT id,name FROM projects WHERE id=?').get(projectId);
if (!project) throw Error('No such project');
const sessions = db.prepare('SELECT id,title,tool,status,desired_status,execution_node,codex_uuid,claude_transcript,last_activity FROM sessions WHERE project_id=? ORDER BY last_activity DESC').all(projectId);
db.close();
let journal = await readFile(file, 'utf8').then(JSON.parse, e => { if (e.code === 'ENOENT') return null; throw e; });
if (!journal) journal = { version: 1, project: projectId, device, startedAt: Date.now(), sessions: {} };
if (journal.project !== projectId || journal.device !== device) throw Error('Migration journal identity conflict');
const save = async () => { const text = JSON.stringify(journal, null, 2) + '\n'; await writeFile(file + '.tmp', text, { mode: 0o600 }); await rename(file + '.tmp', file); };
const request = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:8793${path}`, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  const result = await res.json(); if (!res.ok) throw Error(result.error || `HTTP ${res.status}`); return result;
};
const devices = await request('/api/execution/devices');
if (!devices.devices.some(d => d.id === device && d.online && !d.local)) throw Error('Destination is not connected');
console.log(JSON.stringify({ project, device, count: sessions.length, journal: file }));
for (const session of sessions) {
  const state = journal.sessions[session.id] ||= { id: session.id, title: session.title, tool: session.tool,
    codexUuid: session.codex_uuid, claudeTranscript: session.claude_transcript, originalStatus: session.status };
  if (session.execution_node === device && state.phase === 'complete') continue;
  if (session.execution_node && session.execution_node !== 'local' && session.execution_node !== device) throw Error('A session is owned by a different worker; not moved implicitly');
  try {
    let operation = (await request(`/api/session/${session.id}/move`)).operation;
    if (state.operation && operation?.id !== state.operation) throw Error('Recorded migration was replaced; inspect before continuing');
    if (operation && operation.node !== device) throw Error('An existing transfer targets another device');
    if (!operation) {
      if (session.status !== 'exited' || session.desired_status !== 'exited') {
        if (!flags.includes('--stop-active')) throw Error('Session is not stopped; --stop-active requires explicit operator authorization');
        await request(`/api/session/${session.id}/stop`, {});
      }
      try { operation = (await request(`/api/session/${session.id}/move`, { device, preserveHistory: flags.includes('--preserve-history') })).operation; }
      catch (error) { operation = (await request(`/api/session/${session.id}/move`)).operation; if (!operation) throw error; }
    } else if (operation.phase === 'failed') {
      await request(`/api/execution/operations/${operation.id}/retry`, {});
    }
    state.operation = operation.id; state.phase = operation.phase; state.error = null; await save();
    console.log(JSON.stringify({ session: session.id, operation: operation.id, phase: 'following' }));
    for (;;) {
      const current = (await request(`/api/session/${session.id}/move`)).operation;
      if (current.id !== state.operation) throw Error('Transfer identity changed');
      if (current.phase !== state.phase || current.bytes !== state.bytes) {
        Object.assign(state, { phase: current.phase, bytes: current.bytes, historyOnly: current.historyOnly, error: current.error, checkedAt: Date.now() });
        await save(); console.log(JSON.stringify({ session: session.id, phase: state.phase, bytes: state.bytes, historyOnly: state.historyOnly }));
      }
      if (current.phase === 'complete') break;
      if (['failed', 'cancelled'].includes(current.phase)) throw Error(current.error || current.phase);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } catch (error) {
    state.phase = 'needs-attention'; state.error = error.message; await save();
    console.log(JSON.stringify({ session: session.id, error: error.message }));
  }
}
const done = sessions.filter(s => journal.sessions[s.id]?.phase === 'complete');
journal.completed = done.length; journal.total = sessions.length; journal.checkedAt = Date.now();
if (done.length === sessions.length) {
  journal.projectOwner = await request(`/api/project/${projectId}/execution-device`, { device });
  journal.completedAt = Date.now();
}
await save();
console.log(JSON.stringify({ completed: done.length, total: sessions.length, historyOnly: done.filter(s => journal.sessions[s.id].historyOnly).length, journal: file }));
if (done.length !== sessions.length) process.exitCode = 1;
