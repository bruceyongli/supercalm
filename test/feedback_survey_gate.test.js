// claude feedback-survey handling — two incidents, one file:
// 1. "● How is Claude doing this session? … 0: Dismiss" swallows input: operator replies sat
//    typed-but-unsubmitted for hours (s_087cf6e228 ×3 + s_2587ee0851, 2026-07-12/13). Handled by
//    sendText()'s pre-dismiss, which self-heals a false match (C-u clears the '0' before typing).
// 2. The first fix ALSO made the survey an ambient CONFIRM_RULES gate — and a session that merely
//    QUOTED the survey wording in its own report received 258 stray '0's typed into its composer
//    (s_13bbb05537, 2026-07-13 01:28–01:56). Ambient auto-keying must never fire on text a pane can
//    merely display. This test is the red scenario locking that class out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, CLAUDE_SURVEY_RX } from '../src/detect_classify.js';

// Verbatim shape from the s_087cf6e228 pane capture.
const SURVEY_BLOCK = [
  '● How is Claude doing this session? (optional)',
  '  1: Bad    2: Fine   3: Good   0: Dismiss',
].join('\n');
const REAL_SURVEY_SCREEN = [
  '  Per your instruction I did not push, retag, or delete anything.',
  '✻ Churned for 1m 55s',
  SURVEY_BLOCK,
  '──────────────────────────────────────────────',
  '❯ I pushed main and the tags, verify again',
  '──────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');
// The incident screen: a session whose own REPORT quotes the survey (empty composer below).
const QUOTED_SURVEY_SCREEN = [
  '  Fix #2 — feedback-survey gate. The "How is Claude doing this session?" prompt',
  '  (1: Bad … 0: Dismiss) is now handled, verified live on s_087\'s pane.',
  SURVEY_BLOCK, // e.g. a captured screen shown verbatim in the transcript
  '✻ Sautéed for 30m 40s',
  '──────────────────────────────────────────────',
  '❯ ',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

// ---- regex (sendText's pre-dismiss depends on it): real block matches, loose prose doesn't ----
assert.ok(CLAUDE_SURVEY_RX.test(REAL_SURVEY_SCREEN), 'matches the captured survey screen');
assert.ok(CLAUDE_SURVEY_RX.test(SURVEY_BLOCK), 'matches the bare survey block');
assert.ok(!CLAUDE_SURVEY_RX.test('I wondered how is Claude doing this session? It went fine.'), 'prose without the menu must not match');
assert.ok(!CLAUDE_SURVEY_RX.test('0: Dismiss'), 'menu row alone must not match');

// ---- RED scenario: classify must NEVER auto-key on survey wording — quoted or real ----
for (const [label, snap] of [['quoted-in-transcript', QUOTED_SURVEY_SCREEN], ['real survey', REAL_SURVEY_SCREEN]]) {
  for (const autonomy of ['full', 'auto', 'ask']) {
    const r = classify({ session: { id: 's_test_survey', tool: 'claude', autonomy }, snap, idleMs: 60_000 });
    assert.ok(!r.confirm, `${label} / autonomy=${autonomy}: no ambient keys may be sent`);
  }
}

// The genuine gates still auto-confirm for autonomous sessions (the removal must not overreach).
const trust = classify({
  session: { id: 's_test_trust', tool: 'claude', autonomy: 'full' },
  snap: 'Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder',
  idleMs: 1000,
});
assert.ok(Array.isArray(trust.confirm) && trust.confirm.length, 'trust gate still auto-confirms');

// ---- source-locks: the wiring that keeps both incidents fixed ----
const sessionsSrc = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
assert.ok(sessionsSrc.includes('CLAUDE_SURVEY_RX.test('), 'sendText() pre-dismisses the survey before typing');
assert.ok(/CLAUDE_SURVEY_RX\.test\(.*slice\(-12\)/.test(sessionsSrc), 'sendText survey check is scoped to the live tail, not the whole scrollback');
const detectSrc = readFileSync(new URL('../src/detect_classify.js', import.meta.url), 'utf8');
const rulesBlock = detectSrc.slice(detectSrc.indexOf('const CONFIRM_RULES'), detectSrc.indexOf('function autoConfirmKeys'));
assert.ok(!rulesBlock.includes('CLAUDE_SURVEY_RX'), 'the survey must not be an ambient CONFIRM_RULES gate');

console.log('feedback_survey_gate: all assertions passed');
