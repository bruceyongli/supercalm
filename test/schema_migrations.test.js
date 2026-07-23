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
assert.deepEqual(first, ['0001_sessions_complete_shape', '0002_message_read_state']);
assert(appliedMigrationIds(db).has('0001_sessions_complete_shape'));
assert.equal(db.prepare("SELECT applied_at FROM schema_migrations WHERE id='0001_sessions_complete_shape'").get().applied_at, 1234);
const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name));
assert(sessionColumns.has('revision'));
assert(sessionColumns.has('worktree_path'));
const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
assert(messageColumns.has('read_at'));
assert.deepEqual(applyMigrations(db, CORE_MIGRATIONS), [], 'recorded migrations are not re-run');

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
