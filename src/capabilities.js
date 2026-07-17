// CAPABILITY OBJECTS (v4 Phase 2, traceability S1/S6; ARCHITECTURE.md §5): reserved actions are
// unsendable by policy — the ONLY thing that converts a reserved block into an allowed action is a
// scoped capability minted from the operator's own act (a one-tap approval card, or their verbatim
// message id). Authority becomes a consumable object with scope, expiry, and a use count — never an
// LLM's paraphrase ("the operator said push it" is unrepresentable here by construction).
//
// Shape: { id, action, scope, minted_by, expires_at, uses_left }. consume() is atomic single-use
// (BEGIN IMMEDIATE): expired/exhausted/mismatched capabilities never authorize. Kernel wiring
// (reserved block consults consume) lands in the next slice; until then this module is inert.
import { db } from './store.js';
import { id as genId, now } from './util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS capabilities (
    id         TEXT PRIMARY KEY,
    session_id TEXT,
    project_id TEXT,
    action     TEXT NOT NULL,           -- reserved-action class: deploy | credentials | survey | card_lifecycle | git_destructive
    scope      TEXT,                    -- free-form qualifier the minter pins (e.g. a sha, a url); '' = class-wide for the session
    minted_by  TEXT NOT NULL,           -- 'operator_tap' | 'operator_message:<msg_id>'
    expires_at INTEGER NOT NULL,
    uses_left  INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    consumed_log TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_caps_session ON capabilities(session_id, action);
`);

const MAX_TTL_MS = Number(process.env.AIOS_CAPABILITY_MAX_TTL_MS || 60 * 60_000); // 1h hard ceiling

export function mintCapability({ sessionId = null, projectId = null, action, scope = '', mintedBy, ttlMs = 15 * 60_000, uses = 1 } = {}) {
  if (!action) throw new Error('capability needs an action class');
  if (!mintedBy || !/^operator_(tap|message:.+)$/.test(mintedBy)) throw new Error('capabilities are minted only by an operator act (operator_tap | operator_message:<id>)');
  const row = {
    id: genId('cap'),
    session_id: sessionId,
    project_id: projectId,
    action: String(action),
    scope: String(scope || ''),
    minted_by: mintedBy,
    expires_at: now() + Math.min(Math.max(1, ttlMs), MAX_TTL_MS),
    uses_left: Math.max(1, Math.min(5, uses)),
    created_at: now(),
  };
  db.prepare(`INSERT INTO capabilities (id, session_id, project_id, action, scope, minted_by, expires_at, uses_left, created_at)
    VALUES (@id,@session_id,@project_id,@action,@scope,@minted_by,@expires_at,@uses_left,@created_at)`).run(row);
  return getCapability(row.id);
}

export const getCapability = (id) => db.prepare('SELECT * FROM capabilities WHERE id = ?').get(id) || null;

// Atomically consume one use IFF a live, in-scope capability exists for (session, action).
// scopeText: the outbound text/target being authorized — a scoped capability must be a substring
// match (the minter pinned e.g. a sha or branch); ''-scope capabilities cover the whole class.
export function consumeCapability({ sessionId, action, scopeText = '' } = {}) {
  const t = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const cap = db.prepare(`SELECT * FROM capabilities
      WHERE action = ? AND uses_left > 0 AND expires_at > ?
        AND (session_id IS NULL OR session_id = ?)
      ORDER BY created_at DESC`).all(action, t, sessionId || '')
      .find((c) => !c.scope || String(scopeText || '').includes(c.scope));
    if (!cap) { db.exec('ROLLBACK'); return null; }
    const log = JSON.parse(cap.consumed_log || '[]');
    log.push({ at: t, sessionId, scopeText: String(scopeText || '').slice(0, 160) });
    db.prepare('UPDATE capabilities SET uses_left = uses_left - 1, consumed_log = ? WHERE id = ? AND uses_left > 0')
      .run(JSON.stringify(log), cap.id);
    db.exec('COMMIT');
    return { ...cap, uses_left: cap.uses_left - 1 };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
