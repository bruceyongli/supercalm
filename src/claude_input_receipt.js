// A Claude TUI repaint is not the only acknowledgement: current versions durably record queued and
// consumed input in the exact native transcript. Read only NEW complete records in a bounded tail.
import { open } from 'node:fs/promises';
import { claudeQueuedUser, claudeSystemInput } from './claude_lifecycle.js';
import { claudeResumeId } from './claude_transcripts.js';

const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
export function claudeInputRecordReceipt(row, { text, nativeId }) {
  if (!row || row.isSidechain || claudeSystemInput(row)
      || (row.origin?.kind && row.origin.kind !== 'human')
      || (nativeId && (row.sessionId || row.session_id) !== nativeId)) return null;
  if (row.type === 'queue-operation' && row.operation === 'enqueue' && typeof row.content === 'string'
      && norm(row.content) === norm(text)) return { queued: true, receipt: 'claude-native-queue' };
  const queued = claudeQueuedUser(row);
  const content = row.message?.content;
  const user = row.type === 'user' && !claudeSystemInput(row)
    ? (typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(part => part.type === 'text').map(part => part.text).join('\n\n') : '') : '';
  if (norm(queued?.text || user) && norm(queued?.text || user) === norm(text)) return { queued: false, receipt: 'claude-native-input' };
  return null;
}

export async function createClaudeInputReceipt(file, text) {
  const nativeId = claudeResumeId(file);
  if (!file || !nativeId) return null;
  let identity, offset;
  try {
    const handle = await open(file, 'r');
    try { const st = await handle.stat(); identity = `${st.dev}:${st.ino}`; offset = st.size; }
    finally { await handle.close(); }
  } catch { return null; }
  let found = null;
  return async () => {
    if (found) return found;
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const st = await handle.stat();
      if (`${st.dev}:${st.ino}` !== identity || st.size < offset) return null;
      const start = Math.max(offset, st.size - 256 * 1024);
      const buffer = Buffer.alloc(st.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end < 0) return null; // a partial JSON write cannot prove delivery
      const first = start > offset ? buffer.indexOf(10) + 1 : 0;
      for (const line of buffer.subarray(first, end).toString('utf8').split('\n')) {
        try { found = claudeInputRecordReceipt(JSON.parse(line), { text, nativeId }); } catch {}
        if (found) break;
      }
      offset = start + end + 1;
      return found;
    } finally { await handle.close(); }
  };
}
