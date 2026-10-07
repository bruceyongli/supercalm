import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bus } from '../src/bus.js';

const root = mkdtempSync(join(tmpdir(), 'aios-story-isolation-'));
const rolloutDir = join(root, 'rollouts', '2026', '07');
mkdirSync(rolloutDir, { recursive: true });
process.env.AIOS_DATA = join(root, 'data');
process.env.AIOS_CODEX_SESSIONS_DIR = join(root, 'rollouts');
process.env.AIOS_NO_LISTEN = '1';
process.env.AIOS_TMUX = '/usr/bin/true';

const projectPath = join(root, 'project');
mkdirSync(projectPath, { recursive: true });
const OLD_UUID = '11111111-1111-4111-8111-111111111111';
const OWN_UUID = '22222222-2222-4222-8222-222222222222';
const oldFile = join(rolloutDir, `rollout-2026-07-22T01-00-00-${OLD_UUID}.jsonl`);
const ownFile = join(rolloutDir, `rollout-2026-07-22T01-00-01-${OWN_UUID}.jsonl`);
writeFileSync(oldFile, JSON.stringify({ type: 'session_meta', payload: { id: OLD_UUID }, id: OLD_UUID, cwd: projectPath }) + '\n');

const store = await import('../src/store.js');
const { storyFor } = await import('../src/story_api.js');
store.createProject({ id: 'p_story', name: 'Story isolation', path: projectPath });

// A legacy row can still use the historical cwd heuristic.
store.createSession({ id: 's_legacy_story', project_id: 'p_story', tool: 'codex', tmux: 'legacy', status: 'exited' });
const legacy = await storyFor('s_legacy_story');
assert.equal(legacy.meta.file, oldFile, 'pre-queue legacy sessions retain cwd transcript lookup');

// A fresh launch in the same project must never display that older session while UUID capture is pending.
store.createSession({ id: 's_fresh_story', project_id: 'p_story', tool: 'codex', tmux: 'fresh', status: 'starting' });
store.addEvent('s_fresh_story', 'launch-queued', { task: 'fresh private task' });
store.addMessage('s_fresh_story', 'in', 'task', 'fresh private task');
const pending = await storyFor('s_fresh_story');
assert.equal(pending.meta.source, 'fallback');
assert.equal(pending.meta.file, null, 'fresh unresolved Codex story refuses same-project cwd fallback');
assert.ok(pending.events.some((e) => String(e.body || e.text || '').includes('fresh private task')), 'fallback contains only this session’s own captured spine');

// Once the authoritative UUID arrives, only that exact rollout becomes visible.
writeFileSync(ownFile, JSON.stringify({ type: 'session_meta', payload: { id: OWN_UUID }, id: OWN_UUID, cwd: projectPath }) + '\n');
store.updateSession('s_fresh_story', { codex_uuid: OWN_UUID, status: 'working' });
const bound = await storyFor('s_fresh_story');
assert.equal(bound.meta.source, 'transcript');
assert.equal(bound.meta.file, ownFile, 'captured UUID selects the fresh session’s own rollout');
assert.notEqual(bound.meta.file, oldFile);

// Real operator regression: queued launch, native Codex 0.160 record first appears after ~8s,
// capture window misses it, the CLI finishes a report but Story keeps showing only input bubbles.
const LATE_UUID = '33333333-3333-4333-8333-333333333333';
const lateTask = '修复五上单字和词组的释义';
const lateReport = '已修复并发布 v0.36.331。220 个单字、170 个词组已补齐。\n\n[全量核对表](/own/artifacts/字词提示全量核对.csv)';
const lateCwd = join(root, 'worktrees', 's_delayed_story');
store.createSession({ id: 's_delayed_story', project_id: 'p_story', tool: 'codex', tmux: 'delayed', status: 'waiting' });
store.updateSession('s_delayed_story', { worktree_path: lateCwd });
store.addEvent('s_delayed_story', 'launch-queued', { task: lateTask });
store.addMessage('s_delayed_story', 'in', 'task', lateTask);
store.addMessage('s_delayed_story', 'out', 'detect', 'Clipped terminal footer, NOT the actual report.');
store.addEvent('s_delayed_story', 'launch', { dir: lateCwd, task: lateTask });
const launchTs = store.db.prepare("SELECT ts FROM events WHERE session_id=? AND type='launch'").get('s_delayed_story').ts;
// Align filename dates with the private fixture's real launch time (the CLI uses local-time names).
const datedLateFile = join(rolloutDir, `rollout-${new Date(launchTs - 86400_000).toISOString().slice(0, 10)}T23-00-08-${LATE_UUID}.jsonl`);
let ready = [];
bus.on('session-status', e => { if (e.session === 's_delayed_story') ready.push(e); });
const beforeRecoveryActivity = store.getSession('s_delayed_story').last_activity;
const missing = await storyFor('s_delayed_story');
assert.equal(missing.meta.source, 'fallback');
writeFileSync(datedLateFile, [
  { type: 'session_meta', timestamp: new Date(launchTs + 8000).toISOString(), payload: { id: LATE_UUID,
    timestamp: new Date(launchTs + 8000).toISOString(), cwd: lateCwd, source: 'cli', originator: 'codex-tui', thread_source: 'user' } },
  { type: 'response_item', timestamp: new Date(launchTs + 9000).toISOString(), payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '<project_context>Launch preamble</project_context>\n\n' + lateTask }] } },
  { type: 'response_item', timestamp: new Date(launchTs + 20000).toISOString(), payload: { type: 'message', role: 'assistant',
    phase: 'final_answer', content: [{ type: 'output_text', text: lateReport }] } },
  { type: 'event_msg', timestamp: new Date(launchTs + 20001).toISOString(), payload: { type: 'task_complete', last_agent_message: lateReport } },
].map(row => JSON.stringify(row)).join('\n') + '\n');
// Exercise Story itself (not a manual DB/binder repair), including its previously cached inventory.
await new Promise(resolve => setTimeout(resolve, 1100));
const [recovered, concurrent] = await Promise.all([storyFor('s_delayed_story'), storyFor('s_delayed_story')]);
assert.equal(concurrent.meta.file, datedLateFile);
assert.equal(recovered.meta.source, 'transcript');
assert.equal(recovered.meta.file, datedLateFile);
assert.equal(recovered.events.filter(e => e.kind === 'report').length, 1, 'final_answer and completion mirrors produce one report');
assert.equal(recovered.events.find(e => e.kind === 'report').body, lateReport, 'complete markdown and artifact link survive recovery');
assert.equal(store.getSession('s_delayed_story').codex_uuid, LATE_UUID, 'identity is durable across restarts/next reads');
assert.equal(ready.length, 1, 'concurrent recovery publishes one transcript-ready event');
assert.equal(ready[0].source, 'transcript');
assert.equal(store.getSession('s_delayed_story').status, 'waiting', 'recovery does not restart or send anything to the coding agent');
assert.equal(store.getSession('s_delayed_story').last_activity, beforeRecoveryActivity, 'reading a recovered report does not refresh the session age');
assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE session_id=? AND type='codex-uuid'").get('s_delayed_story').n, 1);

console.log('story_session_isolation.test ok');
process.exit(0);
