// Watch only transcripts with active Story viewers. Notifications are small invalidations, not
// terminal frames; one watcher is shared by all devices viewing the same session. No DB writes.
import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';

export function createStoryUpdates({ resolve, bus, watchFile = watch, statFile = stat,
  debounceMs = 120, repairMs = 2500, pingMs = 15000 } = {}) {
  const entries = new Map();
  const semantic = new Set(['summary', 'reply', 'settings', 'launch', 'resume', 'launch-error', 'exit', 'kill', 'stop', 'transcript', 'question']);
  function dispose(entry) {
    entry.closed = true;
    clearTimeout(entry.timer); clearInterval(entry.repair); clearInterval(entry.ping);
    entry.watcher?.close();
    if (entries.get(entry.sid) === entry) entries.delete(entry.sid);
  }
  function send(entry, res, initial = false) {
    try {
      if (res.destroyed || res.writableEnded || res.writableLength > 64 * 1024) {
        entry.clients.delete(res); res.destroy();
      } else res.write(`event: update\ndata: ${JSON.stringify({ session: entry.sid, revision: entry.revision, initial })}\n\n`);
    } catch { entry.clients.delete(res); }
    if (!entry.clients.size) dispose(entry);
  }
  function schedule(entry, force = false) {
    if (entry.closed) return;
    entry.force ||= force;
    if (!entry.timer) {
      entry.timer = setTimeout(() => { entry.timer = null; void check(entry); }, debounceMs);
      entry.timer.unref?.();
    }
  }
  async function check(entry) {
    if (entry.closed) return;
    if (entry.flight) { entry.again = true; return entry.flight; }
    entry.flight = (async () => {
      do {
        entry.again = false;
        const force = entry.force; entry.force = false;
        try {
          const source = await resolve(entry.sid);
          if (entry.closed) return;
          if (!source) { for (const res of entry.clients) res.end(); entry.clients.clear(); dispose(entry); return; }
          let st = null;
          if (source.file) { try { st = await statFile(source.file); } catch {} }
          if (entry.closed) return;
          const signature = JSON.stringify([source.file, st?.dev, st?.ino, st?.size, st?.mtimeMs, source.state]);
          if (entry.file !== source.file || !entry.watcher) {
            entry.watcher?.close(); entry.watcher = null; entry.file = source.file;
            if (source.file) {
              try {
                entry.watcher = watchFile(source.file, { persistent: false }, event => {
                  if (event === 'rename') { entry.watcher?.close(); entry.watcher = null; }
                  schedule(entry);
                });
                entry.watcher.on('error', () => { entry.watcher?.close(); entry.watcher = null; schedule(entry); });
              } catch { /* stat repair also recovers late creation/rotation/missed filesystem events */ }
            }
          }
          if (force || signature !== entry.signature) {
            entry.signature = signature; entry.revision++;
            for (const res of [...entry.clients]) send(entry, res);
          }
        } catch { /* transient lookup failures must not close a working mobile conversation */ }
      } while (entry.again && !entry.closed);
    })().finally(() => { entry.flight = null; });
    return entry.flight;
  }
  const onStatus = event => {
    const entry = entries.get(event?.session);
    if (entry && (semantic.has(event.source) || event.previousStatus !== event.status)) schedule(entry, true);
  };
  bus?.on('session-status', onStatus);
  return {
    subscribe(sid, res) {
      let entry = entries.get(sid);
      if (!entry) {
        entry = { sid, clients: new Set(), file: null, signature: null, revision: 0, closed: false };
        entries.set(sid, entry);
        entry.repair = setInterval(() => void check(entry), repairMs); entry.repair.unref?.();
        entry.ping = setInterval(() => {
          for (const client of [...entry.clients]) {
            try {
              if (client.destroyed || client.writableEnded || client.writableLength > 64 * 1024) {
                entry.clients.delete(client); client.destroy();
              } else client.write('event: heartbeat\ndata: {}\n\n');
            } catch { entry.clients.delete(client); }
          }
          if (!entry.clients.size) dispose(entry);
        }, pingMs); entry.ping.unref?.();
      }
      entry.clients.add(res);
      send(entry, res, true); // reconnect always catches up, even if the session is still Working
      schedule(entry);
      let removed = false;
      return () => {
        if (removed) return; removed = true;
        entry.clients.delete(res);
        if (!entry.clients.size && !entry.closed) dispose(entry);
      };
    },
    close() {
      bus?.off('session-status', onStatus);
      for (const entry of [...entries.values()]) {
        for (const res of entry.clients) res.end();
        dispose(entry);
      }
    },
    size: () => entries.size,
  };
}
