import assert from 'node:assert/strict';
import { operatorInputPlan } from '../src/agent_input_ready.js';
import { stashClaudeComposer } from '../src/claude_composer.js';

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

for (const clears of [true, false]) {
  let t = 0, keys = 0, reads = 0;
  const result = await stashClaudeComposer({
    clock: () => t, pause: async ms => { t += ms; }, timeoutMs: 400,
    stash: async () => { keys++; },
    readScreen: async () => { reads++; return clears && reads >= 2 ? empty : screen; },
  });
  assert.equal(result, clears);
  assert.equal(keys, 1, 'never press a toggle twice and restore the draft');
}
console.log('claude_composer: passed (tall drafts, same-message retry, one stash, confirmed clear, Codex boundary)');
