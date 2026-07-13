// claude feedback-survey gate — "● How is Claude doing this session? … 0: Dismiss" intercepts input:
// operator replies typed under it sat unsubmitted for hours (s_087cf6e228 ×3 + s_2587ee0851,
// 2026-07-12/13; the supervisor had to improvise a "0 (Dismiss)." prefix to get messages through).
// The survey is now a known one-time gate (auto-'0') and sendText() pre-dismisses it before typing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, CLAUDE_SURVEY_RX } from '../src/detect_classify.js';

// Verbatim shape from the s_087cf6e228 pane capture.
const SURVEY_BLOCK = [
  '● How is Claude doing this session? (optional)',
  '  1: Bad    2: Fine   3: Good   0: Dismiss',
].join('\n');
const SCREEN = [
  '  Per your instruction I did not push, retag, or delete anything.',
  '✻ Churned for 1m 55s',
  SURVEY_BLOCK,
  '──────────────────────────────────────────────',
  '❯ I pushed main and the tags, verify again',
  '──────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

// ---- regex: matches the real block, not loose prose ----
assert.ok(CLAUDE_SURVEY_RX.test(SCREEN), 'matches the captured survey screen');
assert.ok(CLAUDE_SURVEY_RX.test(SURVEY_BLOCK), 'matches the bare survey block');
assert.ok(!CLAUDE_SURVEY_RX.test('I wondered how is Claude doing this session? It went fine.'), 'prose without the menu must not match');
assert.ok(!CLAUDE_SURVEY_RX.test('0: Dismiss'), 'menu row alone must not match');

// ---- classify: autonomous sessions auto-dismiss ('0'), ask sessions surface it as waiting ----
const base = { id: 's_test_survey', tool: 'claude' };
const auto = classify({ session: { ...base, autonomy: 'full' }, snap: SCREEN, idleMs: 5000 });
assert.equal(auto.status, 'working', 'gate returns working while the confirm keys are queued');
assert.deepEqual(auto.confirm, ['0'], 'autonomous session dismisses the survey with 0');

const ask = classify({ session: { ...base, autonomy: 'ask' }, snap: SCREEN, idleMs: 5000 });
assert.equal(ask.status, 'waiting', 'ask session is surfaced instead of auto-keyed');
assert.ok(!ask.confirm, 'ask session gets no auto-confirm keys');

// A normal working screen must not trip the gate.
const working = classify({
  session: { ...base, autonomy: 'full' },
  snap: '✻ Cogitating… (12s · esc to interrupt)\n❯ ',
  idleMs: 0,
});
assert.ok(!working.confirm, 'no survey → no confirm keys');

// ---- source-lock: sendText pre-dismisses with the same regex ----
const sessionsSrc = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
assert.ok(sessionsSrc.includes('CLAUDE_SURVEY_RX.test('), 'sendText() pre-dismisses the survey before typing');

console.log('feedback_survey_gate: all assertions passed');
