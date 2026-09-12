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
import { classify, CLAUDE_SURVEY_RX, terminalQuestionPrompt, terminalTrustPrompt, trustConfirmKeys } from '../src/detect_classify.js';

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
// Claude's current screen highlights "No, exit", so Enter alone destroys the session before the task
// begins. The selector must move to the visible affirmative option first.
const CURRENT_CLAUDE_TRUST = [
  'Quick safety check: Is this a project you created or one you trust?',
  "If not, take a moment to review what's in this folder first.",
  "Claude Code'll be able to read, edit, and execute files here.",
  '❯ No, exit',
  '  Yes, I trust this folder',
  'Enter to confirm · Esc to cancel',
].join('\n');
const trust = classify({
  session: { id: 's_test_trust', tool: 'claude', autonomy: 'full' },
  snap: CURRENT_CLAUDE_TRUST,
  idleMs: 1000,
});
assert.deepEqual(trust.confirm, ['down', 'enter'], 'current Claude trust gate moves off default No before confirming');
assert.deepEqual(trustConfirmKeys('Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\nEnter to confirm'), ['enter'],
  'older trust screen already highlighting Yes still confirms in place');

const parsedTrust = terminalTrustPrompt(CURRENT_CLAUDE_TRUST);
assert.equal(parsedTrust.question.split('\n')[0], 'Quick safety check: Is this a project you created or one you trust?',
  'the terminal question is preserved verbatim for Story');
assert.deepEqual(parsedTrust.options.map((option) => option.label), ['No, exit', 'Yes, I trust this folder'],
  'Story receives the exact visible terminal choices');
assert.deepEqual(parsedTrust.options[1].keys, ['down', 'enter'], 'the affirmative Story choice has safe menu navigation');
assert.deepEqual(trustConfirmKeys(CURRENT_CLAUDE_TRUST.replace('created or one you trust?', 'created or one you\ntrust?')), ['down', 'enter'],
  'a narrow phone-sized pane may wrap the trust question without disabling safe confirmation');

const askTrust = classify({
  session: { id: 's_test_trust_ask', tool: 'claude', autonomy: 'ask' },
  snap: CURRENT_CLAUDE_TRUST,
  idleMs: 1000,
});
assert.equal(askTrust.status, 'waiting', 'ask mode surfaces the trust gate instead of answering it');
assert.match(askTrust.question, /Quick safety check:[\s\S]*No, exit[\s\S]*Yes, I trust this folder/,
  'the durable question includes the exact prompt and choices used by Story/Needs You');

const ambiguousTrust = classify({
  session: { id: 's_test_trust_unknown', tool: 'claude', autonomy: 'full' },
  snap: 'Do you trust this folder?\n  No, exit\n  Yes, I trust this folder\nEnter to confirm',
  idleMs: 1000,
});
assert.equal(ambiguousTrust.status, 'waiting', 'unknown highlight fails closed to an operator question');
assert.ok(!ambiguousTrust.confirm, 'unknown highlight never receives blind keys');
assert.equal(terminalTrustPrompt(`${CURRENT_CLAUDE_TRUST}\n❯ This is a report quoting the menu\n⏵⏵ bypass permissions on`), null,
  'a trust menu quoted above a live composer is inert');

const yesNo = terminalQuestionPrompt('Remove the generated folder? (y/n)');
assert.equal(yesNo.question, 'Remove the generated folder? (y/n)', 'plain terminal confirmation is copied exactly');
assert.deepEqual(yesNo.options.map((option) => [option.label, option.keys]), [
  ['Yes', ['y', 'enter']], ['No', ['n', 'enter']],
], 'plain terminal confirmation becomes safe explicit Story controls');

const numbered = terminalQuestionPrompt('Choose a recovery path:\n❯ 1. Resume from summary\n  2. Resume full session as-is\nEnter to confirm');
assert.equal(numbered.question, 'Choose a recovery path:', 'numbered terminal question is copied exactly');
assert.deepEqual(numbered.options[1].keys, ['down', 'enter'], 'numbered Story choice navigates from the actual highlight');

// ---- source-locks: the wiring that keeps both incidents fixed ----
const sessionsSrc = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
assert.ok(sessionsSrc.includes('CLAUDE_SURVEY_RX.test('), 'sendText() pre-dismisses the survey before typing');
assert.ok(/CLAUDE_SURVEY_RX\.test\(.*slice\(-12\)/.test(sessionsSrc), 'sendText survey check is scoped to the live tail, not the whole scrollback');
const detectSrc = readFileSync(new URL('../src/detect_classify.js', import.meta.url), 'utf8');
const rulesBlock = detectSrc.slice(detectSrc.indexOf('const CONFIRM_RULES'), detectSrc.indexOf('function autoConfirmKeys'));
assert.ok(!rulesBlock.includes('CLAUDE_SURVEY_RX'), 'the survey must not be an ambient CONFIRM_RULES gate');
assert.ok(!rulesBlock.includes('do you trust'), 'trust is selected from the highlighted menu, never a fixed Enter rule');

// Terminal-only questions are projected independently of native transcript parsing and are actionable
// in Story as either exact choice buttons or a free-text reply.
const storyApiSrc = readFileSync(new URL('../src/story_api.js', import.meta.url), 'utf8');
const storyViewSrc = readFileSync(new URL('../web/story-view.js', import.meta.url), 'utf8');
assert.match(storyApiSrc, /pendingQuestion[\s\S]*terminalQuestionPrompt/, 'Story API projects a live terminal-only question');
assert.match(storyViewSrc, /pendingQuestion[\s\S]*data-story-ask-reply/, 'Story renders a free-text reply for terminal-only questions');
assert.ok(storyViewSrc.includes('data-story-ask-opt'), 'Story renders exact native choices as buttons');
assert.match(sessionsSrc, /terminalQuestionPrompt\(screen\)[\s\S]*terminalChoice[\s\S]*sendKey/, 'Story choice labels navigate the live terminal menu');

// ---- multi-question ask "✔ Submit" parking (operator report 2026-07-17, s_07814eddc4) ----
// Answers picked through AIOS sat un-delivered on the final Submit step while the UI said "session
// resumed". sendText confirms Submit after a MENU answer — and ONLY there (post-answer, our own
// action), never ambiently from the poll loop: the 258-stray-'0's incident above is exactly what an
// ambient auto-keyer does to displayed text.
{
  const { askSubmitStepPending } = await import('../src/detect_classify.js');
  const allAnswered = '←  ☒ Default STT  ☒ Build scope  ✔ Submit  →\n\nReady to submit your answers.\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
  const midFlow = '←  ☒ Default STT  ☐ Build scope  ✔ Submit  →\n\nHow much to build in this first pass?\n❯ 1. Codex first\n  2. Both now\n\nEnter to select · Tab/Arrow keys to navigate';
  assert.equal(askSubmitStepPending(allAnswered), true, 'all questions answered + Submit tab → confirm');
  assert.equal(askSubmitStepPending(midFlow), false, 'a pending ☐ question means the operator is still needed — never blind-submit');
  assert.equal(askSubmitStepPending('❯ 1. yes\n  2. no\n\nEnter to select'), false, 'plain menus (codex, single-question) have no tab bar — no-op');
  assert.equal(askSubmitStepPending('the PR is ready — click Submit on GitHub when you approve'), false, 'prose mentioning Submit never matches');

  // wiring: the confirm lives in sendText's menu branch (after WE answered), not in classify/poll paths
  assert.ok(/if \(digit\) \{[\s\S]{0,400}askSubmitStepPending/.test(sessionsSrc.slice(sessionsSrc.indexOf('export async function sendText'))), 'Submit confirm runs only after a menu answer sendText itself delivered');
  const classifyBlock = detectSrc.slice(detectSrc.indexOf('export function classify'));
  assert.ok(!classifyBlock.includes('askSubmitStepPending'), 'the Submit detector is NOT an ambient classifier gate');
}

console.log('feedback_survey_gate: all assertions passed');
