// Resume must FAIL CLOSED when a session's recorded isolation worktree cannot be restored.
//
// The old behavior fell through to the shared project checkout: startPane derives
// `isolated = cwd !== project.path`, so a shared-tree cwd omits AIOS_NO_DEPLOY=1 and the relaunched
// agent runs in the live deployment checkout while the DB row still claims a worktree. Automatic
// exit-recovery (the supervisor calls resume with force:true) makes that reachable with no human in
// the loop, which is why this is proven at EXECUTION level, not just as a predicate: the real
// resume() runs against a mock tmux binary that records every invocation, so "startPane was never
// reached" is observable as the absence of a `new-session` call, and the positive controls prove the
// guard is narrow (shared-tree and restorable-worktree resumes still launch).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'aios-resume-isolation-'));
const data = join(root, 'data');
const repoPath = join(root, 'repo'); // a real git checkout (restorable worktrees)
const plainPath = join(root, 'plain'); // NOT a git repo -> ensureWorktree always fails
const wtRoot = join(root, 'worktrees');
mkdirSync(repoPath, { recursive: true });
mkdirSync(plainPath, { recursive: true });
mkdirSync(wtRoot, { recursive: true });

const git = (...args) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-b', 'main', '-q');
git('config', 'user.email', 'test@example.invalid');
git('config', 'user.name', 'Isolation Test');
writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
git('add', '-A');
git('commit', '-qm', 'fixture');

// A tmux stand-in that records every call. `new-session` is the canonical pane-creation seam inside
// startPane, so its presence/absence in this log IS the reachability proof.
const mock = join(root, 'tmux-mock.mjs');
const stateFile = join(root, 'tmux-state.json');
const logFile = join(root, 'tmux-log');
writeFileSync(stateFile, '[]');
writeFileSync(logFile, '');
writeFileSync(mock, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const read = () => { try { return JSON.parse(readFileSync(process.env.MOCK_TMUX_STATE, 'utf8')); } catch { return []; } };
const write = (v) => writeFileSync(process.env.MOCK_TMUX_STATE, JSON.stringify([...new Set(v)]));
const val = (flag) => args[args.indexOf(flag) + 1];
appendFileSync(process.env.MOCK_TMUX_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'list-sessions') { process.stdout.write(read().join('\\n')); process.exit(0); }
if (args[0] === 'new-session') { const name = val('-s'); if (name) write([...read(), name]); process.exit(0); }
if (args[0] === 'kill-session') { write(read().filter((x) => x !== val('-t'))); process.exit(0); }
if (args[0] === 'has-session') process.exit(read().includes(val('-t')) ? 0 : 1);
if (args[0] === 'display-message') process.stdout.write('claude');
process.exit(0);
`);
chmodSync(mock, 0o755);

process.env.AIOS_DATA = data;
process.env.AIOS_NO_LISTEN = '1';
process.env.AIOS_TMUX = mock;
process.env.AIOS_WORKTREE_ROOT = wtRoot;
process.env.AIOS_SUBMIT_DELAY = '0';
process.env.AIOS_CLAUDE_BASE_URL = ''; // force the CLI's own login: no proxy probe, hermetic launch env
process.env.MOCK_TMUX_STATE = stateFile;
process.env.MOCK_TMUX_LOG = logFile;

const store = await import('../src/store.js');
const { isolationResumeBlocked } = await import('../src/resume_policy.js');
const { worktreePathFor } = await import('../src/worktrees.js');
const { resume } = await import('../src/sessions.js');

const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const newSessions = () => calls().filter((a) => a[0] === 'new-session');
const launchLine = (sid) => readFileSync(join(data, 'launch', sid + '.sh'), 'utf8');

const gitProject = store.createProject({ id: 'p_iso_git', name: 'Isolated repo', path: repoPath });
const plainProject = store.createProject({ id: 'p_iso_plain', name: 'Plain dir', path: plainPath });

// createSession() inserts the launch-time columns only; production records the worktree afterwards
// (updateSession), so the fixture takes the same two-step path rather than faking the row shape.
function mkSession({ id, project, worktree_path = null, branch = null }) {
  store.createSession({ id, project_id: project.id, tool: 'claude', tmux: 'aios-' + id, status: 'exited' });
  return store.updateSession(id, { ...(worktree_path ? { worktree_path, branch } : {}), exit_code: 1, ended_at: Date.now() - 60_000 });
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  ok - ' + name);
}

// ---------------------------------------------------------------------------------------------
// 1. The pure predicate. `force` is deliberately NOT an input: it exists to override a launch-manifest
//    mismatch, and must never be readable as permission to escape isolation.
// ---------------------------------------------------------------------------------------------
await check('predicate: an unrestorable recorded worktree blocks resume', () => {
  assert.equal(isolationResumeBlocked({ worktreePath: '/w/s_1', restoredCwd: undefined }), true);
  assert.equal(isolationResumeBlocked({ worktreePath: '/w/s_1', restoredCwd: '' }), true, 'an empty cwd is not a restoration');
  assert.equal(isolationResumeBlocked({ worktreePath: '/w/s_1', restoredCwd: '/w/s_1' }), false, 'restored -> resume proceeds');
  assert.equal(isolationResumeBlocked({ worktreePath: '', restoredCwd: undefined }), false, 'a shared-tree session was never isolated');
  assert.equal(isolationResumeBlocked({}), false, 'no worktree recorded -> nothing to lose');
  assert.equal(isolationResumeBlocked(), false, 'defensive: no argument is not a block');
  // The predicate has no force input; passing one cannot change the verdict.
  assert.equal(isolationResumeBlocked({ worktreePath: '/w/s_1', restoredCwd: undefined, force: true }), true, 'force is not an isolation override');
});

// ---------------------------------------------------------------------------------------------
// 2. EXECUTION: restoration fails (project is not a git checkout) -> resume refuses before startPane.
// ---------------------------------------------------------------------------------------------
const lost = mkSession({
  id: 's_iso_lost', project: plainProject,
  worktree_path: join(wtRoot, 'plain-dir', 's_iso_lost'), branch: 'supercalm/plain-dir/s_iso_lost',
});
assert.equal(lost.worktree_path, join(wtRoot, 'plain-dir', 's_iso_lost'), 'fixture really records an isolated worktree');

await check('execution: a lost worktree refuses resume and never reaches startPane', async () => {
  const before = newSessions().length;
  await assert.rejects(
    () => resume(lost.id),
    (e) => {
      assert.equal(e.code, 'isolation-lost', 'the refusal is typed so callers can distinguish it');
      assert.equal(e.isolationLost, true);
      assert.match(e.message, /shared checkout/i, 'the error names the actual danger');
      assert.match(e.message, /s_iso_lost/, 'the error names the worktree that could not be restored');
      return true;
    },
  );
  assert.equal(newSessions().length, before, 'NO pane was created: startPane is unreachable');
  const row = store.getSession(lost.id);
  assert.equal(row.status, 'exited', 'the session is not falsely advanced to working');
  assert.equal(row.tmux, lost.tmux, 'no replacement pane identity was persisted');
  const events = store.eventsFor(lost.id, 50).map((e) => e.type);
  assert.ok(events.includes('resume-refused'), 'the refusal is recorded as a durable event');
  assert.ok(!events.includes('resume'), 'no resume event claims a relaunch that did not happen');
});

await check('execution: force does NOT override isolation (the automatic-recovery path)', async () => {
  const before = newSessions().length;
  await assert.rejects(() => resume(lost.id, { force: true }), (e) => e.code === 'isolation-lost');
  assert.equal(newSessions().length, before, 'force:true still creates no pane in the shared checkout');
  assert.equal(store.getSession(lost.id).status, 'exited');
});

// ---------------------------------------------------------------------------------------------
// 3. CONTROL: a session that was never isolated still resumes normally (the guard is narrow), and its
//    launch line legitimately carries NO deploy interlock — which is exactly what the old fail-open
//    path silently produced for an ISOLATED session.
// ---------------------------------------------------------------------------------------------
const shared = mkSession({ id: 's_iso_shared', project: gitProject });

await check('control: a shared-tree session resumes (guard does not break normal resume)', async () => {
  const before = newSessions().length;
  const updated = await resume(shared.id);
  assert.equal(updated.status, 'working');
  const created = newSessions().slice(before);
  assert.equal(created.length, 1, 'exactly one pane was created');
  assert.equal(created[0][created[0].indexOf('-c') + 1], repoPath, 'a non-isolated session launches in the project path');
  assert.ok(!/AIOS_NO_DEPLOY=1/.test(launchLine(shared.id)), 'a shared-tree launch carries no interlock — the state the fail-open path used to fake');
});

// ---------------------------------------------------------------------------------------------
// 4. CONTROL: an isolated session whose worktree IS restorable resumes into the WORKTREE, with the
//    deploy interlock present. This is the invariant the guard protects.
// ---------------------------------------------------------------------------------------------
const keptPath = worktreePathFor(gitProject, 's_iso_kept');
const kept = mkSession({ id: 's_iso_kept', project: gitProject, worktree_path: keptPath, branch: 'supercalm/Isolated-repo/s_iso_kept' });

await check('control: a restorable worktree resumes INTO the worktree with the deploy interlock', async () => {
  const before = newSessions().length;
  const updated = await resume(kept.id);
  assert.equal(updated.status, 'working');
  const created = newSessions().slice(before);
  assert.equal(created.length, 1);
  assert.equal(created[0][created[0].indexOf('-c') + 1], keptPath, 'the pane opens in the isolated worktree, not the shared checkout');
  assert.match(launchLine(kept.id), /AIOS_NO_DEPLOY=1/, 'isolation restored => the deploy interlock is present');
});

// ---------------------------------------------------------------------------------------------
// 5. ORDERING: the isolation refusal must precede the launch-contract check, or a manifest mismatch
//    (which `force` legitimately overrides) could mask it and let a forced resume through.
// ---------------------------------------------------------------------------------------------
await check('source: the isolation guard precedes verifyResume and startPane inside resume()', () => {
  const src = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
  // Current main wraps the relaunch in a per-session in-flight dedupe. The safety ordering lives in
  // resumeNow(); the exported resume() owns only concurrency/generation bookkeeping.
  const body = src.slice(src.indexOf('async function resumeNow(sid'));
  const guard = body.indexOf('isolationResumeBlocked');
  const verify = body.indexOf('verifyResume(');
  const pane = body.indexOf('await startPane(');
  assert.ok(guard > 0 && verify > guard, 'isolation is decided before the launch-contract check');
  assert.ok(pane > guard, 'isolation is decided before any pane is created');
});

// ---------------------------------------------------------------------------------------------
// 6. The supervisor's automatic exit-recovery must report a refused resume HONESTLY: no send, no
//    "recovered" claim. This drives the real recovery path with a resumeSession that throws exactly
//    what the guard above throws.
// ---------------------------------------------------------------------------------------------
const { __lab } = await import('../src/agents/supervisor.js');

await check('supervisor: a refused resume is reported as blocked — no send, no false success', async () => {
  const sends = [];
  const notes = [];
  const emits = [];
  let st = {};
  const sid = 's_iso_recover';
  store.createSession({ id: sid, project_id: gitProject.id, tool: 'claude', tmux: 'aios-iso-recover', status: 'exited' });
  const ctx = {
    sessionId: sid,
    session: () => ({ id: sid, title: 'Isolated work', tool: 'claude', status: 'exited', autonomy: 'full', exit_code: 1, ended_at: Date.now() - 60_000, last_activity: Date.now() - 60_000 }),
    project: () => gitProject,
    getState: () => ({ ...st }),
    setState: (patch) => { st = { ...st, ...patch }; return { ...st }; },
    getConfig: () => CFG,
    setConfig: () => {},
    getEvidence: async () => ({ images: [], terminal_tail: 'process exited', git: { stat: '', diff: '', commits_since_baseline: '' }, recent_messages: [] }),
    visionRoute: () => false,
    callModel: async () => { throw new Error('recovery must not need a model'); },
    sendToAgent: async (msg) => { sends.push(msg); return { sent: true, message: msg }; },
    runProbes: async () => [],
    hasCap: () => true,
    notifyOperator: (title, body) => notes.push(`${title}: ${body}`),
    emit: (kind, payload) => emits.push({ kind, payload }),
    log: () => {},
    resumeSession: async () => {
      const e = new Error('resume refused — the isolated worktree could not be restored (/w/s_iso_recover); refusing to relaunch in the shared checkout');
      e.code = 'isolation-lost';
      e.isolationLost = true;
      throw e;
    },
  };
  const CFG = { model: 'glm-5.2', mode: 'autopilot', doc: '# Task\n\n## Goal\nFinish the isolated work.\n' };

  const handled = await __lab.maybeRecoverUnexpectedExit(ctx, CFG, Date.now());
  assert.equal(handled, true, 'the supervisor handled the exit (it did not fall through to other rules)');
  assert.equal(sends.length, 0, 'a refused resume sends NOTHING to an agent');
  assert.ok(emits.some((e) => e.kind === 'review' && e.payload.verdict === 'blocked'), 'the review verdict is blocked');
  assert.ok(!emits.some((e) => e.payload?.verdict === 'resumed'), 'nothing claims the session was resumed');
  const text = notes.join('\n');
  assert.ok(notes.length >= 1, 'the operator is told');
  assert.ok(!/Recovered exited session/.test(text), 'no false recovery-success notification');
  // "resume failed" is emitted only by the resumeSession catch — distinct from the earlier
  // "resume needed" suppression branch — so this also proves the guard's throw was the path taken.
  assert.match(text, /resume failed/i, 'the operator notification names the failure honestly');
  assert.match(text, /isolated worktree/i, 'the guard\'s actual reason reaches the operator, not a generic error');
  // The audit row must carry the real reason, marked not-sent — an operator reading the history sees
  // a blocked recovery, never a silent one.
  const row = store.db.prepare('SELECT * FROM supervisor_reviews WHERE session_id = ? ORDER BY ts DESC LIMIT 1').get(sid);
  assert.ok(row, 'the blocked recovery is persisted for audit');
  assert.equal(row.sent, 0, 'the persisted record is marked not-sent');
  assert.ok(!row.sent_text, 'no text was sent to the agent');
  assert.match(String(row.assessment || ''), /isolated worktree|resume failed/i, 'the audit row carries the real reason');
});

console.log(`resume_isolation_guard.test ok (${passed} checks)`);
process.exit(0);
