// SESSION ERROR CLASSIFIER — shared, pure (v4 Phase 2 extraction; formerly private to supervisor.js).
// One truth for what an API-error screen IS: the supervisor's episode machinery and the poll loop's
// `degraded` marker both consume THIS module — two drifting classifiers would be the exact "two
// truths" disease v4 exists to kill. Moved VERBATIM (replay-suite-locked); exports only.
// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------
// Transient/rate-limit errors the AGENT (not the supervisor) hit on its model call — the supervisor
// waits out a backoff then nudges the session to retry. AUTH errors are EXCLUDED (detect.js owns the
// 401/login relaunch path). If the bottom of the screen shows healthy output (⏺/⎿) or an ACTIVE
// spinner/elapsed-timer below the error, the agent recovered or is retrying itself -> don't engage.
// A real runtime/API error is how the CLI PRINTS a failure — NOT a topic the agent is working on. Agents put
// "403", "429", "rate limit", "permission" in TASK NAMES and in code they're WRITING (s_e8b74301f6: the TODO
// "◻ … (fix admin-provision 403)" was misread as a live 403 and escalated for HOURS). So require a STRUCTURED
// error marker: an unambiguous error phrase, OR an HTTP status code immediately followed by its standard
// reason phrase. A BARE code or topic word alone is never treated as an error. (classifyErrorType still keys
// off bare codes — but only runs on a line already confirmed to be a real error here.)
export const HARD_ERR_RX = /\bAPI Error\b|\b(rate_limit|permission|billing|invalid_request|authentication|api|server|overloaded)_error\b|status\s*code\s*:?\s*\d|stream (error|disconnect)|connection (error|reset|refused)|\beconn(reset|refused)\b|\betimedout\b|upstream[^.\n]{0,24}(error|timeout|reset|disconnect|unavailable|connect|gateway|503|502|500)|temporarily unavailable|service unavailable|credit balance|insufficient (credit|fund)/i;
export const HTTP_STATUS_LINE_RX = /\b(40[123]|429|5\d\d)\s+(forbidden|unauthorized|payment required|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)\b/i;
export function looksLikeSessionError(l) {
  return HARD_ERR_RX.test(l) || HTTP_STATUS_LINE_RX.test(l);
}
// A line can MENTION an error code while reporting it's GONE: the agent narrating "Retried. No 429.",
// "Continued after the 429", "not a 429", or its done banner "Goal achieved (8h 29m)" is NOT a live error.
// Without this, SESSION_ERR_RX/classifyErrorType match the bare token inside "No 429" and the recovery loop
// retries an agent that already finished (observed: a 5h phantom rate-limit loop after "Goal achieved").
// So: a negation/clearance word near the error token, or an explicit done/success banner, reads as RECOVERED.
export const ERR_CLEARED_RX = /\b(no|not|without|cleared?|clears?|recovered?|resolved?|succe\w*|continu\w*|retried|past|after)\b[^.\n]{0,24}\b(429|5\d\d|rate.?limit|error|quota|overload|disconnect|timeout)\b|\b(429|5\d\d|rate.?limit|error|quota|overload)\b[^.\n]{0,20}\b(cleared|gone|resolved|recovered|no longer|now ok|self-?cleared)\b|\bgoal achieved\b|\btask complete|completed successfully|no error/i;
// The SUPERVISOR's OWN retry nudges echo back in the terminal — every errNudgeFor() string says "retry the
// last step and continue" and names the error class ("transient network/stream error", "rate-limit (429)"),
// so detectSessionError would re-match our OWN message as a NEW agent error and retry forever. Never treat a
// line that is one of our nudges (or any "[Supervisor]"-labelled echo) as an agent error.
export const OWN_NUDGE_RX = /retry the last step and continue|that was a (transient|rate.?limit|brief)|not a real blocker|it may have cleared now|previous request failed with a transient|provider was briefly busy|\[supervisor\]/i;
// Per-error-type recovery strategy (Anthropic taxonomy: 429 rate_limit, 529 overloaded, 500/504 server,
// 402 billing, 403 permission). Different classes clear on very different timescales — or never on their
// own — so one backoff schedule for all is wrong. Schedules are seconds; the FIRST value is the wait before
// the supervisor first intervenes (giving the CLI's own retry a chance). billing/permission are NOT
// retryable by waiting -> escalate to the operator immediately, no pointless retries.
export function classifyErrorType(line) {
  const l = String(line || '');
  if (/\b402\b|billing_error|credit balance|insufficient (credit|fund)|payment (required|method)/i.test(l)) return 'billing';
  if (/\b403\b|permission_error|forbidden|do(es)? not have permission/i.test(l)) return 'permission';
  if (/rate.?limit|rate_limit|\b429\b|usage limit|\bquota\b/i.test(l)) return 'rate_limit';
  if (/overloaded|\b529\b/i.test(l)) return 'overloaded';
  if (/\bterminated\b|stream (error|disconnect)|connection (error|reset)|upstream|\b50[0234]\b|timed? ?out|timeout|temporarily unavailable|service unavailable|econnreset|socket/i.test(l)) return 'transient';
  return 'generic';
}
export const ERR_SCHEDULES = {
  transient: [15, 60, 300], // network/stream/500 blip — usually self-clears fast
  overloaded: [20, 90, 300, 900], // 529 — clears as fleet traffic subsides
  rate_limit: [60, 300, 1800, 7200], // 429 — quota replenishes slowly; longest
  generic: [30, 180, 1200], // unknown API error — moderate
};
export const ERR_NONRETRYABLE = new Set(['billing']); // out-of-credit needs operator action. permission/403 is NOT here — it stands down (operator policy: switch models / never stop on access issues).
export function errNudgeFor(type) {
  if (type === 'rate_limit') return 'That was a rate-limit (429). It may have cleared now — retry the last step and continue where you left off.';
  if (type === 'overloaded') return 'That was a transient "overloaded" (529) — the provider was briefly busy and should have recovered. Retry the last step and continue.';
  if (type === 'transient') return 'That was a transient network/stream error, not a real blocker. Retry the last step and continue where you left off.';
  return 'The previous request failed with a transient API error. The issue may have cleared now — retry the last step and continue where you left off.';
}
export const SESSION_AUTH_RX = /\b401\b|unauthorized|authentication_error|passcode required|admin passcode required|access code required|please run\b.*\blogin|sign in|not (signed|logged) in|invalid.*credential|token (has )?expired|oauth/i;
export const ACTIVE_RX = /esc to interrupt|\(\s*\d+\s*s\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷◐◓◑◒✶✻✽]/i;
// A GENUINE context wedge: the model rejected the turn because the prompt overflowed the window (only happens
// when Claude Code's built-in auto-compact didn't save it). Match the real OVERFLOW ERROR — NOT the footer's
// "100% context used" / "X% context" indicator, which is a NORMAL live display that reads 100% even at ~32%
// real usage (verified via /context) and shows while the agent is actively generating. Matching the footer
// produced phantom wedges + /compact spam. Auto-compact (rolling, on by default) handles the normal case.
export const CONTEXT_WEDGE_RX = /prompt is too long|input (is )?too long|exceeds? (the )?(model'?s )?(maximum )?context (window|length|limit)|context (window|length|limit) (is )?(reached|exceeded|full)|maximum context length exceeded|\bout of context|ran out of room in (the )?model'?s context window|start a new thread or clear earlier history/i;
export function detectSessionError(tail) {
  // Scan a generous window: the agent often renders its task-list/composer BELOW the error line, so a
  // 15-line tail can miss an error that's still the agent's last real action. 40 reaches it.
  const lines = String(tail || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-40);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    // Our OWN retry nudge (or any "[Supervisor]" echo) is not a NEW agent error — skip it so we don't loop on
    // our own message (s_e8b74301f6: "❯ [Supervisor] That was a transient network/stream error … retry").
    if (OWN_NUDGE_RX.test(l)) continue;
    // Error first: claude prints the failure ON a "⏺" bullet (e.g. "⏺ API Error: terminated"), so the
    // error test must win over the healthy-bullet test below.
    if (looksLikeSessionError(l) && !SESSION_AUTH_RX.test(l)) {
      // ...but a line that NEGATES the error or shows a done/success banner ("Retried. No 429.",
      // "Goal achieved") is the agent reporting recovery, not a live error -> treat as recovered.
      if (ERR_CLEARED_RX.test(l)) return null;
      return l.slice(0, 200);
    }
    // Healthy agent output (⏺/⎿) or an active spinner/timer BELOW the error => recovered / self-retrying.
    if (/^[⏺⎿]/.test(l) || ACTIVE_RX.test(l)) return null;
  }
  return null;
}
// Positive evidence the agent is progressing again (a healthy tool bullet ⏺/⎿ or an active spinner/timer
// near the bottom). Used to decide an API-error episode has genuinely CLEARED — vs the error merely
// scrolling out of view — so a sticky episode isn't abandoned while the agent is still wedged on it.
export function sessionRecovered(tail) {
  const lines = String(tail || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-8);
  return lines.some((l) => /^[⏺⎿]/.test(l) || ACTIVE_RX.test(l) || ERR_CLEARED_RX.test(l));
}
