// Evidence-snapshot persistence — the substrate for a future verify-REPLAY optimizer. The answer rubric is
// optimizable because `decisions.response` lets us replay each ask through a candidate prompt and score it.
// The verify path had no equivalent: we never stored the EVIDENCE a sign-off saw, so we couldn't replay
// "would a candidate SYS_VERIFY have caught this?" This persists exactly that — the evidence text the verify
// model saw at each COMPLETE — keyed by (session_id, work_fp) so it JOINS the verify-LABEL generated later
// when that sign-off is re-opened (false_complete vs correct). Snapshot (input) + label (target) = one
// training example for the verify optimizer. Server-free so that optimizer can import it. Screenshots are
// NOT stored (too heavy) — only a had_screenshot flag; text-replay is most of the signal (a known limit for
// purely-visual gates). Sign-offs are infrequent, so per-COMPLETE storage stays small.

import { db } from '../store.js';
import { now, id as genId } from '../util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS verify_snapshots (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    work_fp        TEXT,
    git_sha        TEXT,
    evidence_text  TEXT,
    had_screenshot INTEGER NOT NULL DEFAULT 0,
    verdict        TEXT,
    score          INTEGER,
    created_at     INTEGER
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_verify_snapshots_key ON verify_snapshots(session_id, work_fp)');

const MAX_EVIDENCE = 32000;
const _insert = db.prepare('INSERT INTO verify_snapshots (id,session_id,work_fp,git_sha,evidence_text,had_screenshot,verdict,score,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
const _dupe = db.prepare('SELECT id FROM verify_snapshots WHERE session_id = ? AND work_fp = ? LIMIT 1');
const _get = db.prepare('SELECT * FROM verify_snapshots WHERE session_id = ? AND work_fp = ? ORDER BY created_at DESC LIMIT 1');

// Persist the exact evidence a sign-off verify saw. One per (session, signed-off work-state); idempotent.
export function recordVerifySnapshot({ session_id, work_fp, git_sha, evidenceText, hadScreenshot, verdict, score }) {
  if (!session_id || !work_fp) return;
  try {
    if (_dupe.get(session_id, work_fp)) return;
    _insert.run(genId('vs'), session_id, work_fp, git_sha || null, String(evidenceText || '').slice(0, MAX_EVIDENCE), hadScreenshot ? 1 : 0, verdict || null, score ?? null, now());
  } catch {}
}

export function getVerifySnapshot(session_id, work_fp) {
  try { return _get.get(session_id, work_fp) || null; } catch { return null; }
}
