import { db, getSession, getProject, updateSession } from './store.js';
import { attentionUnreadCount, getLatestAttentionReport } from './attention_store.js';
import { EXECUTION_NODE, remoteSession, migrationError } from './execution_identity.js';
import { bus } from './bus.js';
import { sessionStatusPayload } from './session_projection.js';

const SESSION_TABLES = ['messages', 'events', 'decisions', 'agent_grants', 'supervisor_reviews',
  'session_limits', 'preflight_specs', 'session_maps', 'composer_drafts'];
const PROJECT_TABLES = ['project_helpers', 'project_context'];
const columns = table => db.prepare(`PRAGMA table_info("${table}")`).all();
export function insertKnownRow(table, row, { omit = [], ignore = false } = {}) {
  const names = columns(table).map(c => c.name).filter(name => Object.hasOwn(row, name) && !omit.includes(name));
  if (!names.length) return null;
  return db.prepare(`INSERT ${ignore ? 'OR IGNORE' : ''} INTO "${table}" (${names.map(n => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    .run(...names.map(n => row[n]));
}
export function exportExecutionState(sid) {
  const session = getSession(sid);
  if (!session || remoteSession(session)) throw migrationError('Session is not local to this device');
  const project = getProject(session.project_id);
  const tables = {};
  for (const name of SESSION_TABLES) {
    if (!columns(name).some(c => c.name === 'session_id')) continue;
    tables[name] = db.prepare(`SELECT * FROM "${name}" WHERE session_id=?`).all(sid);
  }
  const projectTables = {};
  for (const name of PROJECT_TABLES) {
    if (!columns(name).some(c => c.name === 'project_id')) continue;
    projectTables[name] = db.prepare(`SELECT * FROM "${name}" WHERE project_id=?`).all(session.project_id);
  }
  return { session, project, tables, projectTables };
}
export function importExecutionState(data, { cwd, projectPath, transcript, operation, kind = 'move' }) {
  const existing = getSession(data.session.id);
  if (existing) {
    if (existing.execution_transfer !== operation || !existing.execution_dormant) throw migrationError('The destination already has this session', 'execution-session-conflict');
    return db.prepare('SELECT remote_id local_id, local_id remote_id FROM execution_message_map WHERE node=?').all('import:' + operation);
  }
  const mapping = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!getProject(data.project.id)) insertKnownRow('projects', { ...data.project, path: projectPath, execution_node: EXECUTION_NODE });
    insertKnownRow('sessions', { ...data.session, execution_node: EXECUTION_NODE, execution_checkout: 1,
      execution_dormant: 1, execution_transfer: operation, execution_revision: null, worktree_path: cwd,
      claude_transcript: transcript || null, tmux: `aios-node-${data.session.id}`, status: 'exited',
      desired_status: 'exited', runtime_status: 'exited', status_reason: 'execution-staged',
      // Worker credentials remain on the controller; CLI traffic uses its existing model gateway.
      codex_via_proxy: data.session.tool === 'codex' ? 1 : data.session.codex_via_proxy });
    for (const name of SESSION_TABLES) {
      const cols = columns(name);
      if (!cols.length) continue;
      const generatedId = cols.find(c => c.name === 'id' && c.type === 'INTEGER' && c.pk);
      for (const row of data.tables?.[name] || []) {
        if (row.session_id !== data.session.id) throw migrationError('Cross-session state in migration');
        const result = insertKnownRow(name, row, { omit: generatedId ? ['id'] : [] });
        if (name === 'messages' && result) {
          const remoteId = Number(result.lastInsertRowid);
          mapping.push({ local_id: row.id, remote_id: remoteId });
          db.prepare('INSERT INTO execution_message_map(node,remote_id,local_id) VALUES(?,?,?)').run('import:' + operation, row.id, remoteId);
        }
      }
    }
    for (const name of PROJECT_TABLES) {
      for (const row of data.projectTables?.[name] || []) {
        if (row.project_id !== data.project.id) throw migrationError('Cross-project state in migration');
        insertKnownRow(name, row, { ignore: true });
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return mapping;
}

// The controller retains the original history and maps each worker message once.
// Original message times and dismissal/read state are never reset by polling/reconnect.
export function mirrorExecutionSnapshot(node, snapshot) {
  if (snapshot.protocol !== 1 || snapshot.node !== node.id) throw Error('Wrong execution device identity');
  const changed = new Map();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const project of snapshot.projects || []) {
      if (!getProject(project.id)) insertKnownRow('projects', { ...project, execution_node: node.id });
    }
    for (const row of snapshot.sessions || []) {
      const existing = getSession(row.id);
      // Never steal a local session or a different worker's identity via observation.
      if (existing && existing.execution_node !== node.id) continue;
      if (existing?.execution_revision != null && existing.execution_revision >= row.revision) continue;
      const patch = { ...row, execution_node: node.id, execution_revision: row.revision };
      if (existing) {
        // Once handed off, native worker revisions are authoritative on BOTH the
        // direct HTTP/SSE path and the mirrored home feed. Incrementing another
        // controller revision here would make fresh worker events look stale.
        const names = columns('sessions').map(c=>c.name).filter(name=>name !== 'id' && Object.hasOwn(patch,name));
        db.prepare(`UPDATE sessions SET ${names.map(name=>`"${name}"=?`).join(',')} WHERE id=?`).run(...names.map(name=>patch[name]),row.id);
      }
      else insertKnownRow('sessions', patch);
      changed.set(row.id, { row: getSession(row.id), previous: existing?.status || null });
    }
    for (const row of snapshot.messages || []) {
      const session = getSession(row.session_id);
      if (session?.execution_node !== node.id) continue;
      const mapped = db.prepare('SELECT local_id FROM execution_message_map WHERE node=? AND remote_id=?').get(node.id, row.id);
      if (mapped) {
        // The controller owns cross-device read/dismiss state. A stale worker
        // snapshot is never permission to undo a controller Restore decision.
        continue;
      }
      // A native accepted input can match a previously recorded controller idempotency receipt.
      const prior = row.client_message_id && db.prepare('SELECT id FROM messages WHERE session_id=? AND client_message_id=?').get(row.session_id, row.client_message_id);
      const localId = prior?.id || Number(insertKnownRow('messages', row, { omit: ['id'] }).lastInsertRowid);
      db.prepare('INSERT INTO execution_message_map(node,remote_id,local_id) VALUES (?,?,?)').run(node.id, row.id, localId);
      if (row.direction === 'in') db.prepare("UPDATE messages SET read_at=COALESCE(read_at,?) WHERE session_id=? AND direction='out' AND id<?")
        .run(row.ts, row.session_id, localId);
      // A genuinely new report/input starts a new attention episode. Polling an
      // already-mapped report must never resurrect a dismissal on another device.
      db.prepare('DELETE FROM attention_dismissals WHERE session_id=? AND report_id<?').run(row.session_id, localId);
      if (!changed.has(row.session_id)) changed.set(row.session_id, { row: session, previous: session.status });
    }
    db.prepare(`INSERT INTO execution_sync(node,cursor,checked_at,online,error,health) VALUES(?,?,?,1,NULL,?)
      ON CONFLICT(node) DO UPDATE SET cursor=excluded.cursor,checked_at=excluded.checked_at,online=1,error=NULL,health=excluded.health`)
      .run(node.id, snapshot.cursor, Date.now(), JSON.stringify(snapshot.health || null));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  for (const { row, previous } of changed.values()) {
    const last = getLatestAttentionReport(row.id);
    bus.emit('session-status', sessionStatusPayload({ ...row, project: getProject(row.project_id) }, {
      previousStatus: previous, source: 'execution-device', extra: { unread: attentionUnreadCount(row.id),
        last_key: last ? { id: last.id, text: last.text, ts: last.ts } : null } }));
  }
  if (changed.size || snapshot.messages?.length) bus.emit('changed');
  return changed.size;
}
