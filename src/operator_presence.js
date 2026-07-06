// Transient operator presence: is the human actively composing a reply in a given session right now?
// The session composer (and live terminal typing) heartbeats here; the autonomous supervisor reads it to
// HOLD its auto-sends while the operator is mid-reply -- otherwise the supervisor's nudge races the
// half-typed message and the two interleave in the pane. In-memory + TTL'd (the operator stopping/sending/
// blurring just lets the beat lapse). A dependency-free LEAF module so both the HTTP route (sessions.js)
// and the supervisor (agents/supervisor.js) import it without a cycle.

const TTL_MS = Number(process.env.AIOS_OPERATOR_TYPING_TTL_MS || 8000); // ~2 missed 3s heartbeats of grace

const typingUntil = new Map(); // sid -> epoch ms until which the operator counts as actively typing

// Mark the operator as actively typing in `sid` for the next TTL window. Idempotent; refreshes the window.
export function markTyping(sid, ttl = TTL_MS) {
  if (!sid) return;
  typingUntil.set(sid, Date.now() + ttl);
}

// True while a recent heartbeat is still within its TTL. Self-cleans expired entries on read.
export function typingActive(sid) {
  const until = typingUntil.get(sid);
  if (!until) return false;
  if (Date.now() >= until) { typingUntil.delete(sid); return false; }
  return true;
}

// Immediate stand-down (e.g. on send): the message is committed, no need to keep deferring.
export function clearTyping(sid) {
  if (sid) typingUntil.delete(sid);
}
