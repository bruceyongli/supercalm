// Reopening a CLI replays history and startup chrome. Only native work (not file mtime),
// an operator action or a real lifecycle hook may release a restored waiting session.
import { open } from 'node:fs/promises';
import { codexRolloutFiles, pickRolloutByUuid } from './codex_rollouts.js';
import { findClaudeLog, claudeResumeId } from './claude_transcripts.js';
import { claudeActivityRecord } from './claude_activity.js';

let inventory = [], inventoryAt = 0, inventoryFlight = null;
const cache = new Map();
export function nativeWorkTimestamp(row, session, at = Date.now()) {
  if (session.tool === 'claude') return claudeActivityRecord(row, claudeResumeId(session.claude_transcript), at)?.ts || 0;
  if (session.tool !== 'codex') return 0;
  const ts = Date.parse(row?.timestamp), p = row?.payload;
  if (!Number.isFinite(ts) || ts <= 0 || ts > at + 60000) return 0;
  if (row.type === 'response_item' && (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(p?.type)
      || p?.type === 'message' && ['user', 'assistant'].includes(p.role))) return ts;
  return row.type === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning', 'task_complete'].includes(p?.type) ? ts : 0;
}

export async function nativeWorkActivity(session, { file = null } = {}) {
  if (!file && session.tool === 'claude' && session.claude_transcript) file = await findClaudeLog(null, session);
  if (!file && session.tool === 'codex' && session.codex_uuid) {
    if (Date.now() - inventoryAt > 30000) {
      inventoryFlight ||= codexRolloutFiles().then(files => { inventory = files; inventoryAt = Date.now(); }).finally(() => { inventoryFlight = null; });
      await inventoryFlight;
    }
    file = pickRolloutByUuid(inventory, session.codex_uuid);
  }
  if (!file) return { available: false, lastAt: 0 };
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return { available: false, lastAt: 0 };
  try {
    const st = await fh.stat(), key = `${session.tool}:${session.codex_uuid || session.claude_transcript}:${file}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (cache.has(key)) return cache.get(key);
    const start = Math.max(0, st.size - 256 * 1024), buffer = Buffer.alloc(st.size - start);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
    let lastAt = 0;
    if (end >= 0) for (const line of buffer.subarray(start ? buffer.indexOf(10) + 1 : 0, end).toString('utf8').split('\n')) {
      try { lastAt = Math.max(lastAt, nativeWorkTimestamp(JSON.parse(line), session)); } catch {}
    }
    const result = { available: true, lastAt };
    cache.set(key, result); if (cache.size > 200) cache.delete(cache.keys().next().value);
    return result;
  } finally { await fh.close(); }
}

export function restoringWaiting(entry, session, nativeAt = 0) {
  if (!entry.restoredWaitingSince) return false;
  // Also notice work completed while the service was down, before adoption began. Comparing only
  // with the current boot time would incorrectly freeze that real background work as idle.
  if (session.status !== 'waiting' || Number(session.last_activity) > entry.restoredWaitingSince
      || nativeAt > (Number(session.last_activity) || entry.restoredWaitingSince)) {
    delete entry.restoredWaitingSince;
    return false;
  }
  return true;
}
