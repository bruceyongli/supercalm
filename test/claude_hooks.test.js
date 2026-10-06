import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// Run the real hook script through the real HTTP handler against a private database. No live panes,
// real projects, provider calls, operator messages, or machine-wide Claude settings are modified.
const scratch = mkdtempSync(join(tmpdir(), 'aios-claude-hooks-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const summaryScreens = [];
let releaseSummary;
const summaryServer = createHttpServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw);
  const screen = payload.messages.at(-1).content.replace(/^SCREEN:\n/, '');
  summaryScreens.push(screen);
  const respond = () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ category: 'review',
      summary: 'Formatted completion.', ask: screen, stage: 'review' }) } }] }));
  };
  if (screen.includes('Formatting race fixture')) releaseSummary = respond;
  else respond();
});
await new Promise(resolve => summaryServer.listen(0, '127.0.0.1', resolve));
process.env.AIOS_DATA = join(scratch, 'data');
process.env.AIOS_TMUX = '/usr/bin/false';
process.env.AIOS_HOST = '127.0.0.1';
process.env.AIOS_PORT = String(port);
process.env.AIOS_CLAUDE_HOOKS = '1';
process.env.AIOS_GIT_GUARDRAILS = '0';
process.env.AIOS_SUMMARY_PORT = String(summaryServer.address().port);
delete process.env.AIOS_NO_LISTEN;
const base = `http://127.0.0.1:${port}`;
const script = fileURLToPath(new URL('../scripts/aios-claude-hook.sh', import.meta.url));
let store;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  summaryServer.close();
  try { store?.db.close(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', cleanup);
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
const id = 's_claude_hooks_fixture';
const native = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const transcript = join(homedir(), '.claude', 'projects', '-private-hook-fixture', `${native}.jsonl`);
const post = async (tool, body) => {
  const res = await fetch(`${base}/api/hook/${tool}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  return res.json();
};
async function hook(event, extra = {}) {
  const count = store.db.prepare("SELECT count(*) n FROM events WHERE session_id=? AND type='hook'").get(id).n;
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { env: { ...process.env, AIOS_URL: base, AIOS_SESSION_ID: id }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { assert.equal(code, 0); assert.equal(stdout, ''); assert.equal(stderr, ''); resolve(); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: native, transcript_path: transcript, ...extra }));
  });
  for (let i = 0; i < 100; i++) {
    const row = store.db.prepare("SELECT payload FROM events WHERE session_id=? AND type='hook' ORDER BY id DESC LIMIT 1").get(id);
    if (row && store.db.prepare("SELECT count(*) n FROM events WHERE session_id=? AND type='hook'").get(id).n > count) return JSON.parse(row.payload);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`actual hook script did not reach HTTP handler: ${event}`);
}

try {
  const { featureReady } = await import('../src/server.js');
  await featureReady;
  store = await import('../src/store.js');
  const managed = JSON.parse(readFileSync(join(process.env.AIOS_DATA, 'claude', 'aios-hooks.settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(managed.hooks), ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification',
    'PermissionRequest', 'Elicitation', 'ElicitationResult', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact']);
  assert.ok(Object.values(managed.hooks).every(groups => groups[0].hooks[0].command === script));
  assert.equal(managed.hooks.PreToolUse, undefined, 'lifecycle tracking does not add a fork to every tool call');
  store.createSession({ id, tool: 'claude', tmux: 'never-a-live-pane' });
  store.updateSession(id, { status: 'working' });
  const tasks = [{ id: 'acceptance', type: 'shell', status: 'running', description: 'Wait for acceptance', command: 'until test -f result.json; do sleep 15; done' }];
  const captured = await hook('Stop', { background_tasks: tasks, session_crons: [], last_assistant_message: 'The next acceptance run is still in progress.' });
  assert.deepEqual(captured.background_tasks, tasks);
  assert.equal(captured.native_session_id, native);
  assert.equal(captured.last_assistant_message, 'The next acceptance run is still in progress.');
  assert.equal(store.getSession(id).claude_transcript, transcript);
  assert.equal(store.getSession(id).status, 'working', 'foreground Stop with live finite work is not completion');
  assert.equal(store.db.prepare("SELECT count(*) n FROM messages WHERE session_id=? AND direction='out'").get(id).n, 0);
  await hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input.' });
  assert.equal(store.getSession(id).status, 'working', 'idle notification retains background snapshot');
  await hook('SubagentStop', { background_tasks: [], agent_id: 'helper-1', last_assistant_message: 'Helper done.' });
  assert.equal(store.getSession(id).status, 'working', 'helper completion never completes parent');
  await hook('Notification', { notification_type: 'permission_prompt', message: 'Allow this command?' });
  assert.equal(store.getSession(id).status, 'waiting');
  assert.equal(store.getSession(id).question, 'Allow this command?');
  const home = await (await fetch(`${base}/api/phone/home`)).json();
  const attention = home.sessions.find(s => s.id === id);
  assert.ok(attention?.unread > 0, 'genuine permission prompt creates durable cross-device attention');
  await hook('Notification', { notification_type: 'auth_success', message: 'Signed in.' });
  assert.equal(store.getSession(id).question, 'Allow this command?', 'informational notification cannot replace question');
  await hook('UserPromptSubmit', { prompt: 'An operator request, not an agent report.' });
  assert.equal(store.getSession(id).status, 'working');
  await hook('Stop', { background_tasks: [], session_crons: [], last_assistant_message: 'The requested acceptance completed.' });
  assert.equal(store.getSession(id).status, 'waiting');
  assert.equal(store.getSession(id).question, 'The requested acceptance completed.');
  const attentionStore = await import('../src/attention_store.js');
  const report = attentionStore.getLatestAttentionReport(id);
  attentionStore.dismissAttention(id, report.id);
  const clock = store.getSession(id).last_activity;
  await hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is still waiting.' });
  await hook('Notification', { notification_type: 'auth_success', message: 'Authenticated.' });
  await hook('Stop', { background_tasks: [], session_crons: [], last_assistant_message: 'The requested acceptance completed.' });
  assert.equal(store.getSession(id).last_activity, clock, 'passive/replayed completion does not reset the project age');
  assert.equal(attentionStore.getLatestAttentionReport(id).id, report.id);
  assert.equal(attentionStore.getAttentionDismissal(id).report_id, report.id, 'dismissal survives a repeated native source');
  await hook('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'permission-new', tool_input: { command: 'npm test' } });
  assert.equal(store.getSession(id).question, 'Allow Bash: npm test', 'tool permission gets its real actionable context');
  assert.equal(attentionStore.getAttentionDismissal(id), null, 'a genuine new permission prompt reopens attention while already waiting');
  const permissionReport = attentionStore.getLatestAttentionReport(id);
  attentionStore.dismissAttention(id, permissionReport.id);
  await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your approval.' });
  assert.equal(attentionStore.getAttentionDismissal(id).report_id, permissionReport.id,
    'the delayed desktop permission reminder cannot reopen a dismissed gate');
  await hook('Elicitation', { message: 'Authenticate the document source.', elicitation_id: 'source-login', mode: 'url', url: 'https://example.test/login' });
  assert.match(store.getSession(id).question, /Authenticate the document source.*https:\/\/example.test\/login/s);
  await hook('ElicitationResult', { elicitation_id: 'source-login', action: 'cancel' });
  assert.equal(store.getSession(id).status, 'working', 'cancelled native elicitation returns control to Claude, not an unanswered question');
  await hook('StopFailure', { error: 'overloaded', error_details: 'The provider is overloaded.' });
  assert.equal(store.getSession(id).degraded, 1);
  assert.match(store.getSession(id).question, /provider is overloaded/);
  const priorBinding = store.getSession(id).claude_transcript;
  const stale = await post('claude', { session: id, event: 'Stop', sent_at: 1,
    native_session_id: '11111111-2222-3333-4444-555555555555',
    transcript: transcript.replace(native, '11111111-2222-3333-4444-555555555555'), background_tasks: [] });
  assert.equal(stale.ignored, 'wrong-native-session');
  assert.equal(store.getSession(id).claude_transcript, priorBinding, 'late hook cannot rebind resumed session');
  const foreignFresh = await post('claude', { session: id, event: 'Stop', sent_at: Date.now() + 1,
    native_session_id: '11111111-2222-3333-4444-555555555555', last_assistant_message: 'A different session finished.' });
  assert.equal(foreignFresh.ignored, 'wrong-native-session', 'fresh send time does not authorize a different native UUID');
  const wrongTool = await post('codex', { session: id, event: 'prompt-submit' });
  assert.equal(wrongTool.ignored, 'wrong-tool');
  assert.equal(store.getSession(id).status, 'waiting');
  await hook('UserPromptSubmit', {});
  assert.equal(store.getSession(id).degraded, 0, 'a new request clears an old provider error marker');
  await hook('Stop', { background_tasks: [], session_crons: [], last_assistant_message: 'Formatting race fixture: the actual requested work is complete.' });
  const formattingReport = attentionStore.getLatestAttentionReport(id);
  attentionStore.dismissAttention(id, formattingReport.id);
  for (let i = 0; !releaseSummary && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseSummary, 'completion reached the actual summary HTTP request with grounded source');
  assert.ok(summaryScreens.some(screen => screen === 'Formatting race fixture: the actual requested work is complete.'));
  releaseSummary();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(attentionStore.getAttentionDismissal(id).report_id, formattingReport.id,
    'late LLM formatting does not undo an operator dismissal');
  assert.equal(attentionStore.attentionUnreadCount(id), 0);
  const missing = 's_claude_missing_history';
  store.createSession({ id: missing, tool: 'claude', tmux: 'never-a-live-pane-missing' });
  store.updateSession(missing, { status: 'exited', claude_transcript: '/missing/22222222-3333-4444-5555-666666666666.jsonl' });
  store.addMessage(missing, 'in', 'task', 'Keep the original project request.');
  store.addMessage(missing, 'in', 'text', 'And keep this follow-up.');
  const { resume } = await import('../src/sessions.js');
  await assert.rejects(() => resume(missing, { force: true }), error => error.code === 'claude-transcript-missing');
  assert.equal(store.getSession(missing).status, 'exited', 'missing history never launches or binds another conversation');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id=? AND direction='in'").get(missing).n, 2);
  const codex = 's_codex_hooks_fixture';
  store.createSession({ id: codex, tool: 'codex', tmux: 'never-a-live-pane-either' });
  await post('codex', { session: codex, event: 'agent-turn-complete', message: 'Original Codex completion.' });
  assert.equal(store.getSession(codex).status, 'waiting');
  assert.equal(store.getSession(codex).question, 'Original Codex completion.');
  await post('codex', { session: codex, event: 'prompt-submit' });
  assert.equal(store.getSession(codex).status, 'working');
  console.log(JSON.stringify({ handler: 'POST /api/hook/claude', source: 'scripts/aios-claude-hook.sh',
    nativeSession: native, backgroundTasksPreserved: captured.background_tasks.length,
    foregroundStop: 'working', idleWithBackground: 'working', helperStop: 'parent unchanged',
    permission: 'durable attention', finalReport: 'exact last_assistant_message', apiFailure: 'degraded',
    staleTranscriptRebind: 'rejected', repeatedStopAndIdle: 'no activity/attention',
    permissionContext: 'tool + command', dismissalDuringFormatting: 'retained', codexHooks: 'unchanged' }));
  cleanup();
  console.log('claude_hooks.test passed');
  process.exit(0);
} catch (e) {
  console.error(e.stack || e);
  cleanup();
  process.exit(1);
}
