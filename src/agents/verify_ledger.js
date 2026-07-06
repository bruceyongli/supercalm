// Verification ledger (#2) — the supervisor's MEMORY of what it has already proven, so it stops
// re-verifying settled, unrelated work (wasting tokens + nagging the agent) without ever SKIPPING what's
// new. Each time a verify judges the work COMPLETE, we append what was confirmed met, the git SHA, the
// evidence kind (tests / screenshot / diff), and the code scope. On the next verify, these prior records
// are fed back so the model can reason — per the operator: this needs a powerful model + context + memory,
// not a timer rule. The model decides which prior proof is still valid (solid evidence + code the current
// change doesn't touch) vs which must be re-checked (new / changed / prose-only). Server-free.

import { db } from '../store.js';
import { now, id as genId } from '../util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS verify_ledger (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    project_id     TEXT,
    git_sha        TEXT,
    verdict        TEXT,
    score          INTEGER,
    met_summary    TEXT,
    had_tests      INTEGER NOT NULL DEFAULT 0,
    had_screenshot INTEGER NOT NULL DEFAULT 0,
    files_scope    TEXT,
    verified_at    INTEGER
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_verify_ledger_session ON verify_ledger(session_id)');

const _insert = db.prepare('INSERT INTO verify_ledger (id,session_id,project_id,git_sha,verdict,score,met_summary,had_tests,had_screenshot,files_scope,verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const _recent = db.prepare('SELECT * FROM verify_ledger WHERE session_id = ? ORDER BY verified_at DESC LIMIT ?');
const _last = db.prepare('SELECT git_sha, verdict FROM verify_ledger WHERE session_id = ? ORDER BY verified_at DESC LIMIT 1');
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) : t; };

// Append a proven state. Called when a verify judges COMPLETE. Deduped: a back-to-back identical
// (sha,verdict) doesn't add a row (so repeated re-verifies at the same commit don't bloat the ledger).
export function recordVerification({ session, git_sha, verdict, score, assessment, hadTests, hadScreenshot, filesScope }) {
  if (!session?.id) return;
  const last = _last.get(session.id);
  if (last && (last.git_sha || null) === (git_sha || null) && last.verdict === verdict) return;
  _insert.run(genId('vg'), session.id, session.project_id || null, git_sha || null, verdict || null, score ?? null, clip(assessment, 1500), hadTests ? 1 : 0, hadScreenshot ? 1 : 0, clip(filesScope, 1500), now());
}

export function recentVerifications(sessionId, k = 6) {
  return sessionId ? _recent.all(sessionId, k) : [];
}

// Compact block injected into the verify prompt as the "what's already proven" memory.
export function formatLedger(rows) {
  if (!rows?.length) return '';
  return rows
    .map((r, i) => {
      const ev = [r.had_tests && 'tests', r.had_screenshot && 'screenshot'].filter(Boolean).join('+') || 'prose/diff only';
      return `[${i + 1}] @${r.git_sha || '?'} (${new Date(r.verified_at).toISOString().slice(5, 16)}) verdict=${r.verdict} score=${r.score ?? '-'} evidence=${ev}\n  CONFIRMED MET: ${clip(r.met_summary, 420)}\n  code that was in scope: ${clip(r.files_scope, 300)}`;
    })
    .join('\n\n');
}
