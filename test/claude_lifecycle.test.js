import assert from 'node:assert/strict';
import { classify, setHookState, clearHookState } from '../src/detect_classify.js';
import { rememberClaudeHook, clearClaudeLifecycle, claudeTerminalFrame, claudeBackgroundWork, normalizeClaudeHook } from '../src/claude_lifecycle.js';
import { askMenuTypeDigit, agentInputReady, claudeResumePrompt } from '../src/agent_input_ready.js';

const session = { id: 's_claude_lifecycle', tool: 'claude', autonomy: 'full' };
const pane = (count = 4, draft = '') => `⏺ Acceptance is still running. I'll report when its results arrive.\n\n✻ Baked for 8m 6s · done 3:59 AM · ${count} shells still running\n────────────────────────────────────\n❯ ${draft}\n────────────────────────────────────\n⏵⏵ bypass permissions on · ${count} shells · ← for agents · ↓ to manage\n`;
const decide = (snap, idleMs = 20 * 3600_000) => classify({ session, snap, idleMs });
const hook = (event, extra = {}) => rememberClaudeHook(session.id, { event, ...extra });
assert.equal(decide(pane()).status, 'working', 'quiet Claude shells do not time out into Needs You');
assert.equal(decide(pane(1)).status, 'working', 'singular native shell is recognized');
assert.equal(decide(pane(0).replace('✻ Baked for 8m 6s · done 3:59 AM · 0 shells still running', '✶ Brewing… (6m 58s · ↓ 19.2k tokens)').replace('0 shells ·', 'esc to interrupt ·')).status,
  'working', 'new arbitrary Claude spinner verbs retain the real live interrupt indicator');
assert.equal(decide(pane(0, 'Unsent operator draft, do not call it a report')).status, 'waiting');
assert.doesNotMatch(decide(pane(0, 'Unsent operator draft, do not call it a report')).question, /Unsent|Baked|shells|bypass|manage/);
assert.equal(claudeTerminalFrame(pane()).count, 4);
assert.equal(claudeTerminalFrame('The report quotes "4 shells still running"'), null);
assert.equal(decide(`⏺ Example: 4 shells still running\n${pane(0)}`).status, 'waiting', 'quoted counts are not runtime evidence');
assert.equal(decide(pane(4).replace('4 shells ·', '2 shells · 2 agents ·')).status, 'working');

const tasks = [{ id: 'acceptance', type: 'shell', status: 'running', command: 'until test -f results.json; do sleep 15; done', description: 'Wait for acceptance' }];
let r = hook('Stop', { background_tasks: tasks, session_crons: [], last_assistant_message: 'Waiting for results.' });
assert.equal(r.status, 'working', 'Stop means foreground response ended, not background work ended');
assert.equal(decide('⏺ Waiting for acceptance results.\n✻ Baked for 8m 6s\n❯\nbypass permissions on').status, 'working',
  'a folded footer with no count is not an explicit zero; structured work remains authoritative');
setHookState(session.id, r.status, r.question);
assert.equal(decide(pane()).status, 'working');
// Also repair the legacy Stop override rather than flickering to waiting for nine seconds.
setHookState(session.id, 'waiting', 'Old completion assumption');
assert.equal(decide(pane()).status, 'working', 'native live count outranks legacy completion');
clearHookState(session.id);
r = hook('Notification', { notification_type: 'idle_prompt', message: 'Waiting for your input' });
assert.equal(r.status, 'working', 'idle notification preserves active task snapshot');
assert.equal(hook('Notification', { notification_type: 'auth_success' }).status, null);
assert.equal(hook('Notification', { notification_type: 'future-informational-type' }).status, null);
assert.equal(hook('SubagentStop', { last_assistant_message: 'Helper done', background_tasks: tasks }).status, null);
assert.equal(hook('TaskCompleted').status, null, 'checklist completion does not complete the parent turn');

r = hook('PermissionRequest', { message: 'Allow the tool?' });
setHookState(session.id, r.status, r.question, { attention: r.attention });
assert.equal(decide(pane()).status, 'waiting', 'real operator attention wins over live background work');
clearHookState(session.id);
assert.equal(decide('Allow this command?\n❯ 1. Yes\n  2. No\nEnter to confirm').status, 'waiting');
assert.equal(hook('Notification', { notification_type: 'elicitation_url_dialog' }).status, 'waiting');
assert.equal(hook('Notification', { notification_type: 'agent_needs_input' }).status, 'waiting');
assert.equal(hook('Notification', { notification_type: 'quota_auto_resume_fired' }).status, 'working');
assert.equal(hook('Notification', { notification_type: 'quota_auto_resume_stale' }).status, 'waiting');
assert.equal(hook('StopFailure', { error: 'authentication_failed', last_assistant_message: 'API Error: 401' }).authNeeded, true);
assert.equal(hook('StopFailure', { error: 'overloaded' }).degraded, true);
assert.equal(classify({ session: { ...session, status: 'waiting' }, snap: pane(4), idleMs: 20 * 3600_000 }).status, 'waiting',
  'persisted API failure cannot be hidden by shells remaining in the background');
assert.equal(hook('StopFailure', { error: 'billing_error' }).degraded, false);

r = hook('Stop', { background_tasks: [], session_crons: [], last_assistant_message: 'Acceptance finished.' });
assert.equal(r.status, 'waiting');
assert.equal(r.question, 'Acceptance finished.');
assert.equal(claudeBackgroundWork(r.state).work, 0, 'empty snapshot retires old tasks');
r = hook('Stop', { background_tasks: [{ id: 'web', type: 'shell', status: 'running', command: 'npm run dev' }], session_crons: [] });
assert.equal(r.status, 'waiting', 'a deliberately left-running dev server does not suppress the report');
assert.equal(decide(pane(1)).status, 'waiting', 'service-only snapshot reconciles the native shell count');
r = hook('Stop', { background_tasks: tasks, session_crons: [{ id: 'loop', recurring: true }] });
assert.equal(r.status, 'working');
r = hook('Stop', { background_tasks: [], session_crons: [{ id: 'loop', recurring: true }] });
assert.equal(r.status, 'waiting', 'recurring scheduling alone does not hide a completed report');
r = hook('Stop', { background_tasks: [], session_crons: [{ id: 'wake', recurring: false }] });
assert.equal(r.status, 'working', 'one-shot wakeup is pending work, not an operator request');
assert.equal(decide(pane(0)).status, 'working');
hook('SessionEnd');
assert.equal(decide(pane(0)).status, 'waiting', 'session lifecycle cleanup removes the wakeup hold');
hook('Stop', { sent_at: 200, native_session_id: 'old', background_tasks: tasks });
assert.equal(hook('Stop', { sent_at: 100, background_tasks: [] }).ignored, true, 'late HTTP delivery cannot reverse newer lifecycle state');
assert.equal(hook('SessionStart', { sent_at: 300, native_session_id: 'new' }).state.background_tasks, undefined, 'native identity change resets task snapshots');
assert.equal(normalizeClaudeHook({ background_tasks: Array.from({ length: 100 }, () => ({ command: 'x'.repeat(2000) })) }).background_tasks.length, 64);
clearClaudeLifecycle(session.id);

const plan = 'Claude has written up a plan and is ready to execute. Would you like to proceed?\n❯ 1. Yes, clear context and bypass permissions\n  2. Yes, and bypass permissions\n  3. Yes, manually approve edits\n  4. Tell Claude what to change\nEnter to select';
assert.deepEqual(decide(plan).confirm, ['down', 'enter'], 'full preserves context instead of blindly selecting option one');
assert.deepEqual(classify({ session: { ...session, autonomy: 'auto' }, snap: plan, idleMs: 60000 }).confirm, ['down', 'down', 'enter'], 'auto is not silently escalated to full');
assert.equal(decide(`${plan}\n${pane(0)}`).confirm, undefined, 'a quoted plan gate never types keys into the composer');
const ask = 'Which implementation?\n❯ 1. A\n  2. B\n  3. Type something\nEnter to select · Tab/Arrow keys to navigate';
assert.equal(askMenuTypeDigit(ask), '3');
assert.equal(askMenuTypeDigit(ask.replace('Type something', 'Type your own answer')), '3');
assert.equal(askMenuTypeDigit(`${ask}\n${pane(0)}`), null, 'historical AskUserQuestion menu cannot intercept a new send');
assert.equal(agentInputReady('❯\n❯ a real pending draft\nbypass permissions on'), false);
assert.equal(claudeResumePrompt('Resuming the full session will consume a substantial portion of your usage limits\n1. Resume from summary\n2. Resume full session as-is\nEnter to confirm\n❯\nbypass permissions on'), false);
// Codex keeps the bounded server hold and original hook precedence.
setHookState('s_codex_unchanged', 'working');
assert.equal(classify({ session: { id: 's_codex_unchanged', tool: 'codex' }, snap: 'Do you want to proceed?', idleMs: 60000 }).status, 'working');
clearHookState('s_codex_unchanged');
console.log('claude_lifecycle: background work, notifications, errors, scheduling, gates, input and Codex isolation passed');
