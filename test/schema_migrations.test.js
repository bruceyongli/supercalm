import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appliedMigrationIds, applyMigrations } from '../src/migrations.js';
import { CORE_MIGRATIONS } from '../src/schema_migrations.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    tmux TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    direction TEXT NOT NULL,
    source TEXT,
    text TEXT NOT NULL
  );
`);

const first = applyMigrations(db, CORE_MIGRATIONS, { now: () => 1234 });
assert.deepEqual(first, ['0001_sessions_complete_shape', '0002_message_read_state', '0003_attention_dismissals']);
assert(appliedMigrationIds(db).has('0001_sessions_complete_shape'));
assert.equal(db.prepare("SELECT applied_at FROM schema_migrations WHERE id='0001_sessions_complete_shape'").get().applied_at, 1234);
const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name));
assert(sessionColumns.has('revision'));
assert(sessionColumns.has('worktree_path'));
const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
assert(messageColumns.has('read_at'));
assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='attention_dismissals'").get().n, 1);
assert.deepEqual(applyMigrations(db, CORE_MIGRATIONS), [], 'recorded migrations are not re-run');

// Cutover recovers an older handled report even when the service restart already inserted an exact
// unread copy. Changed report text must remain new attention.
{
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, tool TEXT NOT NULL, tmux TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
      direction TEXT NOT NULL, source TEXT, text TEXT NOT NULL
    );
  `);
  applyMigrations(legacy, CORE_MIGRATIONS.slice(0, 2));
  legacy.prepare("INSERT INTO sessions (id,tool,tmux,status,category,started_at,last_activity) VALUES ('s_old','codex','tmx','waiting','review',1,1)").run();
  legacy.prepare("INSERT INTO messages (session_id,ts,direction,source,text,read_at) VALUES ('s_old',1,'out','detect','same report',10)").run();
  legacy.prepare("INSERT INTO messages (session_id,ts,direction,source,text) VALUES ('s_old',2,'out','detect','same report')").run();
  assert.deepEqual(applyMigrations(legacy, CORE_MIGRATIONS.slice(2)), ['0003_attention_dismissals']);
  const recovered = legacy.prepare("SELECT * FROM attention_dismissals WHERE session_id='s_old'").get();
  assert.equal(recovered.report_id, 2);
  assert.equal(recovered.dismissed_at, 10);
  assert.equal(legacy.prepare('SELECT read_at FROM messages WHERE id=2').get().read_at, 10);
}

await assert.rejects(
  async () => applyMigrations(db, [{
    id: '9999_failure_is_atomic',
    description: 'intentional failure',
    up(conn) {
      conn.exec('CREATE TABLE should_rollback (id INTEGER)');
      throw new Error('stop');
    },
  }]),
  /schema migration 9999_failure_is_atomic failed/,
);
assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='should_rollback'").get().n, 0);
assert(!appliedMigrationIds(db).has('9999_failure_is_atomic'));

console.log('schema_migrations.test ok');
