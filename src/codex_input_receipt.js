// history.jsonl is Codex's native submit acknowledgement, independent of TUI repaint/rollout size.
// Fence by exact conversation AND a pre-send byte watermark; old identical messages never count.
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function createCodexInputReceipt(nativeId, text, cursor = null) {
  if (!nativeId) return null;
  const path = process.env.AIOS_CODEX_HISTORY_FILE || join(homedir(), '.codex', 'history.jsonl');
  if (cursor && cursor.nativeId !== nativeId) return null;
  let identity = cursor?.identity, offset = cursor?.offset;
  if (!cursor) {
    try {
      const handle = await open(path, 'r');
      try { const st = await handle.stat(); identity = `${st.dev}:${st.ino}`; offset = st.size; }
      finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      identity = null; offset = 0;
    }
  }
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  let found = null;
  const receipt = async () => {
    if (found) return found;
    const handle = await open(path, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const st = await handle.stat();
      if ((identity && `${st.dev}:${st.ino}` !== identity) || st.size < offset) return null;
      const start = Math.max(offset, st.size - 512 * 1024);
      const buffer = Buffer.alloc(st.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const data = buffer.subarray(0, bytesRead), end = data.lastIndexOf(10);
      if (end < 0) return null;
      const first = start > offset ? data.indexOf(10) + 1 : 0;
      for (const line of data.subarray(first, end).toString('utf8').split('\n')) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.session_id === nativeId && row.text === text) {
          found = { receipt: 'codex-native-history', queued: false }; break;
        }
      }
      offset = start + end + 1;
      return found;
    } finally { await handle.close(); }
  };
  // Persist only the original boundary, not the reader's moving offset, for post-refresh recovery.
  receipt.cursor = { nativeId, identity, offset };
  return receipt;
}
