import assert from 'node:assert/strict';
import { operatorInputPlan } from '../src/agent_input_ready.js';
import { stashClaudeComposer, normalizeClaudeInputScreen } from '../src/claude_composer.js';

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
const ghost = `${rule}\n❯ \x1b[2mkeep iterating, report iteration 15 when it's done\x1b[0m\n${rule}\n${footer}\n${'\n'.repeat(45)}`;
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(ghost), 'new request', claudeOptions).target, 'composer', 'arbitrary dim suggestion is not a draft despite bottom padding');
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(ghost.replace('\x1b[2m', '').replace('\x1b[0m', '')), 'new request', claudeOptions).reason, 'pending-draft', 'identical real typed words remain a real draft');
const suffix = `${rule}\n❯ Real request\x1b[2m ghost suffix\x1b[22m\n${rule}\n${footer}`;
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(suffix), 'Real request', claudeOptions).target, 'existing-draft', 'typed prefix survives ghost suffix');
const colored = `${rule}\n❯ \x1b[38;2;2;22;0mActual typed request\x1b[39m\n${rule}\n${footer}`;
assert.equal(operatorInputPlan(normalizeClaudeInputScreen(colored), 'different request', claudeOptions).reason, 'pending-draft', 'RGB payload never sets dim');
const report = `\x1b[2mImportant report text\x1b[22m\n${ghost}`;
assert.ok(normalizeClaudeInputScreen(report).includes('Important report text'), 'dim report content outside the composer is retained');

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
