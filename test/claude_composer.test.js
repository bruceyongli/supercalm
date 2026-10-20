import assert from 'node:assert/strict';
import { operatorInputPlan, agentInputReady } from '../src/agent_input_ready.js';
import { stashClaudeComposer, normalizeClaudeInputScreen, CLAUDE_COMPOSER_FOOTER, claudeOwnedPaste } from '../src/claude_composer.js';

const footer = '⏵⏵ bypass permissions on (shift+tab to cycle)';
const empty = `❯\n${footer}`;
const old = Array.from({ length: 33 }, (_, i) => `旧问题第 ${i} 行：尚未发送。`).join('\n');
const screen = `Previous API Error: 429\n${'─'.repeat(40)}\n❯ ${old}\n${'─'.repeat(40)}\n${footer}`;
const claudeOptions = { allowActive: true, strictComposer: true, draftMaxLines: 768 };
assert.equal(operatorInputPlan(screen, 'new request', { allowActive: true }).target, 'active-agent', 'reproduce old short-window misclassification');
assert.equal(operatorInputPlan(screen, 'new request', claudeOptions).reason, 'pending-draft', 'Claude identifies the entire tall draft');
assert.equal(operatorInputPlan(screen, old, claudeOptions).target, 'existing-draft', 'retry submits without repasting');
assert.equal(operatorInputPlan(screen, 'new request', { ...claudeOptions, replacePendingDraft: true }).target, 'replace-draft');
assert.equal(operatorInputPlan(`unknown tool screen\n${footer}`, 'new request', claudeOptions).ready, false, 'footer alone is not an empty composer');
assert.equal(operatorInputPlan(`unknown tool screen\n${footer}`, 'new request', { allowActive: true }).target, 'active-agent', 'Codex/generic readiness stays unchanged');
assert.equal(operatorInputPlan(`❯\n  multiline draft starting with a newline\n${footer}`, 'new request', claudeOptions).reason, 'pending-draft', 'blank first line is not an empty buffer');
const rule = '─'.repeat(40);
const emptyPasteHint = `${rule}\n❯\n${rule}\n  paste again to expand`;
assert.equal(agentInputReady(emptyPasteHint), false, 'generic readiness contract stays unchanged');
assert.equal(operatorInputPlan(emptyPasteHint, 'new request', { ...claudeOptions, draftFooterPattern: CLAUDE_COMPOSER_FOOTER }).target, 'composer');
assert.equal(await stashClaudeComposer({ stash: async () => {}, readScreen: async () => emptyPasteHint, pause: async () => {} }), true,
  'real Claude keeps its paste hint even after successfully stashing the previous folded draft');
const ghost = `${rule}\n❯ \x1b[2mkeep iterating, report iteration 15 when it's done\x1b[0m\n${rule}\n${footer}\n${'\n'.repeat(45)}`;
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(ghost), 'new request', claudeOptions).target, 'composer', 'arbitrary dim suggestion is not a draft despite bottom padding');
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(ghost.replace('\x1b[2m', '').replace('\x1b[0m', '')), 'new request', claudeOptions).reason, 'pending-draft', 'identical real typed words remain a real draft');
const suffix = `${rule}\n❯ Real request\x1b[2m ghost suffix\x1b[22m\n${rule}\n${footer}`;
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(suffix), 'Real request', claudeOptions).target, 'existing-draft', 'typed prefix survives ghost suffix');
const colored = `${rule}\n❯ \x1b[38;2;2;22;0mActual typed request\x1b[39m\n${rule}\n${footer}`;
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(colored), 'different request', claudeOptions).reason, 'pending-draft', 'RGB payload never sets dim');
const report = `\x1b[2mImportant report text\x1b[22m\n${ghost}`;
assert.ok(normalizeClaudeInputScreen(report).includes('Important report text'), 'dim report content outside the composer is retained');

const owned = (display, text, before = '') => claudeOwnedPaste({
  draft: { text: display.replace(/\n/g, ' '), lines: display.split('\n') },
  beforeDraft: { text: before.replace(/\n/g, ' '), lines: before.split('\n') }, text,
});
for (const display of [
  '[Image #14] [Image #15][Pasted text #16 +4 lines]',
  '[Pasted text #16 +4 lines] [Image #14] [Image #15]',
  '[Image #14]\n[Image #15][Pasted text #16 +4 li\nnes]',
  '[Image #14] [Image #15][Pasted text #16 +4 lines][Pasted content #17 +2 lines]',
]) assert.equal(owned(display, 'Compare /tmp/first.png /tmp/second.png and explain the differences.'), true, display);
assert.equal(owned('[Pasted text #1 +20 lines]', 'Long request'), true);
assert.equal(owned('[Image #1] [Image #2]', '/tmp/a.png /tmp/b.jpg'), true, 'an actual image-only send');
assert.equal(owned('[Image #1] Explain this', '/tmp/a.png Explain this'), true, 'short unfolded text with an image chip');
assert.equal(owned('[Image #1] Explain this', '"/tmp/a screenshot.png" Explain this'), true, 'quoted image paths with spaces');
assert.equal(owned('[Image #1][Image #2][Pasted text #3 +4 lines]',
  'Please compare.\n\nAttached files available locally to this coding CLI:\n1. Screenshot 1.png (PNG, image/png): /tmp/Screenshot 1.png\n2. 第二张截图.png (PNG, image/png): /tmp/第二张 截图.png'), true,
  'real upload manifest paths can contain spaces and Unicode');
assert.equal(owned('Explain [Image #1] please', 'Explain /tmp/a.png please'), true);
assert.equal(owned('Start [Pasted text #1 +4 lines] finish', 'Start with a detailed discussion and finish'), true);
assert.equal(owned('[Image #1] [Image #2]', '/tmp/a.png /tmp/b.jpg Please review these'), false, 'images arrived before the text');
assert.equal(owned('[Image #1] [Pasted text #2 +4 lines]', 'Plain text without an image'), false);
assert.equal(owned('[Pasted text #1 +4 lines] unrelated draft', 'Expected request'), false);
assert.equal(owned('[Pasted text #1 +4 lines]', 'Discuss [Pasted text #1 +4 lines] syntax'), false, 'literal quoted chips are not ownership proof');
assert.equal(owned('[Image #1] [Pasted text #2 +4 lines]', '/tmp/a.png Explain this', '[Image #1]'), false, 'old chips mixed into a new draft are not owned');
assert.equal(owned('[Image #1][Image #1][Pasted text #2 +4 lines]', '/tmp/a.png /tmp/b.png Explain'), false, 'duplicated repaint chips must settle');
assert.equal(owned('[Image #1][Pasted text #2 +4 lines]', '/tmp/a.png Explain', '[Image #1][Pasted text #2 +4 li\nnes]'), false, 'wrapped old chips remain old');

for (const clears of [true, false]) {
  let t = 0, keys = 0, reads = 0;
  const result = await stashClaudeComposer({
    clock: () => t, pause: async ms => { t += ms; }, timeoutMs: 400,
    stash: async () => { keys++; },
    readScreen: async () => { reads++; return clears && reads >= 2 ? ghost : screen; },
  });
  assert.equal(result, clears);
  assert.equal(keys, 1, 'never press a toggle twice and restore the draft');
}
console.log('claude_composer: passed (tall drafts, same-message retry, one stash, confirmed clear, Codex boundary)');
