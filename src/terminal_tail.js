// A viewer's terminal receives new bytes immediately, with polling only as a repair path.
// One read owns each entry's offset: overlapping async ticks used to replay the same TUI frame twice.
import { watch } from 'node:fs';
import { stat, open } from 'node:fs/promises';

const CHUNK_BYTES = 256 * 1024;
async function readBytes(file, start, end) {
  const fh = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

export function flushTerminalTail(entry, { statFile = stat, read = readBytes } = {}) {
  if (entry.tailFlight) return entry.tailFlight;
  if (entry.tailRetired || !entry.subscribers.size) return Promise.resolve();
  const flight = (async () => {
    const st = await statFile(entry.logFile);
    if (st.size < entry.offset) entry.offset = 0;
    if (st.size <= entry.offset || !entry.subscribers.size) return;
    const start = entry.offset;
    const buf = await read(entry.logFile, start, Math.min(st.size, start + CHUNK_BYTES));
    if (entry.tailRetired) return;
    if (!buf.length) return;
    entry.offset = start + buf.length;
    const payload = `event: data\ndata: ${buf.toString('base64')}\n\n`;
    for (const res of entry.subscribers) {
      try {
        // A suspended/slow phone must not accumulate an unbounded queue of old redraws in RAM.
        // EventSource reconnects and receives the authoritative current screen from /stream.
        if (res.writableLength > 1024 * 1024) { entry.subscribers.delete(res); res.destroy(); }
        else res.write(payload);
      } catch { entry.subscribers.delete(res); }
    }
  })().finally(() => { if (entry.tailFlight === flight) entry.tailFlight = null; });
  entry.tailFlight = flight;
  return flight;
}

export function stopTerminalTail(entry) {
  clearTimeout(entry.tailTimer);
  entry.tailTimer = null;
  entry.tailWatcher?.close();
  entry.tailWatcher = null;
}
export function watchTerminalTail(entry) {
  if (entry.tailWatcher || !entry.subscribers.size) return;
  try {
    entry.tailWatcher = watch(entry.logFile, { persistent: false }, (event) => {
      if (!entry.subscribers.size) { stopTerminalTail(entry); return; }
      if (event === 'rename') { stopTerminalTail(entry); return; }
      if (entry.tailTimer) return;
      entry.tailTimer = setTimeout(() => {
        entry.tailTimer = null;
        flushTerminalTail(entry).catch(() => {});
      }, 8);
      entry.tailTimer.unref?.();
    });
    entry.tailWatcher.on('error', () => stopTerminalTail(entry));
  } catch { /* a missing/rotating log is repaired by the existing polling path */ }
}
