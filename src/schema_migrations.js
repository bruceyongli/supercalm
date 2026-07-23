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
  {
    id: '0003_attention_dismissals',
    description: 'Persist report-episode dismissals so the attention queue is shared across devices',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attention_dismissals (
          session_id    TEXT PRIMARY KEY,
          report_id     INTEGER NOT NULL,
          report_hash   TEXT NOT NULL DEFAULT '',
          report_text   TEXT NOT NULL DEFAULT '',
          dismissed_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attention_dismissals_time
          ON attention_dismissals(dismissed_at DESC);

        -- Preserve the operator's existing handled state during the cutover. A latest report is
        -- considered handled when it was already read, or when it is an exact restart-generated copy
        -- of an older read report. Changed report text is deliberately not backfilled: it is new work.
        INSERT OR IGNORE INTO attention_dismissals
          (session_id, report_id, report_hash, report_text, dismissed_at)
        WITH ranked AS (
          SELECT m.*,
                 ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id DESC) AS rn
          FROM messages m
          WHERE m.direction = 'out'
        ),
        candidates AS (
          SELECT latest.session_id,
                 latest.id AS report_id,
                 latest.text AS report_text,
                 COALESCE(
                   latest.read_at,
                   (SELECT MAX(prior.read_at)
                    FROM messages prior
                    WHERE prior.session_id = latest.session_id
                      AND prior.direction = 'out'
                      AND prior.id < latest.id
                      AND prior.text = latest.text
                      AND prior.read_at IS NOT NULL)
                 ) AS dismissed_at
          FROM ranked latest
          JOIN sessions s ON s.id = latest.session_id
          WHERE latest.rn = 1
            AND s.status = 'waiting'
            AND COALESCE(s.category, 'review') != 'working'
        )
        SELECT session_id, report_id, '', report_text, dismissed_at
        FROM candidates
        WHERE dismissed_at IS NOT NULL;

        -- A restart duplicate may itself still be unread. The recovered dismissal boundary owns all
        -- reports through that point, matching the normal explicit-dismiss API.
        UPDATE messages
        SET read_at = (
          SELECT d.dismissed_at
          FROM attention_dismissals d
          WHERE d.session_id = messages.session_id
        )
        WHERE direction = 'out'
          AND read_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM attention_dismissals d
            WHERE d.session_id = messages.session_id
              AND messages.id <= d.report_id
          );
      `);
    },
  },
];
