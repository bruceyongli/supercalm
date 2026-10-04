import { randomUUID } from 'node:crypto';

// Ready updates only. No work queue: one model/TTS preparation may run at a time, and concurrent
// callers for the same report share it. Cached bytes never outlive their report or the short TTL.
export function createVoicePreparationCache({ clock = Date.now, ttlMs = 600000, maxEntries = 8, maxBytes = 24000000 } = {}) {
  const entries = new Map(), pending = new Map();
  const prune = () => {
    for (const [key, entry] of entries) if (clock() >= entry.expiresAt) entries.delete(key);
  };
  const prepare = async (key, produce) => {
    prune();
    if (entries.has(key)) return entries.get(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size) throw Object.assign(new Error('Another voice update is being prepared'), { status: 429 });
    const work = (async () => {
      const value = await produce();
      if (!value?.say || !value.audio?.length || value.audio.length > maxBytes) throw new Error('Voice update is incomplete');
      const entry = { ...value, key, id: randomUUID(), expiresAt: clock() + ttlMs };
      let bytes = entry.audio.length;
      for (const other of entries.values()) bytes += other.audio.length;
      while (entries.size && (entries.size >= maxEntries || bytes > maxBytes)) {
        const oldest = entries.keys().next().value;
        bytes -= entries.get(oldest).audio.length;
        entries.delete(oldest);
      }
      entries.set(key, entry);
      return entry;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
  return {
    prepare,
    get(id) { prune(); return [...entries.values()].find(entry => entry.id === id) || null; },
  };
}
