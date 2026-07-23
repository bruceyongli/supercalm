import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

console.log('story_session_isolation.test ok');
process.exit(0);
