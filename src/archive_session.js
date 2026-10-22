// Read-only production inspection for explicit operator maintenance. Never imports store.js.
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { DB_PATH, TMUX } from './config.js';
const exec = promisify(execFile);
export async function inactiveArchiveSession(id) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let session, project;
  try {
    session = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!session || !['exited', 'error'].includes(session.status) || session.desired_status !== 'exited'
      || session.runtime_status !== 'exited') throw new Error('Only fully stopped sessions can be migrated');
    if (db.prepare("SELECT 1 FROM sessions WHERE parent_session_id=? AND (COALESCE(desired_status,'')!='exited' OR COALESCE(runtime_status,'')!='exited') LIMIT 1").get(id)) throw new Error('Session has a live or recovering child');
    project = db.prepare('SELECT * FROM projects WHERE id=?').get(session.project_id);
    if (!project) throw new Error('Session project is unavailable');
    if (session.worktree_path && db.prepare('SELECT 1 FROM sessions WHERE id!=? AND worktree_path=? LIMIT 1').get(id, session.worktree_path)) throw new Error('Worktree is shared by another session');
  } finally { db.close(); }
  const proxy = resolve(join(homedir(), 'proxy'));
  const repo = await realpath(project.path);
  if (repo === proxy || repo.startsWith(proxy + '/')) throw new Error('Shared proxy fleet is protected');
  let names;
  try { names = (await exec(TMUX, ['list-sessions', '-F', '#{session_name}'], { timeout: 5000 })).stdout.trim().split('\n'); }
  catch (error) {
    if (error.code === 1 && /no server running|No such file or directory/.test(error.stderr || '')) names = [];
    else throw new Error('Cannot verify terminal state; migration refused');
  }
  if (names.includes(session.tmux)) throw new Error('Session terminal still exists');
  return { session, project: { ...project, path: repo } };
}
