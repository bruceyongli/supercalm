import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  agentInputReady,
  claudeResumePrompt,
  codexComposerPlaceholder,
  operatorInputBlockMessage,
  operatorInputDisposition,
  operatorInputPlan,
  pendingComposerDraft,
  pendingDraftMatches,
} from '../src/agent_input_ready.js';
import { emptyKernelState, evaluateSend, rebaseKernelForNewPane } from '../src/agents/send_kernel.js';
import { recoveryAttempt } from '../src/agents/exit_recovery.js';

assert.equal(agentInputReady('Starting MCP servers (0/2)…\nloading'), false, 'startup text is not an input target');
assert.equal(agentInputReady('old transcript\n› Implement {feature}\ngpt-5.5 xhigh · /tmp/lab'), true, 'Codex composer is ready');
for (const hint of ['Explain this codebase', 'Summarize recent commits', 'Run /review on my current changes', 'Write tests for @filename']) {
  assert.equal(codexComposerPlaceholder(hint), true, `${hint} is a known Codex composer hint`);
  assert.equal(agentInputReady(`old transcript\n› ${hint}\ngpt-5.6-sol xhigh · /tmp/lab`), true, `${hint} does not block an idle Codex composer`);
}
assert.equal(codexComposerPlaceholder('Run the API check for me'), false, 'real operator prose is not a composer hint');
assert.equal(agentInputReady('old transcript\n❯ Ask Claude something\nbypass permissions on'), true, 'Claude composer is ready');
assert.equal(agentInputReady('› old operator request\ngpt-5.5 xhigh · /tmp/lab'), false, 'a recent transcript prompt is not a composer');
assert.equal(agentInputReady('› Implement {feature}\nStarting MCP servers (0/2)…'), false, 'placeholder without the ready footer is startup, not readiness');
assert.equal(agentInputReady('› quoted old prompt\n' + 'startup\n'.repeat(20)), false, 'a stale prompt outside the visible tail is not readiness');

const claudeResume = `Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.
❯ 1. Resume from summary (recommended)
2. Resume full session as-is
3. Don't ask me again
Enter to confirm   Esc to cancel`;
assert.equal(claudeResumePrompt(claudeResume), true, 'the Claude post-recovery resume modal is recognized');
assert.equal(agentInputReady(claudeResume), false, 'a resume modal is not a text composer');
assert.deepEqual(operatorInputDisposition(claudeResume), { ready: false, reason: 'resume-choice' }, 'free text is held at a resume modal');
assert.deepEqual(operatorInputDisposition(claudeResume, { menuAnswer: true }), { ready: true, target: 'choice-menu' }, 'an explicit options-form answer may operate the resume modal');
assert.deepEqual(operatorInputDisposition('Compacting conversation…\nLoading'), { ready: false, reason: 'agent-compacting' }, 'compaction gets its own truthful block reason');
assert.deepEqual(operatorInputDisposition('Starting MCP servers (0/2)…'), { ready: false, reason: 'agent-starting' }, 'startup gets its own truthful block reason');
assert.deepEqual(operatorInputDisposition('Loading session…'), { ready: false, reason: 'agent-loading' }, 'loading gets its own truthful block reason');
assert.deepEqual(
  operatorInputDisposition('⏺ Working…\nesc to interrupt\n⏵⏵ bypass permissions on', { allowActive: true }),
  { ready: true, target: 'active-agent' },
  'an authenticated operator can still interrupt or steer a live working turn',
);
assert.deepEqual(
  operatorInputDisposition('Compacting conversation…\nesc to interrupt\n⏵⏵ bypass permissions on', { allowActive: true }),
  { ready: false, reason: 'agent-compacting' },
  'a transient compaction screen cannot masquerade as an interruptible turn',
);
assert.deepEqual(pendingComposerDraft('agent report\n❯ cut over\n'), { marker: '❯', text: 'cut over' },
  'provenance inspection retains an unsubmitted display draft even when the saved tail omits its footer');
assert.deepEqual(operatorInputDisposition('agent report\n❯ cut over\n'), { ready: false, reason: 'input-unavailable' },
  'delivery still requires a live footer and never treats a bare transcript prompt as an input target');
assert.equal(pendingComposerDraft('agent report\n❯ Ask Claude something\n'), null, 'idle placeholder is not an operator draft');
assert.equal(pendingComposerDraft('agent report\n› Run /review on my current changes\ngpt-5.6-sol xhigh · /tmp/lab'), null,
  'a rotating Codex placeholder is not an unsubmitted operator draft');
assert.deepEqual(
  operatorInputDisposition('agent report\n❯ rename that garbled session title\n⏵⏵ bypass permissions on'),
  { ready: false, reason: 'pending-draft', draft: 'rename that garbled session title' },
  'a native Terminal draft is identified accurately instead of mislabeled as a resuming session',
);
const framedClaudeDraft = `✻ Cooked for 27s

────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ check the preview button on my phone
────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · install gh for PR status · ← for agents
                                                                                         100% context used`;
assert.deepEqual(pendingComposerDraft(framedClaudeDraft), { marker: '❯', text: 'check the preview button on my phone' },
  'Claude horizontal rules are composer chrome, not evidence that the session is resuming');
assert.deepEqual(operatorInputDisposition(framedClaudeDraft), {
  ready: false, reason: 'pending-draft', draft: 'check the preview button on my phone',
}, 'the exact live incident is classified as an unfinished Terminal draft');
assert.deepEqual(operatorInputDisposition('Compacting conversation…\n' + framedClaudeDraft), {
  ready: false, reason: 'pending-draft', draft: 'check the preview button on my phone',
}, 'a real composer outranks stale compaction words higher in scrollback');
const wrappedClaudeDraft = framedClaudeDraft.replace('check the preview button on my phone', 'check the preview button on my phone\n   and keep the previous screenshots visible');
assert.deepEqual(pendingComposerDraft(wrappedClaudeDraft), {
  marker: '❯', text: 'check the preview button on my phone and keep the previous screenshots visible',
}, 'wrapped Claude composer text is preserved as one draft');
assert.deepEqual(operatorInputDisposition('unrecognized full-screen tool output'), { ready: false, reason: 'input-unavailable' },
  'an unknown screen is never mislabeled as a resuming session');
for (const reason of ['resume-choice', 'pending-draft', 'agent-starting', 'agent-compacting', 'agent-loading', 'input-unavailable']) {
  const message = operatorInputBlockMessage(reason);
  assert.ok(message.length > 20, `${reason} has a useful operator message`);
  assert.doesNotMatch(message, /still resuming/i, `${reason} never invents a resuming state`);
}
assert.equal(pendingDraftMatches('rename that garbled session…', 'rename that garbled session title so it is readable'), true,
  'Claude capture-pane ellipsis still identifies a retry of the same draft');
assert.deepEqual(
  operatorInputPlan('agent report\n❯ same request\n⏵⏵ bypass permissions on', 'same request'),
  { ready: true, target: 'existing-draft', draft: 'same request' },
  'retrying the same Story text submits the settled Terminal draft rather than retyping it',
);
assert.deepEqual(
  operatorInputPlan('agent report\n❯ older draft\n⏵⏵ bypass permissions on', 'new Story request', { replacePendingDraft: true }),
  { ready: true, target: 'replace-draft', draft: 'older draft' },
  'an explicit replacement makes a different Story request deliverable',
);

const recoveryWindow = 15 * 60_000;
const episode = { exitRecoveryKey: 'exit-1', exitRecoveryAttempt: 1, exitRecoveryLastAt: 5_000, exitRecoveryResolved: false };
assert.equal(recoveryAttempt(episode, 'exit-1', 6_000, recoveryWindow), 1, 'same exit retains its attempt');
assert.equal(recoveryAttempt(episode, 'exit-2', 6_000, recoveryWindow), 1, 'a prompt chained crash retains the bounded episode');
assert.equal(recoveryAttempt({ ...episode, exitRecoveryResolved: true }, 'exit-2', 6_000, recoveryWindow), 0, 'resolved recovery starts a later episode');
assert.equal(recoveryAttempt(episode, 'exit-2', 5_000 + recoveryWindow + 1, recoveryWindow), 0, 'expired recovery starts a later episode');
assert.equal(recoveryAttempt(episode, 'exit-2', 4_000, recoveryWindow), 0, 'clock reversal cannot join an old episode');

const t0 = 1_800_000_000_000;
const proposal = { kind: 'recover', text: 'resume the current task', paneSig: 'old-pane', intentName: 'RECOVER_NOTE', budgetKey: 'recovery-task' };
const first = evaluateSend(emptyKernelState(), proposal, t0);
assert.equal(first.allowed, true);
const rebased = rebaseKernelForNewPane(first.state);
assert.equal(rebased.lastSendTs, 0, 'new pane clears the old pane minimum-gap clock');
assert.deepEqual(rebased.ring, [], 'new pane clears pane-local dedupe history');
assert.equal(rebased.pending, null, 'old pane receipt cannot remain pending');
assert.deepEqual(rebased.hour, first.state.hour, 'rolling-hour abuse bound survives relaunch');
assert.deepEqual(rebased.budgets, first.state.budgets, 'work-item budget survives relaunch');
const second = evaluateSend(rebased, { ...proposal, paneSig: 'new-pane' }, t0 + 10_000);
assert.equal(second.allowed, true, 'one recovery note can reach a replacement pane without waiting 90 seconds');

const supervisor = readFileSync(new URL('../src/agents/supervisor.js', import.meta.url), 'utf8');
assert.match(supervisor, /resumeSession\(\{ force: true, waitForInput: true \}\)/, 'unexpected-exit recovery waits for a real composer');
assert.match(supervisor, /recoveryAttempt\(st, exitKey, t, EXIT_RECOVERY_WINDOW_MS\)/, 'supervisor uses the tested bounded-attempt transition');
assert.match(supervisor, /if \(r\.sent\)[\s\S]{0,160}Recovered exited session/, 'success notification requires actual delivery');
assert.match(supervisor, /Session relaunched; recovery blocked/, 'failed delivery is reported honestly');

console.log('supervisor_recovery_safety.test ok');
