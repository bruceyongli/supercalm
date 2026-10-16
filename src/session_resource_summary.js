import { resolve, sep } from 'node:path';

// Only owned session scopes, never a scan of every project or the whole home folder. Parent scopes
// (worktree, screenshots) already contain their nested attachments/profile: count those once.
export function uniqueDiskRoots(paths) {
  const roots = [...new Set(paths.filter(Boolean).map(p => resolve(p)))].sort((a, b) => a.length - b.length);
  return roots.filter((p, i) => !roots.slice(0, i).some(parent => p.startsWith(parent + sep)));
}

export function createSessionDiskUsage({ measure, clock = Date.now, ttl = 60_000, maxEntries = 256, budgetMs = 12_000 } = {}) {
  const entries = new Map(), queue = new Map();
  let flight = null;
  async function drain() {
    if (flight) return flight;
    flight = (async () => {
      while (queue.size) {
        const [id, entry] = queue.entries().next().value;
        queue.delete(id);
        const started = clock(); let bytes = 0, failed = false;
        for (const path of entry.paths) {
          const remaining = budgetMs - (clock() - started);
          if (remaining <= 0) { failed = true; break; }
          try {
            const result = await measure(path, { timeoutMs: Math.max(1, Math.min(5000, remaining)) });
            if (result.error || !Number.isFinite(result.bytes)) { failed = true; break; }
            bytes += result.bytes;
          } catch { failed = true; break; }
        }
        entry.pending = false; entry.attempted_at = clock(); entry.error = failed ? 'Disk measurement incomplete' : null;
        if (!failed) { entry.bytes = bytes; entry.checked_at = clock(); }
      }
    })().finally(() => { flight = null; });
    return flight;
  }
  return {
    get(scopes) {
      const rows = [];
      for (const scope of scopes.slice(0, 80)) {
        const paths = uniqueDiskRoots(scope.paths), key = JSON.stringify(paths);
        let entry = entries.get(scope.id);
        if (!entry || entry.key !== key) {
          if (entries.size >= maxEntries) {
            const victim = [...entries].find(([, e]) => !e.pending);
            if (!victim) continue;
            entries.delete(victim[0]);
          }
          entry = { key, paths, bytes: null, checked_at: null, attempted_at: -Infinity, pending: false, error: null };
          entries.set(scope.id, entry);
        }
        if (!entry.pending && clock() - entry.attempted_at >= ttl) {
          entry.pending = true; queue.set(scope.id, entry);
        }
        rows.push({ id: scope.id, disk_bytes: entry.bytes, disk_checked_at: entry.checked_at,
          disk_pending: entry.pending, disk_stale: !!entry.error || (entry.checked_at != null && clock() - entry.checked_at > ttl * 2),
          disk_error: entry.error });
      }
      if (queue.size) void drain();
      return rows;
    },
    async settled() { await flight; },
  };
}

export function sessionResourceSummary(snapshot, sessions, disks) {
  const groups = new Map((snapshot.groups || []).filter(g => g.session_id).map(g => [g.session_id, g]));
  const diskById = new Map(disks.map(d => [d.id, d]));
  const known = !!snapshot.checked_at && !snapshot.errors?.includes('Session ownership unavailable');
  return sessions.map(s => {
    const group = groups.get(s.id);
    // A newly starting session or failed ownership probe is unknown, not fictitious zero usage.
    const absent = known && s.status !== 'starting' && (s.started_at || 0) <= snapshot.checked_at;
    const footprint = group?.footprint_bytes;
    return { id: s.id, cpu_percent: group?.cpu_percent ?? (absent ? 0 : null),
      memory_bytes: footprint ?? group?.rss_bytes ?? (absent ? 0 : null),
      memory_kind: footprint != null ? 'footprint' : 'rss',
      memory_partial: !!group?.footprint_processes && group.footprint_processes !== group.process_count,
      process_count: group?.process_count ?? (absent ? 0 : null),
      checked_at: snapshot.checked_at || null, stale: !!snapshot.stale || !!snapshot.error,
      ...diskById.get(s.id) };
  });
}
