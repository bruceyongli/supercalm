// src/claude_transcripts.js — locate a claude session's native transcript (~/.claude/projects/<slug>/*.jsonl).
// Extracted from story_api.js so the picker is unit-testable without importing route modules
// (same pattern as codex_rollouts.js).
//
// Why (v0.3.131): the old picker was "any .jsonl in the cwd's project dir touched since session start
// − 2min, largest wins". With several live claude sessions in ONE cwd, every session's story rendered
// the biggest transcript — three concurrent sessions all showed the same (183MB) conversation.
// Selection order now:
//   1. sessions.claude_transcript — the path claude itself reported in its hook payloads (exact
//      identity, self-healing on every hook event). Wins even outside the slug dir (cwd moves).
//   2. Heuristic, minus transcripts OTHER sessions have bound (theirs, never ours):
//      a. files CREATED within the session's launch window (a fresh launch writes its JSONL at the
//         first prompt, which the task auto-submit sends immediately) — largest of those;
//      b. else the legacy pool (mtime ≥ started_at − 2min), largest wins — resumed sessions keep
//         appending to one long-lived file, which this tier still finds.
//   If everything is claimed by other sessions → null, and the story falls back to the messages-table
//   spine, which is honestly attributed — better an sparser story than someone else's.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function claudeSlug(cwd) { return String(cwd || '').replace(/[/.]/g, '-'); }

const BIRTH_EARLY_MS = 120e3; // transcript may predate the session row by a hair (launch ordering)
const BIRTH_LATE_MS = 600e3;  // first prompt lands well within 10min of launch

// Pure ranking over stat'd candidates [{p,size,mtimeMs,birthtimeMs}]. birthtimeMs may be 0 on
// filesystems without creation time — such files simply never qualify for the fresh tier.
export function pickClaudeTranscript(cands, s, { claimed } = {}) {
  const taken = claimed instanceof Set ? claimed : new Set(claimed || []);
  const open = (cands || []).filter((c) => c && c.p && !taken.has(c.p));
  const t0 = Number(s?.started_at) || 0;
  const fresh = t0
    ? open.filter((c) => (c.birthtimeMs || 0) >= t0 - BIRTH_EARLY_MS && (c.birthtimeMs || 0) <= t0 + BIRTH_LATE_MS)
    : [];
  const pool = fresh.length ? fresh : open.filter((c) => !t0 || c.mtimeMs >= t0 - BIRTH_EARLY_MS);
  return pool.slice().sort((a, b) => b.size - a.size)[0]?.p || null;
}

export async function findClaudeLog(cwd, s, { claimed } = {}) {
  const bound = s?.claude_transcript;
  if (bound) {
    try { if ((await stat(bound)).isFile()) return bound; } catch {} // stale binding → heuristic
  }
  const dir = join(homedir(), '.claude', 'projects', claudeSlug(cwd));
  let ents;
  try { ents = await readdir(dir); } catch { return null; }
  const cands = [];
  for (const name of ents) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(dir, name);
    try {
      const st = await stat(p);
      cands.push({ p, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || 0 });
    } catch {}
  }
  return pickClaudeTranscript(cands, s, { claimed });
}
