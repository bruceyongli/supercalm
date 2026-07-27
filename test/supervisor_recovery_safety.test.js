import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentInputReady, pendingComposerDraft } from '../src/agent_input_ready.js';
import { emptyKernelState, evaluateSend, rebaseKernelForNewPane } from '../src/agents/send_kernel.js';
import { recoveryAttempt } from '../src/agents/exit_recovery.js';

assert.equal(agentInputReady('Starting MCP servers (0/2)…\nloading'), false, 'startup text is not an input target');
assert.equal(agentInputReady('old transcript\n› Implement {feature}\ngpt-5.5 xhigh · /tmp/lab'), true, 'Codex composer is ready');
assert.equal(agentInputReady('old transcript\n❯ Ask Claude something\nbypass permissions on'), true, 'Claude composer is ready');
assert.equal(agentInputReady('› old operator request\ngpt-5.5 xhigh · /tmp/lab'), false, 'a recent transcript prompt is not a composer');
assert.equal(agentInputReady('› Implement {feature}\nStarting MCP servers (0/2)…'), false, 'placeholder without the ready footer is startup, not readiness');
assert.equal(agentInputReady('› quoted old prompt\n' + 'startup\n'.repeat(20)), false, 'a stale prompt outside the visible tail is not readiness');
assert.deepEqual(pendingComposerDraft('agent report\n❯ cut over\n'), { marker: '❯', text: 'cut over' });
assert.equal(pendingComposerDraft('agent report\n❯ Ask Claude something\n'), null, 'idle placeholder is not an operator draft');

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
