// Observation failures are UNKNOWN, never evidence that a process exited. One successful inventory
// serves a whole poll tick, avoiding an extra fork/has-session call for every agent on a busy host.
export function createSessionLiveness({ run, clock = Date.now, onError = () => {} }) {
  let flight = null, lastErrorAt = -Infinity;
  async function read() {
    try {
      const text = await run('list-sessions', '-F', '#{session_name}');
      if (typeof text !== 'string' || text.includes('\0')) throw new Error('invalid inventory');
      return { known: true, names: new Set(text.split('\n').map(s => s.trim()).filter(Boolean)) };
    } catch (error) {
      // tmux explicitly says the socket/server is absent. Generic exit 1, EAGAIN, EMFILE,
      // timeouts and failed connections are NOT equivalent to an empty inventory.
      const absent = !error.killed && !error.signal && error.code === 1
        && /no server running on |error connecting to [^\n]+\(No such file or directory\)/i.test(error.stderr || '');
      if (absent) return { known: true, names: new Set(), serverMissing: true };
      const reason = error.killed ? 'probe-timeout' : String(error.code || error.name || 'probe-failed').slice(0, 80);
      if (clock() - lastErrorAt >= 30_000) {
        lastErrorAt = clock();
        onError({ reason, signal: error.signal || null, at: clock() });
      }
      return { known: false, reason };
    }
  }
  function inventory() {
    if (!flight) flight = read().finally(() => { flight = null; });
    return flight;
  }
  return { inventory, async probe(name) {
    // A user action needs a fresh observation, not an in-flight pre-relaunch poll snapshot.
    const result = await read();
    return result.known ? (result.names.has(name) ? 'alive' : 'missing') : 'unknown';
  } };
}

// Bind confirmation to the registry generation (entry object), not just a reusable session ID.
// Unknown or positive observations break the absence streak; a single missed frame cannot retire it.
export function confirmedMissing(entry, inventory, at = Date.now()) {
  if (entry.missingTarget !== entry.tmux) {
    delete entry.missingSince; delete entry.missingCount;
    entry.missingTarget = entry.tmux;
  }
  if (!inventory.known || inventory.names.has(entry.tmux)) {
    delete entry.missingSince; delete entry.missingCount;
    return false;
  }
  entry.missingSince ??= at;
  entry.missingCount = (entry.missingCount || 0) + 1;
  return entry.missingCount >= 2 && at - entry.missingSince >= 1500;
}

export function sessionHealthError() {
  return Object.assign(new Error('Session health check is temporarily unavailable. Nothing was stopped or sent; please retry.'),
    { status: 503, code: 'session-health-unavailable' });
}
