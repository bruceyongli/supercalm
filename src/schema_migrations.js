import { ensureColumn } from './migrations.js';

// Core schema changes live here rather than being hidden in feature-module import side effects. Each
// migration is idempotent against pre-ledger production databases: it inspects the actual schema before
// altering it, then records the successful transaction in schema_migrations.
export const CORE_MIGRATIONS = [
  {
    id: '0001_sessions_complete_shape',
    description: 'Bring the sessions table to the complete durable lifecycle shape',
    up(db) {
      const columns = [
        ['autonomy', 'TEXT'],
        ['effort', 'TEXT'],
        ['model', 'TEXT'],
        ['fast_mode', 'INTEGER NOT NULL DEFAULT 0'],
        ['orchestration', 'TEXT'],
        ['summary', 'TEXT'],
        ['category', 'TEXT'],
        ['stage', 'TEXT'],
        ['codex_via_proxy', 'INTEGER NOT NULL DEFAULT 0'],
        ['codex_uuid', 'TEXT'],
        ['claude_transcript', 'TEXT'],
        ['worktree_path', 'TEXT'],
        ['branch', 'TEXT'],
        ['parked', 'INTEGER NOT NULL DEFAULT 0'],
        ['degraded', 'INTEGER NOT NULL DEFAULT 0'],
        ['revision', 'INTEGER NOT NULL DEFAULT 1'],
      ];
      for (const [name, definition] of columns) ensureColumn(db, 'sessions', name, definition);
    },
  },
  {
    id: '0002_message_read_state',
    description: 'Add cross-device message read state and its bounded home-query indexes',
    up(db) {
      ensureColumn(db, 'messages', 'read_at', 'INTEGER');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_in_session_ts
          ON messages(session_id, ts) WHERE direction = 'in';
        CREATE INDEX IF NOT EXISTS idx_messages_unread_out_session_ts
          ON messages(session_id, ts) WHERE direction = 'out' AND read_at IS NULL;
      `);
    },
  },
];
