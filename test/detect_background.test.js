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

console.log('detect_background.test ok');
