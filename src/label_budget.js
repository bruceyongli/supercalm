// Background labeling never queues model work behind an interactive request. Missed opportunities
// are deferred to the next visible-graph refresh, with one global cadence across all sessions.
export class LabelDeferred extends Error {
  constructor() { super('Labeling deferred'); this.code = 'LABEL_DEFERRED'; }
}

export function createLabelBudget({ enabled, interval, clock = Date.now, overloadMs = 240000 } = {}) {
  let busy = false, nextAt = 0, failures = 0;
  const ready = () => enabled() && !busy && clock() >= nextAt;
  return {
    ready,
    state: () => ({ busy, next_attempt_at: nextAt, failures }),
    async run(fn) {
      if (!ready()) throw new LabelDeferred();
      busy = true;
      nextAt = clock() + interval();
      try {
        const value = await fn();
        failures = 0;
        return value;
      } catch (error) {
        if (error?.code !== 'LABEL_DEFERRED') {
          failures++;
          const text = String(error?.message || error);
          const unavailable = /not[_ ]?found|unknown model|no such model|invalid model|does not exist|\b(401|403|404)\b|forbidden|access denied/i.test(text);
          const overloaded = /overloaded|rate.?limit|too many requests|quota|yielded|\b(429|529|503)\b/i.test(text);
          const backoff = Math.min(900000, 30000 * 2 ** Math.min(failures - 1, 5));
          nextAt = Math.max(nextAt, clock() + (unavailable ? 900000 : overloaded ? Math.max(backoff, overloadMs) : backoff));
        }
        throw error;
      } finally { busy = false; }
    },
  };
}
