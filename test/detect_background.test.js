import assert from 'node:assert/strict';
import { classify } from '../src/detect_classify.js'; // PURE — no store/server boot

const IDLE = 60_000; // well past IDLE_WAIT_MS so the idle fall-through would fire without the fix
const sess = (over = {}) => ({ id: 's_test_bg', autonomy: 'full', ...over });

// Operator report: a session with a LIVE background terminal but an idle foreground composer was
// settling to `waiting` and entering the needs-you queue while it was actually working.
{
  const snap = 'some earlier output\n\n> \n  · 1 background terminal running · /ps to view';
  const r = classify({ session: sess(), snap, idleMs: IDLE, authGraceUntil: 0 });
  assert.equal(r.status, 'working', 'a live background terminal + idle composer must be working, not waiting');
}
{
  const snap = '> \n  · 2 background terminals running · /ps to view';
  assert.equal(classify({ session: sess(), snap, idleMs: IDLE, authGraceUntil: 0 }).status, 'working');
}

// A genuine approval prompt shown ALONGSIDE a background terminal must still surface as waiting —
// PROMPT_RX is checked before the background rule on purpose.
{
  const snap = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n  · 1 background terminal running · /ps to view';
  assert.equal(classify({ session: sess(), snap, idleMs: IDLE, authGraceUntil: 0 }).status, 'waiting', 'a real prompt wins over background-running');
}

// The always-present "ctrl+b to run in background" HINT is not proof of background work — an idle
// composer showing only the hint must still settle to waiting.
{
  const snap = '> \n  ctrl+b to run in background · / for commands';
  assert.equal(classify({ session: sess(), snap, idleMs: IDLE, authGraceUntil: 0 }).status, 'waiting', 'the run-in-background hint must not force working');
}

// Regression: a plain idle composer (no background terminal) still settles to waiting.
{
  const snap = '> \n  I have finished the task. Let me know what next.';
  assert.equal(classify({ session: sess(), snap, idleMs: IDLE, authGraceUntil: 0 }).status, 'waiting');
}

// Incident s_8ea0dbf260 (operator report, 2026-07-12): the agent yielded its turn ("No active task
// remains; awaiting the operator") but deliberately left 5 dev servers running in background
// terminals. That footer never clears, so the unbounded background rule pinned the session
// `working` for ~20 hours — it never entered the needs-you queue and supervisor stop-reviews never
// fired. The background hold must be BOUNDED: once the pane has been completely still past
// BG_HOLD_MS, the session settles to waiting (the →waiting summarizer is the second-layer filter).
// Tail is a condensed capture of the real pane, including two traps that must stay non-matching:
// agent prose "Status: working." (no ellipsis → not WORKING_RX) and the "Worked for 7m 59s" rule.
const INCIDENT_SNAP = [
  '› Status: working.',
  '',
  '  - App: HTTP 200 at http://192.0.2.10:3000',
  '  - Sandbox runner: healthy, 2 active sandboxes',
  '',
  '─ Worked for 7m 59s ─────────────────────────',
  '',
  '› [Supervisor] State in one line whether any active task remains; if none, idle and await the operator.',
  '',
  '› No active task remains; awaiting the operator.',
  '',
  '  5 background terminals running · /ps to view · /stop to close',
  '',
  '› Write tests for @filename',
  '',
  '  gpt-5.6-sol xhigh · ~/openhand/share',
].join('\n');
{
  const r = classify({ session: sess(), snap: INCIDENT_SNAP, idleMs: 20 * 3600_000, authGraceUntil: 0 });
  assert.equal(r.status, 'waiting', 'long-still pane + bg servers left running must settle to waiting, not stick working forever');
}
// Within the hold window the original fix still stands: quiet composer + live bg terminals = working.
{
  const r = classify({ session: sess(), snap: INCIDENT_SNAP, idleMs: 5 * 60_000, authGraceUntil: 0 });
  assert.equal(r.status, 'working', 'bg terminals within the hold window must still read as working');
}

// Operator report (s_f54892ae6d, 2026-07-12): an IDLE session was shown `working` everywhere because its
// OWN transcript contained a parenthetical elapsed-time string — "(9s TTL) …" — which the codex live-timer
// pattern `/\(\s*\d+\s*s\b/` matched as active processing. A printed "(<n>s" is not a ticking timer; on a
// long-idle pane it must settle to waiting. (Condensed capture of the real pane: an ⏺ answer line quoting
// the TTL, claude's DONE line "✻ Cooked for 3m 9s", the composer, and the bypass footer.)
const TIMER_PROSE_SNAP = [
  '⏺ Root-caused the flap: the hook override (9s TTL) and the pattern classifier can disagree,',
  '  flapping status ~1/s for a few polls.',
  '',
  '✻ Cooked for 3m 9s',
  '',
  '❯ sign off on the 13b fix',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents  89% context used',
].join('\n');
{
  const r = classify({ session: sess({ tool: 'claude' }), snap: TIMER_PROSE_SNAP, idleMs: IDLE, authGraceUntil: 0 });
  assert.equal(r.status, 'waiting', 'a printed "(9s TTL)" in prose must NOT pin an idle session working — an elapsed timer is a LIVE-only signal');
}
// The principle, isolated: the SAME "(12s)" content reads working while the pane is live (changing, low
// idle) and waiting once it has gone stale. A real timer ticks; a frozen one is just text.
{
  const snap = 'building the search index\n(12s)';
  assert.equal(classify({ session: sess({ tool: 'codex' }), snap, idleMs: 800, authGraceUntil: 0 }).status, 'working', 'a recently-changed pane is working (live)');
  assert.equal(classify({ session: sess({ tool: 'codex' }), snap, idleMs: IDLE, authGraceUntil: 0 }).status, 'waiting', 'the same "(12s)" gone stale is not work');
}
// Guard the genuine case: a real codex working line still reads working even when idle (its interrupt hint
// + spinner glyph are live-only markers), so removing the bare timer did not weaken true-positive detection.
{
  const snap = '⣾ Working (12s · Esc to interrupt)';
  assert.equal(classify({ session: sess({ tool: 'codex' }), snap, idleMs: IDLE, authGraceUntil: 0 }).status, 'working', 'esc-to-interrupt / spinner still detect live codex work');
}

console.log('detect_background.test ok');
