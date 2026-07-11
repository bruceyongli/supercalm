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

console.log('detect_background.test ok');
