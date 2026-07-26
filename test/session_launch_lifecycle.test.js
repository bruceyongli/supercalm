import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'aios-launch-lifecycle-'));
const data = join(root, 'data');
const projectPath = join(root, 'project');
const rolloutPath = join(root, 'rollouts');
mkdirSync(projectPath, { recursive: true });
mkdirSync(rolloutPath, { recursive: true });
const mock = join(root, 'tmux-mock.mjs');
const stateFile = join(root, 'tmux-state.json');
const modeFile = join(root, 'tmux-mode');
const logFile = join(root, 'tmux-log');
const raceFile = join(root, 'tmux-race-started');
const raceDoneFile = join(root, 'tmux-race-done');
writeFileSync(stateFile, '[]');
writeFileSync(modeFile, 'ok');
writeFileSync(logFile, '');
writeFileSync(mock, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stateFile = process.env.MOCK_TMUX_STATE;
const modeFile = process.env.MOCK_TMUX_MODE;
const logFile = process.env.MOCK_TMUX_LOG;
const raceFile = process.env.MOCK_TMUX_RACE;
const raceDoneFile = process.env.MOCK_TMUX_RACE_DONE;
const read = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return []; } };
const write = (v) => writeFileSync(stateFile, JSON.stringify([...new Set(v)]));
const val = (flag) => args[args.indexOf(flag) + 1];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
appendFileSync(logFile, JSON.stringify(args) + '\\n');
if (args[0] === 'list-sessions') { process.stdout.write(read().join('\\n')); process.exit(0); }
if (args[0] === 'new-session') {
  const name = val('-s');
  if (readFileSync(modeFile, 'utf8').trim() === 'relaunch-race' && existsSync(raceFile)) await delay(500);
  if (name) write([...read(), name]);
  process.exit(0);
}
if (args[0] === 'kill-session') { const name = val('-t'); write(read().filter((x) => x !== name)); process.exit(0); }
if (args[0] === 'has-session') {
  const name = val('-t');
  const mode = readFileSync(modeFile, 'utf8').trim();
  // Arm exactly one poll before resume starts. It observes the intentional no-pane gap, but withholds
  // that false result until the replacement is live — the production race that used to emit exit after resume.
  if (mode === 'relaunch-race' && !existsSync(raceFile)) {
    writeFileSync(raceFile, 'started');
    while (read().includes(name)) await delay(10);
    while (!read().some((candidate) => candidate.startsWith('aios-') && candidate !== name)) await delay(10);
    await delay(500);
    writeFileSync(raceDoneFile, 'done');
    process.exit(1);
  }
  process.exit(read().includes(name) ? 0 : 1);
}
if (args[0] === 'pipe-pane') {
  const mode = readFileSync(modeFile, 'utf8').trim();
  if (mode === 'slow-pipe') await new Promise((r) => setTimeout(r, 350));
  if (mode === 'fail-pipe') process.exit(7);
}
if (args[0] === 'display-message') process.stdout.write('codex');
process.exit(0);
`);
chmodSync(mock, 0o755);

process.env.AIOS_DATA = data;
process.env.AIOS_NO_LISTEN = '1';
process.env.AIOS_TMUX = mock;
process.env.AIOS_SUBMIT_DELAY = '0';
process.env.AIOS_CODEX_SESSIONS_DIR = rolloutPath;
process.env.MOCK_TMUX_STATE = stateFile;
process.env.MOCK_TMUX_MODE = modeFile;
process.env.MOCK_TMUX_LOG = logFile;
process.env.MOCK_TMUX_RACE = raceFile;
process.env.MOCK_TMUX_RACE_DONE = raceDoneFile;

const store = await import('../src/store.js');
const { queueLaunch, killSession, discover, resume } = await import('../src/sessions.js');
const project = store.createProject({ id: 'p_launch', name: 'Launch lifecycle', path: projectPath });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 2500) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await delay(20);
  }
  throw new Error('timeout waiting for ' + label);
}
const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const names = () => JSON.parse(readFileSync(stateFile, 'utf8'));
await waitFor(() => calls().some((args) => args[0] === 'list-sessions'), 'initial discovery');
// The mock records list-sessions before execFile's callback resumes discover(). Let that one boot
// reconciliation fully return before creating an in-process queued launch (otherwise the test itself
// looks exactly like a service restart between durable reservation and background completion).
await delay(250);

// A failure after new-session must leave neither a live pane nor a pending placeholder in durable state.
writeFileSync(modeFile, 'fail-pipe');
const failedStart = queueLaunch({ project, tool: 'codex', task: 'fail after tmux creation' });
assert.ok(!failedStart.tmux.startsWith('pending-'), 'real tmux identity is persisted synchronously');
const failed = await waitFor(() => store.getSession(failedStart.id)?.status === 'error' && store.getSession(failedStart.id), 'failed launch cleanup');
assert.match(failed.summary, /Launch failed/);
assert.ok(!names().includes(failed.tmux), 'post-create failure kills the real pane');
assert.ok(calls().some((args) => args[0] === 'kill-session' && args.includes(failed.tmux)), 'cleanup targeted the persisted name');

// Kill while pipe setup is still in flight. The route helper cancels the ticket and targets the same
// durable name; completion observes cancellation and cannot resurrect Working.
writeFileSync(modeFile, 'slow-pipe');
const pending = queueLaunch({ project, tool: 'codex', task: 'kill during launch' });
await waitFor(() => names().includes(pending.tmux), 'partially-created pane');
await killSession(pending.id);
await delay(500);
assert.equal(store.getSession(pending.id).status, 'exited');
assert.ok(!names().includes(pending.tmux), 'kill-during-launch leaves no pane behind');

// A service restart has no background launch continuation. If the durable Starting pane exists,
// discovery retires it and records an actionable error instead of registering it forever.
writeFileSync(modeFile, 'ok');
store.createSession({ id: 's_restart_launch', project_id: project.id, tool: 'codex', tmux: 'aios-restart-partial', status: 'starting' });
writeFileSync(stateFile, JSON.stringify([...names(), 'aios-restart-partial']));
await discover();
assert.equal(store.getSession('s_restart_launch').status, 'error');
assert.ok(!names().includes('aios-restart-partial'), 'restart recovery kills a partially-created pane');

// A settings/model relaunch intentionally kills and recreates the pane. Reproduce a poll that sees that
// gap but returns only after resume has published the replacement: its stale result must not retire it.
writeFileSync(modeFile, 'ok');
const switching = queueLaunch({ project, tool: 'codex', task: 'survive a model relaunch race' });
await waitFor(() => store.getSession(switching.id)?.status === 'working', 'switching session launch');
rmSync(raceFile, { force: true });
rmSync(raceDoneFile, { force: true });
writeFileSync(modeFile, 'relaunch-race');
await waitFor(() => existsSync(raceFile), 'poll race arm', 3500);
await resume(switching.id, { force: true });
await waitFor(() => existsSync(raceDoneFile), 'stale poll completion', 2500);
await delay(100);
assert.equal(store.getSession(switching.id).status, 'working', 'stale pre-relaunch poll cannot mark replacement exited');
assert.ok(names().includes(store.getSession(switching.id).tmux), 'replacement pane remains alive');
const latestLifecycle = store.eventsFor(switching.id, 10).filter((event) => event.type === 'resume' || event.type === 'exit');
assert.equal(latestLifecycle[0]?.type, 'resume', 'no exit event may follow the successful resume');

console.log('session_launch_lifecycle.test ok');
process.exit(0);
