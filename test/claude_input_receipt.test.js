import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeInputReceipt, claudeInputRecordReceipt } from '../src/claude_input_receipt.js';
import { submitAgentComposer } from '../src/agent_submit.js';
import { claudeResumeId } from '../src/claude_transcripts.js';

const dir = await mkdtemp(join(tmpdir(), 'aios-claude-receipt-'));
const nativeId = '12345678-1234-1234-1234-123456789abc';
const text = 'Keep working. Report when the acceptance is done.';
const queued = { type: 'queue-operation', operation: 'enqueue', sessionId: nativeId, content: text };
try {
  const file = join(dir, `${nativeId}.jsonl`);
  await writeFile(file, JSON.stringify(queued) + '\n');
  const readReceipt = await createClaudeInputReceipt(file, text);
  assert.equal(await readReceipt(), null, 'an old identical message cannot acknowledge a new transaction');
  const line = JSON.stringify(queued) + '\n';
  await appendFile(file, line.slice(0, -5));
  assert.equal(await readReceipt(), null, 'a partial native write is not submission');
  await appendFile(file, line.slice(-5));
  assert.deepEqual(await readReceipt(), { queued: true, receipt: 'claude-native-queue' });
  assert.equal(claudeInputRecordReceipt({ ...queued, sessionId: 'another' }, { text, nativeId }), null);
  assert.equal(claudeInputRecordReceipt({ ...queued, operation: 'remove' }, { text, nativeId }), null);
  assert.equal(claudeInputRecordReceipt({ type: 'user', sessionId: nativeId, isSidechain: true, message: { content: text } }, { text, nativeId }), null);
  assert.equal(claudeInputRecordReceipt({ type: 'user', sessionId: nativeId, promptSource: 'system', message: { content: text } }, { text, nativeId }), null);
  assert.equal(claudeInputRecordReceipt({ type: 'user', sessionId: nativeId, message: { content: [{ type: 'text', text }] } }, { text, nativeId }).queued, false);
  assert.equal(claudeResumeId(file), nativeId);
  assert.equal(claudeResumeId('/native/../not-a-uuid.jsonl'), null);
  assert.equal(claudeResumeId('/native/agent-12345678-1234-1234-1234-123456789abc.jsonl'), null);
  // Regression: a queued message is accepted even if the CLI is busy and its repaint leaves a
  // stale/mismatched composer. Wait for native evidence, never paste/Enter somebody else's draft.
  let now = 0, enters = 0;
  const result = await submitAgentComposer({ text, before: '❯\nbypass permissions on',
    clock: () => now, pause: async ms => { now += ms; },
    readScreen: async () => `❯ ${enters ? 'a stale busy repaint' : text}\nbypass permissions on`,
    pressEnter: async () => { enters++; },
    confirmSubmission: async () => now > 1800 ? { queued: true, receipt: 'claude-native-queue' } : null,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.queued, true);
  assert.equal(enters, 1, 'a native queue receipt never retries or interrupts the agent');
  process.env.AIOS_DATA = join(dir, 'data');
  const { TOOLS } = await import('../src/config.js');
  const ask = TOOLS.claude.argv(null, { autonomy: 'ask', resume: true, resumeId: nativeId });
  assert.deepEqual(ask.slice(0, 3), ['claude', '--resume', nativeId]);
  assert.deepEqual(ask.slice(3), ['--permission-mode', 'default'], 'ask does not inherit the new CLI auto default');
  assert.ok(TOOLS.claude.argv(null, { resume: true }).includes('--continue'), 'legacy unbound conversations retain compatibility');
  assert.ok(TOOLS.codex.argv(null, { resume: true, resumeId: nativeId }).includes(nativeId), 'Codex identity remains unchanged');
  const refreshed = TOOLS.claude.argv(null, { resume: true, resumeId: nativeId, appendPrompt: 'Current project rules.', refreshSystemPrompt: true });
  assert.ok(refreshed.includes('--system-prompt-snapshot'));
  assert.equal(refreshed[refreshed.indexOf('--system-prompt-snapshot') + 1], 'off');
  assert.ok(!TOOLS.claude.argv(null, { resume: true, appendPrompt: 'Rules.' }).includes('--system-prompt-snapshot'), 'unsupported Claude builds never receive an unknown flag');
  assert.ok(!TOOLS.claude.argv('task', { appendPrompt: 'Rules.', refreshSystemPrompt: true }).includes('--system-prompt-snapshot'), 'fresh launches keep the native prompt-cache default');
  assert.ok(!TOOLS.codex.argv(null, { resume: true, resumeId: nativeId, appendPrompt: 'Rules.', refreshSystemPrompt: true }).includes('--system-prompt-snapshot'), 'Claude snapshot option cannot leak into Codex');
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('claude_input_receipt: exact new native queue/consumption, no duplicate sends, bounded reads and pinned resume/permissions passed');
