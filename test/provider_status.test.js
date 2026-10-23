import assert from 'node:assert/strict';
import { detectProviderIssue, providerIssue, providerIssueMessage } from '../src/provider_status.js';
import { classify, clearHookState } from '../src/detect_classify.js';
import { sessionIndicator } from '../web/session-indicator.js';

const message = 'Selected model is at capacity. Please try a different model.';
const blocked = { code: 'capacity', phase: 'blocked' };
const retrying = { code: 'capacity', phase: 'retrying' };
for (const tool of ['codex', 'claude', 'agy']) {
  const session = { id: `s_capacity_${tool}`, tool, status: 'waiting', autonomy: 'ask' };
  clearHookState(session.id);
  for (const screen of [message, `■ ${message}`, `\x1b[31m■ ${message}\x1b[0m`,
    '■ Selected model is at capacity. Please try a\n  different model.',
    `Edited test.js (+1 -1)\n+ Show details\n■ ${message}\nAsk Codex to do anything`,
    `■ ${message}\n\n› my unsent message\n  must stay intact\n? for shortcuts`,
  ]) {
    assert.deepEqual(detectProviderIssue(screen, { tool }), blocked, `${tool}: ${screen}`);
    const result = classify({ session, snap: screen, idleMs: 10000 });
    assert.deepEqual(result.providerIssue, blocked);
    assert.equal(result.status, 'waiting', 'the process stays alive; provider state distinguishes the blocker');
    assert.equal(result.question, providerIssueMessage(blocked));
    assert.equal(result.confirm, undefined, 'no synthetic keys, retry or model switch');
  }
}
for (const tail of ['Retrying in 10 seconds…', 'Retrying 1/5…', 'Reconnecting... 2/5']) {
  const screen = `■ ${message}\n${tail}\n› \n? for shortcuts`;
  assert.deepEqual(detectProviderIssue(screen), retrying, tail);
  assert.equal(classify({ session: { id: 's_retry', tool: 'codex' }, snap: screen, idleMs: 10000 }).status, 'working');
}
for (const screen of [
  `The error was: "${message}"`, `> ■ ${message}`, `"${message}"`,
  `const fixture = "${message}"`, `| Error | ${message} |`,
  `\`\`\`text\n■ ${message}\n\`\`\``,
  `› ${message}\n? for shortcuts`, `› Please investigate:\n  ${message}\n? for shortcuts`,
  `■ ${message}\n• Fixed the issue; all changes are ready.`,
  `■ ${message}\n⏺ Updated the implementation.`,
  `■ ${message}\nWorking… (10s · esc to interrupt)`,
  `■ ${message}\n› Retry\n• Working… (10s · esc to interrupt)`,
  `■ ${message}\n› Retry\n• Completed the requested update.`,
]) {
  const tool = screen.includes('⏵') ? 'claude' : 'codex';
  assert.equal(detectProviderIssue(screen, { tool }), null, `not a live capacity failure: ${screen}`);
}
const claude = `⏺ ${message}\n────────\n❯ please retry\n────────\n⏵⏵ bypass permissions on (shift+tab to cycle)`;
assert.deepEqual(detectProviderIssue(claude, { tool: 'claude' }), blocked);
assert.equal(detectProviderIssue(`⏺ Normal report\n────────\n❯ ${message}\n────────\n⏵⏵ bypass permissions on`, { tool: 'claude' }), null);
assert.deepEqual(providerIssue(JSON.stringify(blocked)), blocked);
assert.equal(providerIssue('{broken'), null);
assert.equal(providerIssue({ code: 'arbitrary', phase: 'blocked' }), null);
assert.equal(sessionIndicator({ status: 'waiting', provider_issue: blocked }).dot, 'error');
assert.equal(sessionIndicator({ status: 'waiting', provider_issue: blocked }).label, 'Model at capacity');
assert.equal(sessionIndicator({ status: 'working', provider_issue: retrying }).label, 'Retrying');
assert.equal(sessionIndicator({ status: 'waiting' }).dot, 'warn');
assert.equal(sessionIndicator({ status: 'working' }).dot, 'ok pulse');
assert.equal(sessionIndicator({ status: 'exited', provider_issue: blocked }).label, 'Stopped');
console.log('provider_status.test ok');
