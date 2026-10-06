// Claude activity is native conversation progress, not terminal repaint or JSONL file mtime.
// Read complete records in a bounded delta; do not parse whole transcripts on the HTTP thread.
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { claudeResumeId } from './claude_transcripts.js';
import { claudeQueuedUser, claudeSystemInput } from './claude_lifecycle.js';

const MAX_BYTES = 256 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n\n') : '';

export function claudeActivityRecord(row, nativeId, at = Date.now()) {
  if (!row || row.isSidechain || row.agentId || (nativeId && (row.sessionId || row.session_id)
      && (row.sessionId || row.session_id) !== nativeId)) return null;
  const queued = claudeQueuedUser(row);
  const ts = Date.parse(queued?.timestamp || row.timestamp);
  if (!Number.isFinite(ts) || ts <= 0 || ts > at + 60_000) return null;
  // Maintenance snapshots, summary/title rewrites, progress pings and queue removals are not work.
  if (!queued && !['user', 'assistant'].includes(row.type)) return null;
  if (!queued && !row.message) return null;
  const content = queued?.text ?? row.message.content;
  if (typeof content !== 'string' && !Array.isArray(content)) return null;
  const reason = row.message?.stop_reason || '';
  const body = textOf(content);
  const key = queued?.id || (row.type === 'assistant' && row.message?.id
    ? `${row.message.id}:${row.apiBlockIndex ?? 0}` : row.uuid || `${row.type}:${ts}`);
  return { key, ts, signature: digest(JSON.stringify([content, reason, !!row.isApiErrorMessage])),
    turnKey: queued || (row.type === 'user' && body && !claudeSystemInput(row)) ? key : null,
    report: row.type === 'assistant' && !row.isApiErrorMessage && reason === 'end_turn' && body
      ? { text: body.slice(0, 8000), ts, id: row.message.id || row.uuid || key } : null,
    phase: row.isApiErrorMessage || reason === 'end_turn' || /\[Request interrupted/.test(body)
      ? 'waiting' : row.type === 'assistant' && !reason && body
        && !content?.some?.(part => part?.type === 'tool_use') ? 'unknown' : 'working', failure: !!row.isApiErrorMessage };
}

export async function observeClaudeActivity(entry, file, at = Date.now()) {
  const nativeId = claudeResumeId(file);
  if (!file || !nativeId) return { available: false, changed: false };
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return { available: false, changed: false };
  try {
    const st = await handle.stat();
    const identity = `${file}:${st.dev}:${st.ino}`;
    let state = entry.claudeActivity;
    const initial = !state || state.identity !== identity || st.size < state.offset;
    if (initial) state = entry.claudeActivity = { identity, offset: 0, seen: new Map(), lastAt: 0, report: null };
    if (!initial && st.size === state.offset) return { available: true, changed: false,
      lastAt: state.lastAt, turnKey: state.turnKey, phase: state.phase, failure: state.failure,
      report: state.report, newReport: false, initial: false };
    const start = Math.max(state.offset, st.size - MAX_BYTES);
    const buffer = Buffer.alloc(st.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
    if (end < 0) return { available: true, changed: false, lastAt: state.lastAt,
      turnKey: state.turnKey, phase: state.phase, failure: state.failure,
      report: state.report, newReport: false, initial, scannedBytes: bytesRead };
    const first = start > state.offset ? buffer.indexOf(10) + 1 : 0;
    let changed = false, newReport = false;
    for (const line of buffer.subarray(first, end).toString('utf8').split('\n')) {
      let item;
      try { item = claudeActivityRecord(JSON.parse(line), nativeId, at); } catch { continue; }
      if (!item) continue;
      const previous = state.seen.get(item.key);
      if (previous?.signature === item.signature || item.ts < state.lastAt || item.ts < (previous?.ts || 0)) continue;
      state.seen.set(item.key, { signature: item.signature, ts: item.ts });
      if (state.seen.size > 512) state.seen.delete(state.seen.keys().next().value);
      state.lastAt = Math.max(state.lastAt, item.ts);
      state.phase = item.phase;
      state.failure = item.failure;
      if (item.turnKey) state.turnKey = item.turnKey;
      if (!initial) changed = true;
      if (item.report) {
        // One API message can span several content blocks. Keep the same full source as Stop hooks.
        state.report = item.report;
        if (state.report.id !== state.reportBlocksId) {
          state.reportBlocksId = state.report.id;
          state.seenReportBlocks = new Map();
        }
        if (state.seenReportBlocks.has(item.key) || state.seenReportBlocks.size < 64) state.seenReportBlocks.set(item.key, item.report.text);
        state.report.text = [...state.seenReportBlocks.values()].join('\n\n').slice(0, 8000);
        if (!initial) newReport = true;
      }
    }
    state.offset = start + end + 1;
    return { available: true, changed, lastAt: state.lastAt, turnKey: state.turnKey, phase: state.phase,
      failure: state.failure, report: state.report, newReport, initial,
      scannedBytes: bytesRead };
  } finally { await handle.close(); }
}

// A report's identity is independent of viewport cropping and asynchronous model wording.
export function claudeAttentionKey(session, text, lastInputId = 0, promptId = '', turnKey = '') {
  return digest(JSON.stringify([claudeResumeId(session.claude_transcript) || session.id,
    lastInputId, promptId, turnKey, promptId ? '' : String(text || '').replace(/\s+/g, ' ').trim().slice(0, 8000)]));
}
