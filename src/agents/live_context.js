// Within-session "living context" / staleness reconciliation. Surfaces the operator's OWN recent
// signals in this session — granted access, rolled tokens, "go ahead", model/strategy changes,
// cancellations — so the supervisor reconciles its (frozen) supervision doc against what the operator
// has ACTUALLY said/decided, and stops enforcing facts the operator already superseded.
//
// This is the fix for the frozen-doc failure (doc hardcoded a "qwen3.6-plus 403" blocker the operator
// cleared in chat). It is WINDOW-PROOF: it pulls the operator's own messages/decisions directly, not
// from the scroll window that let "you're allowed now" fall out of the last-N-messages context.
//
// Pure + db-INJECTED, read-only: same function serves the live supervisor (store db) and the offline
// eval (read-only live db). Operator-authored only — excludes the agent's output, the supervisor's own
// sends, and detector/auto rows, so it's the operator's voice, not noise the supervisor itself created.

const OPERATOR_SOURCES = ['text', 'voice', 'text+attachments'];
// Resolution/permission/strategy-change cues. A message matching these is surfaced even if it has
// scrolled out of the recency window — so a "you're allowed now / rolled the token / use X instead"
// can never silently age out and let the supervisor re-raise a stale blocker.
const RESOLUTION_RX =
  /\ballow(ed)?\b|\baccess\b|\bgrant(ed)?\b|permission|\btoken\b|\brolled?\b|\bfixed\b|resolved|cleared|unblock|go ahead|approved?\b|\bproceed\b|\bswitch\b|\buse\b|don'?t use|instead|enabled?\b|disabled?\b|works? now|try again|\bdone\b|you'?re (good|allowed|set)|now you|deprecat|retired|no longer/i;

function oneLine(s, max) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function fmtTs(ts) {
  // pure (no Date.now): format an absolute ms timestamp as "MM-DD HH:MM" UTC.
  try {
    return new Date(Number(ts)).toISOString().slice(5, 16).replace('T', ' ');
  } catch {
    return '?';
  }
}

export function recentOperatorSignals({ db, sessionId, beforeTs = null, sinceTs = 0, maxMsgs = 14, maxResolutions = 8, scan = 120, maxDecisions = 6 } = {}) {
  if (!db || !sessionId) return { messages: [], decisions: [] };
  const msgPh = OPERATOR_SOURCES.map(() => '?').join(',');
  // sinceTs (incremental): read only what's NEW since the last reconcile cutoff — saves tokens and keeps the
  // maintainer focused on what just happened. Scan a wide window of operator-authored messages, then keep the
  // newest `maxMsgs` PLUS any resolution-matching ones (window-proof) — deduped, newest-first.
  const win = (since) => (since ? ' AND ts > ?' : '');
  const scanned = db
    .prepare(
      `SELECT ts, text FROM messages
       WHERE session_id = ? AND direction = 'in' AND source IN (${msgPh})${beforeTs ? ' AND ts < ?' : ''}${win(sinceTs)}
       ORDER BY ts DESC LIMIT ?`
    )
    .all(sessionId, ...OPERATOR_SOURCES, ...(beforeTs ? [beforeTs] : []), ...(sinceTs ? [sinceTs] : []), scan)
    .map((m) => ({ ts: m.ts, text: m.text }));
  const recent = scanned.slice(0, maxMsgs);
  const seen = new Set(recent.map((m) => m.ts));
  const resolutions = scanned.filter((m) => !seen.has(m.ts) && RESOLUTION_RX.test(m.text)).slice(0, maxResolutions);
  const msgs = [...recent, ...resolutions].sort((a, b) => b.ts - a.ts);
  const decs = db
    .prepare(
      `SELECT responded_at ts, ask, response FROM decisions
       WHERE session_id = ? AND response IS NOT NULL AND trim(response) <> '' AND substr(trim(response),1,1) <> '/'${beforeTs ? ' AND responded_at < ?' : ''}${sinceTs ? ' AND responded_at > ?' : ''}
       ORDER BY responded_at DESC LIMIT ?`
    )
    .all(sessionId, ...(beforeTs ? [beforeTs] : []), ...(sinceTs ? [sinceTs] : []), maxDecisions)
    .map((d) => ({ ts: d.ts, ask: d.ask, response: d.response }));
  return { messages: msgs, decisions: decs };
}

// Latest operator-authored message timestamp (used to settle: don't re-scope the doc while the operator is
// actively discussing — wait a few minutes after they last spoke).
export function lastOperatorMsgTs(db, sessionId) {
  if (!db || !sessionId) return 0;
  const ph = OPERATOR_SOURCES.map(() => '?').join(',');
  const row = db.prepare(`SELECT MAX(ts) ts FROM messages WHERE session_id = ? AND direction = 'in' AND source IN (${ph})`).get(sessionId, ...OPERATOR_SOURCES);
  return row?.ts || 0;
}

// Has the operator sent anything (their own voice) since `ts`? Used by the supervisor's non-repeating
// escalation gate: only re-notify the same reserved ask once the operator has actually engaged.
export function hasOperatorMessageSince(db, sessionId, ts) {
  if (!db || !sessionId || !ts) return false;
  const msgPh = OPERATOR_SOURCES.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT 1 FROM messages WHERE session_id = ? AND direction = 'in' AND source IN (${msgPh}) AND ts > ? LIMIT 1`)
    .get(sessionId, ...OPERATOR_SOURCES, ts);
  return !!row;
}

export function formatLiveContext(signals) {
  if (!signals) return '';
  const lines = [];
  for (const m of signals.messages || []) {
    const t = oneLine(m.text, 220);
    if (t) lines.push(`[${fmtTs(m.ts)}] operator said: ${t}`);
  }
  for (const d of signals.decisions || []) {
    const r = oneLine(d.response, 200);
    if (r) lines.push(`[${fmtTs(d.ts)}] operator decided (re: ${oneLine(d.ask, 80)}): ${r}`);
  }
  if (!lines.length) return '';
  return (
    "RECENT OPERATOR SIGNALS — the operator's own words/decisions in THIS session. They are NEWER than the supervision doc and SUPERSEDE it: if any grants access, rolls/fixes a token, changes the model or strategy, says \"go ahead\", or cancels a constraint, treat the matching doc fact or blocker as RESOLVED — do NOT re-raise it; act on the newer signal:\n" +
    lines.join('\n')
  );
}
