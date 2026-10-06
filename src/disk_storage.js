// On-demand, single-flight inventory. Native du runs off the HTTP/event loop, with bounded
// concurrency/timeouts; polling Health never rescans the filesystem every 30 seconds.
import { lstat, realpath } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR, LOG_DIR, ROOT, DB_PATH } from './config.js';
import { worktreeRoot } from './worktrees.js';
import { sessionStoragePaths } from './session_storage.js';
import { currentDiskCapacity } from './disk_pressure.js';
import * as store from './store.js';

const exec = promisify(execFile);
export const isInside = (path, root) => path === root || path.startsWith(root + sep);
const SID = /^s_[a-zA-Z0-9_-]+$/;

// Header metadata only: never scan records, compact, checkpoint, or promise these pages as savings.
export function databaseStorage() {
  try {
    const value = name => Number(Object.values(store.db.prepare(`PRAGMA ${name}`).get())[0]);
    const pageSize = value('page_size'), pages = value('page_count'), free = value('freelist_count');
    const file = statSync(DB_PATH);
    let wal = null;
    try { wal = statSync(`${DB_PATH}-wal`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { file_bytes: file.size, wal_bytes: wal?.size || 0,
      allocated_bytes: (file.blocks + (wal?.blocks || 0)) * 512,
      reusable_bytes: free * pageSize, occupied_page_bytes: (pages - free) * pageSize };
  } catch (error) { return { error: String(error.message || error) }; }
}
export function storageComponents(session, project) {
  if (!SID.test(session.id)) return [];
  const paths = sessionStoragePaths(session.id);
  const base = session.worktree_path || project?.path || ROOT;
  return [
    { kind: 'logs', label: 'Terminal log', path: join(LOG_DIR, `${session.id}.log`), base: LOG_DIR },
    { kind: 'scratch', label: 'Temporary files', path: paths.root, base: join(DATA_DIR, 'session-storage') },
    { kind: 'browser-cache', label: 'Supervisor browser cache', path: join(DATA_DIR, 'supervisor', session.id, 'profile'), base: join(DATA_DIR, 'supervisor', session.id) },
    { kind: 'screenshots', label: 'Saved review screenshots', path: join(DATA_DIR, 'supervisor', session.id), base: join(DATA_DIR, 'supervisor') },
    { kind: 'launch', label: 'Launch script', path: join(DATA_DIR, 'launch', `${session.id}.sh`), base: join(DATA_DIR, 'launch') },
    { kind: 'artifacts', label: 'Saved outputs', path: paths.artifacts, base: join(DATA_DIR, 'session-artifacts') },
    { kind: 'attachments', label: 'Uploads', path: join(base, '.aios', 'attachments', session.id), base, attachment: true },
    ...(session.worktree_path ? [{ kind: 'worktree', label: 'Git worktree', path: session.worktree_path, base: worktreeRoot() }] : []),
    ...(session.claude_transcript ? [{ kind: 'native', label: 'Native CLI history (retained)', path: session.claude_transcript, retained: true }] : []),
  ];
}

const lastKill = store.db.prepare("SELECT type FROM events WHERE session_id=? AND type IN ('kill','stop','launch','resume') ORDER BY id DESC LIMIT 1");
export function cleanupEligibility(session) {
  if (session.status !== 'exited') return { cleanable: false, deletable: false, reason: 'Session is not stopped' };
  if (['starting', 'working', 'waiting'].includes(session.desired_status)
      || ['starting', 'running', 'recovering', 'stopping'].includes(session.runtime_status)) {
    return { cleanable: false, deletable: false, reason: 'Session is awaiting recovery or still stopping' };
  }
  const killed = session.status_reason === 'operator-kill'
    || (!session.status_reason?.startsWith('operator-') && lastKill.get(session.id)?.type === 'kill');
  return { cleanable: true, deletable: killed, reason: killed ? 'Killed by operator' : 'Stopped; history is resumable' };
}

export async function measureStoragePath(path) {
  if (!path || !String(path).startsWith(sep) || [sep, resolve(homedir())].includes(resolve(path))) return { bytes: 0, error: 'Broad or invalid path is not scanned' };
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { bytes: 0, error: 'Symlink is not traversed' };
    if (!info.isDirectory()) return { bytes: info.blocks * 512, logical_bytes: info.size };
    const result = await exec('du', ['-sk', path], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 65536 });
    const blocks = Number(String(result.stdout).match(/^\s*(\d+)/)?.[1]);
    if (!Number.isFinite(blocks)) throw new Error('Invalid disk usage result');
    return { bytes: blocks * 1024 };
  } catch (error) { return { bytes: 0, ...(error.code === 'ENOENT' ? { missing: true } : { error: String(error.message || error).slice(0, 180) }) }; }
}

// Assign nested paths to their most specific owner: project source never counts its own sessions
// twice, and an aggregate project does not count a nested registered project a second time.
export function exclusiveStorageRows(rows) {
  const sorted = rows.slice().sort((a, b) => a.path.length - b.path.length);
  const parents = new Map();
  for (const row of sorted) {
    const parent = sorted.filter(other => other !== row && isInside(row.path, other.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (parent) parents.set(row.path, parent.path);
  }
  return rows.map(row => ({ ...row, exclusive_bytes: Math.max(0, row.bytes - rows
    .filter(child => parents.get(child.path) === row.path).reduce((n, child) => n + child.bytes, 0)) }));
}

export function createStorageInventory({ projects = store.listProjects, sessions = store.listSessions,
  measure = measureStoragePath, canonical = path => realpath(path).catch(() => resolve(path)), ttl = 15 * 60_000 } = {}) {
  let cache = null, flight = null, scanned = 0, total = 0, generation = 0, error = null;
  async function scan() {
    const ps = projects(), ss = sessions(), byProject = new Map(ps.map(p => [p.id, p]));
    const targets = new Map();
    const add = async row => {
      const path = await canonical(row.path);
      if (!targets.has(path)) targets.set(path, { ...row, path });
    };
    // Specific ownership wins over shared storage roots.
    for (const s of ss) for (const c of storageComponents(s, byProject.get(s.project_id))) await add({ ...c, session_id: s.id, project_id: s.project_id, role: 'session' });
    for (const p of ps) await add({ path: p.path, project_id: p.id, role: 'project' });
    for (const [label, path] of [['AIOS shared data / database', DATA_DIR], ['Unattributed worktrees', worktreeRoot()],
      ['Claude CLI history', join(homedir(), '.claude', 'projects')], ['Codex CLI history', join(homedir(), '.codex', 'sessions')]]) await add({ label, path, role: 'shared' });
    const rows = [...targets.values()];
    total = rows.length; scanned = 0;
    let next = 0;
    await Promise.all([0, 1].map(async () => {
      while (next < rows.length) {
        const row = rows[next++];
        Object.assign(row, await measure(row.path)); scanned++;
      }
    }));
    const owned = exclusiveStorageRows(rows);
    const sessionRows = ss.map(s => {
      const components = owned.filter(row => row.session_id === s.id);
      const eligibility = cleanupEligibility(s);
      return { id: s.id, project_id: s.project_id, project: byProject.get(s.project_id)?.name || '(unregistered)',
        title: s.title || s.id, tool: s.tool, status: s.status, ended_at: s.ended_at, last_activity: s.last_activity,
        ...eligibility, bytes: components.reduce((n, c) => n + c.exclusive_bytes, 0),
        disposable_bytes: eligibility.cleanable ? components.filter(c => ['logs', 'scratch', 'browser-cache', 'launch'].includes(c.kind)).reduce((n, c) => n + c.exclusive_bytes, 0) : 0,
        output_bytes: components.filter(c => ['artifacts', 'attachments', 'screenshots'].includes(c.kind)).reduce((n, c) => n + c.exclusive_bytes, 0),
        worktree_bytes: components.filter(c => c.kind === 'worktree').reduce((n, c) => n + c.exclusive_bytes, 0), components };
    }).sort((a, b) => b.bytes - a.bytes);
    const projectRows = ps.map(p => ({ id: p.id, name: p.name, path: p.path,
      source_bytes: owned.filter(r => r.project_id === p.id && r.role === 'project').reduce((n, r) => n + r.exclusive_bytes, 0),
      session_bytes: sessionRows.filter(s => s.project_id === p.id).reduce((n, s) => n + s.bytes, 0),
      session_count: ss.filter(s => s.project_id === p.id).length,
      stopped_count: sessionRows.filter(s => s.project_id === p.id && s.cleanable).length,
      disposable_bytes: sessionRows.filter(s => s.project_id === p.id).reduce((n, s) => n + s.disposable_bytes, 0) }));
    projectRows.sort((a, b) => b.source_bytes + b.session_bytes - a.source_bytes - a.session_bytes);
    return { scanned_at: Date.now(), projects: projectRows, sessions: sessionRows,
      shared: owned.filter(row => row.role === 'shared'),
      total_bytes: owned.reduce((n, row) => n + row.exclusive_bytes, 0),
      disposable_bytes: sessionRows.reduce((n, s) => n + s.disposable_bytes, 0),
      errors: rows.filter(row => row.error).map(({ path, error }) => ({ path, error })),
      accounting: 'Allocated blocks; nested scopes counted once. APFS clones/hardlinks may share blocks. Native history and SQLite size are not promised as cleanup savings.' };
  }
  return {
    get({ refresh = false } = {}) {
      if (!flight && (refresh || !cache || Date.now() - cache.scanned_at > ttl)) {
        const token = generation;
        flight = scan().then(result => { if (generation === token) { cache = result; error = null; } })
          .catch(e => { error = String(e.message || e); }).finally(() => { flight = null; });
      }
      return { state: flight ? 'scanning' : error ? 'error' : 'ready', progress: { scanned, total }, error,
        ...(cache || { projects: [], sessions: [], shared: [] }), capacity: currentDiskCapacity(), database: databaseStorage() };
    },
    invalidate() { generation++; cache = null; },
    async settled() { await flight; return this.get(); },
  };
}

export const storageInventory = createStorageInventory();
