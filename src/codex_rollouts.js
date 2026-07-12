// codex rollout identity — the pure, side-effect-free logic for locating a session's codex transcript.
// Extracted from sessions.js + story_api.js so it can be unit-tested WITHOUT importing those modules
// (which boot the poll loop / tmux keepalive on import). Only node built-ins here — safe to import in a test.
//
// codex writes each conversation to ~/.codex/sessions/**/rollout-<ISO>-<uuid>.jsonl. The <uuid> is the
// conversation id (also what `codex resume <uuid>` takes), and it is INDEPENDENT of the rollout's recorded
// cwd — which is why matching by UUID fixes the operator's case where a session's workspace path (a
// sandboxed dir) differs from its AIOS project path, so cwd-matching found nothing.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const UUID_RX = /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// The conversation UUID embedded in a rollout filename, or null if the name isn't a rollout.
export function rolloutUuidFromName(file) {
  const m = String(file || '').match(UUID_RX);
  return m ? m[1] : null;
}

// The rollout file for a captured UUID: the one whose trailing component is that exact UUID. cwd-independent.
export function pickRolloutByUuid(files, uuid) {
  if (!uuid) return null;
  return (files || []).find((f) => String(f).endsWith(`-${uuid}.jsonl`)) || null;
}

// Every codex rollout file on disk (absolute paths). `baseDir` is overridable for tests; production uses
// the real ~/.codex/sessions. Fail-open per directory — an unreadable subtree is skipped, not fatal.
export async function codexRolloutFiles(baseDir = join(homedir(), '.codex', 'sessions')) {
  const files = [];
  async function walk(dir, depth) {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  }
  await walk(baseDir, 0);
  return files;
}
