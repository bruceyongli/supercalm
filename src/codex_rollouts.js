// codex rollout identity — the pure, side-effect-free logic for locating a session's codex transcript.
// Extracted from sessions.js + story_api.js so it can be unit-tested WITHOUT importing those modules
// (which boot the poll loop / tmux keepalive on import). Only node built-ins here — safe to import in a test.
//
// codex writes each conversation to ~/.codex/sessions/**/rollout-<ISO>-<uuid>.jsonl. The <uuid> is the
// conversation id (also what `codex resume <uuid>` takes), and it is INDEPENDENT of the rollout's recorded
// cwd — which is why matching by UUID fixes the operator's case where a session's workspace path (a
// sandboxed dir) differs from its AIOS project path, so cwd-matching found nothing.
import { readdir, open } from 'node:fs/promises';
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

// Recover a missed fresh-launch binding without borrowing the newest same-project conversation.
// All three pieces of persisted launch evidence must agree: cwd, native start time and the actual
// user request (after any AIOS context preamble). Helpers/exec threads and already-owned files are
// excluded. More than one match is ambiguous, so leave the session's private fallback intact.
export async function findCodexLaunchRollout(files, { cwd, startedAt, task, claimed = new Set(), allowEmptyTask = false } = {}) {
  const request = String(task || '').trim();
  if (!cwd || !Number.isFinite(startedAt) || startedAt <= 0 || (!request && !allowEmptyTask)) return null;
  const matches = [];
  for (const file of files || []) {
    const uuid = rolloutUuidFromName(file);
    if (!uuid || claimed.has(uuid)) continue;
    // CLI filenames use local time, while session_meta uses UTC. This is only an IO prefilter;
    // the authoritative timestamp below must be inside the much tighter launch window.
    const dated = String(file).match(/rollout-(\d{4}-\d{2}-\d{2})T/);
    if (dated && Math.abs(Date.parse(dated[1]) - startedAt) > 48 * 3600_000) continue;
    let fh;
    try {
      fh = await open(file, 'r');
      const buffer = Buffer.alloc(512 * 1024);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      const head = JSON.parse(lines[0]);
      const meta = head.payload || head;
      const time = Date.parse(meta.timestamp || head.timestamp);
      if (head.type !== 'session_meta' || (meta.id || meta.session_id) !== uuid || meta.cwd !== cwd
          || !Number.isFinite(time) || time < startedAt - 5000 || time > startedAt + 600_000
          || (meta.source && meta.source !== 'cli')
          || (meta.thread_source && meta.thread_source !== 'user')
          || (meta.originator && !['codex-tui', 'codex_cli_rs'].includes(meta.originator))) continue;
      // Only a launch observer with a before/after inventory may bind a blank-task launch. Story
      // recovery has no such snapshot and must always prove the persisted request as well.
      let ownRequest = !request && allowEmptyTask;
      for (const line of lines.slice(1)) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const p = row.payload;
        let text = null;
        if (row.type === 'event_msg' && p?.type === 'user_message') text = p.message;
        else if (row.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
          text = (p.content || []).filter(c => c.type === 'input_text' || c.type === 'text').map(c => c.text || '').join('\n');
        }
        if (typeof text === 'string' && text.trim().endsWith(request)) { ownRequest = true; break; }
      }
      if (ownRequest) matches.push(file);
      if (matches.length > 1) return null;
    } catch {} finally { await fh?.close(); }
  }
  return matches.length === 1 ? matches[0] : null;
}

// Every codex rollout file on disk (absolute paths). `baseDir` is overridable for tests; production uses
// the real ~/.codex/sessions. Fail-open per directory — an unreadable subtree is skipped, not fatal.
export async function codexRolloutFiles(baseDir = process.env.AIOS_CODEX_SESSIONS_DIR || join(homedir(), '.codex', 'sessions')) {
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
