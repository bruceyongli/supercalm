// Approximate payload-byte budget, not just an entry count. Never retain an oversized report.
export function createBoundedCache({ maxEntries = 120, maxBytes = 16 * 1024 * 1024 } = {}) {
  const entries = new Map(); let bytes = 0;
  const remove = key => { const row = entries.get(key); if (row) { bytes -= row.bytes; entries.delete(key); } };
  return {
    get(key) {
      const row = entries.get(key);
      if (!row) return undefined;
      entries.delete(key); entries.set(key, row);
      return row.value;
    },
    set(key, value) {
      remove(key);
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > maxBytes) return;
      entries.set(key, { value, bytes: size }); bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
    },
    size: () => entries.size,
    bytes: () => bytes,
  };
}
