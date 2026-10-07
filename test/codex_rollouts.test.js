// codex rollout identity — locks the cwd-mismatch fix: a session's transcript is found by the UUID
// captured at launch, INDEPENDENT of the rollout's recorded cwd (the operator's failure: a codex
// session whose sandbox workspace cwd ≠ its AIOS project path showed no transcript). Unit-tests the
// pure logic + FS walk directly (codex_rollouts.js has no side-effect imports), then source-locks the
// wiring in sessions.js/story_api.js/store.js (importing those boots the poll loop / tmux keepalive).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rolloutUuidFromName, pickRolloutByUuid, codexRolloutFiles, findCodexLaunchRollout } from '../src/codex_rollouts.js';

const UUID_A = '019f4690-1056-7250-9141-b64f4274e776'; // "captured at launch" — the session's own rollout
const UUID_B = '01a2b3c4-d5e6-7f80-9a1b-c2d3e4f50617'; // a different codex conversation
const nameA = `rollout-2026-07-09T04-07-54-${UUID_A}.jsonl`;
const nameB = `rollout-2026-07-11T11-07-02-${UUID_B}.jsonl`;

// ---- rolloutUuidFromName: the UUID is the trailing filename component ----
assert.equal(rolloutUuidFromName(nameA), UUID_A);
assert.equal(rolloutUuidFromName(`/abs/path/.codex/sessions/2026/07/${nameB}`), UUID_B);
assert.equal(rolloutUuidFromName('rollout-2026-07-09T04-07-54.jsonl'), null, 'no uuid → null');
assert.equal(rolloutUuidFromName('not-a-rollout.jsonl'), null);
assert.equal(rolloutUuidFromName(''), null);
assert.equal(rolloutUuidFromName(null), null);

// ---- pickRolloutByUuid: UUID-match wins, cwd never consulted ----
const files = [`/x/${nameB}`, `/x/${nameA}`];
assert.equal(pickRolloutByUuid(files, UUID_A), `/x/${nameA}`, 'picks the captured UUID regardless of order/cwd');
assert.equal(pickRolloutByUuid(files, UUID_B), `/x/${nameB}`);
assert.equal(pickRolloutByUuid(files, 'ffffffff-ffff-ffff-ffff-ffffffffffff'), null, 'absent UUID → null (caller falls back to cwd)');
assert.equal(pickRolloutByUuid(files, null), null, 'no captured UUID → null');
assert.equal(pickRolloutByUuid([], UUID_A), null);
// a partial/substring uuid must NOT match — only the exact trailing component
assert.equal(pickRolloutByUuid([`/x/${nameA}`], UUID_A.slice(0, 8)), null, 'substring must not match');

// ---- codexRolloutFiles: walks a (nested) tree, finds rollouts, feeds the UUID pick ----
const base = mkdtempSync(join(tmpdir(), 'aios-codex-rollouts-'));
// UUID_A lives under a SANDBOX-workspace path (mismatched cwd); UUID_B under a normal project path.
const sandboxDir = join(base, 'sandbox-instances', 'ws');
const projDir = join(base, '2026', '07');
mkdirSync(sandboxDir, { recursive: true });
mkdirSync(projDir, { recursive: true });
// head shape mirrors a real rollout: a session_meta line with cwd + id. The cwd here is DELIBERATELY a
// sandbox path (≠ any AIOS project), the exact condition that broke cwd-matching.
writeFileSync(join(sandboxDir, nameA), `{"type":"session_meta","cwd":"/private/var/sandbox/ws","id":"${UUID_A}"}\n`);
writeFileSync(join(projDir, nameB), `{"type":"session_meta","cwd":"/Users/dev/proj","id":"${UUID_B}"}\n`);
// a decoy non-rollout file must be ignored
writeFileSync(join(projDir, 'notes.txt'), 'ignore me\n');

const found = await codexRolloutFiles(base);
assert.equal(found.length, 2, 'finds both rollouts across nested dirs, ignores non-rollouts');
assert.ok(found.some((f) => f.endsWith(nameA)) && found.some((f) => f.endsWith(nameB)));

// THE cwd-mismatch fix, end to end at the module level: a session whose captured UUID is UUID_A resolves
// to the sandbox-cwd rollout by UUID alone — cwd is never needed.
const chosen = pickRolloutByUuid(found, UUID_A);
assert.ok(chosen && chosen.endsWith(nameA), 'UUID capture locates the sandbox-cwd rollout that cwd-matching would miss');

// empty base dir → no files, no throw (fail-open walk)
assert.deepEqual(await codexRolloutFiles(join(base, 'does-not-exist')), []);

// Delayed CLI startup: identity is recoverable after the six-second launch observer expired.
const launchAt = Date.parse('2026-07-11T11:07:00Z');
const request = '补齐释义，自动发布，不要影响其他 agent。';
const recovery = join(base, nameB);
const writeRecovery = (file, uuid, { cwd = '/own/worktree', offset = 8000, task = request,
  source = 'cli', thread_source = 'user', originator = 'codex-tui' } = {}) => writeFileSync(file, [
  { type: 'session_meta', timestamp: new Date(launchAt + offset).toISOString(), payload: {
    id: uuid, cwd, timestamp: new Date(launchAt + offset).toISOString(), source, thread_source, originator,
    base_instructions: { text: 'Large instructions '.repeat(2000) },
  } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
    text: '<project_context>Operator data</project_context>\n\n' + task }] } },
].map(row => JSON.stringify(row)).join('\n') + '\n');
const evidence = { cwd: '/own/worktree', startedAt: launchAt, task: request };
writeRecovery(recovery, UUID_B);
assert.equal(await findCodexLaunchRollout([recovery], evidence), recovery, '8-second delayed start with large metadata recovers by exact launch evidence');
assert.equal(await findCodexLaunchRollout([recovery], { ...evidence, task: 'Another request' }), null);
assert.equal(await findCodexLaunchRollout([recovery], { ...evidence, cwd: '/sibling/worktree' }), null);
assert.equal(await findCodexLaunchRollout([recovery], { ...evidence, task: '' }), null);
assert.equal(await findCodexLaunchRollout([recovery], { ...evidence, task: '', allowEmptyTask: true }), recovery, 'a launch inventory diff can still bind a blank-task launch');
assert.equal(await findCodexLaunchRollout([recovery], { ...evidence, claimed: new Set([UUID_B]) }), null);
for (const extra of [{ offset: -6000 }, { offset: 601000 }, { source: { subagent: 'parent' } },
  { thread_source: 'subagent' }, { originator: 'codex_exec' }]) {
  writeRecovery(recovery, UUID_B, extra);
  assert.equal(await findCodexLaunchRollout([recovery], evidence), null, `reject unrelated rollout ${JSON.stringify(extra)}`);
}
writeRecovery(recovery, UUID_B);
const duplicate = join(base, `rollout-2026-07-11T11-07-03-${UUID_A}.jsonl`);
writeRecovery(duplicate, UUID_A);
assert.equal(await findCodexLaunchRollout([recovery, duplicate], evidence), null, 'ambiguous launch evidence never guesses');
assert.equal(await findCodexLaunchRollout([recovery, duplicate], { ...evidence, claimed: new Set([UUID_A]) }), recovery);
writeRecovery(duplicate, UUID_B);
assert.equal(await findCodexLaunchRollout([duplicate], evidence), null, 'metadata identity must agree with the filename UUID');

// ---- source locks: the wiring the pure module can't observe (importing these boots their loops) ----
const storyApi = readFileSync(new URL('../src/story_api.js', import.meta.url), 'utf8');
// findCodexLog must consult the captured UUID BEFORE the cwd match.
const iPick = storyApi.indexOf('pickRolloutByUuid(files, s.codex_uuid)');
const iCwd = storyApi.indexOf("cm[1] === cwd");
assert.ok(iPick > 0, 'story_api findCodexLog uses pickRolloutByUuid(files, s.codex_uuid)');
assert.ok(iCwd > 0 && iPick < iCwd, 'UUID match runs before the cwd match (UUID is authoritative)');

const sessions = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
assert.ok(/const codexBefore = tool === 'codex' \? new Set\(await codexRolloutFiles\(\)/.test(sessions), 'launch snapshots the rollout set for codex');
assert.ok(/if \(codexBefore\) captureCodexUuid\(sid, codexBefore\)/.test(sessions), 'launch fires evidence-checked captureCodexUuid (fire-and-forget)');
const binding = readFileSync(new URL('../src/codex_transcript_binding.js', import.meta.url), 'utf8');
assert.ok(sessions.includes('bindCodexLaunchTranscript(sid,'), 'launch uses the shared evidence-checked binder');
assert.ok(binding.includes('store.updateSession(sid, { codex_uuid: uuid })'), 'shared binder persists the UUID');
assert.ok(binding.includes("source: 'transcript'"), 'UUID capture publishes a scoped transcript-ready event');
assert.ok(storyApi.includes('bindCodexLaunchTranscript(s.id,'), 'Story self-heals a missed binding using the same launch evidence');
assert.ok(sessions.includes('attempt < 60'), 'non-blocking launch capture allows a cold CLI to start');
assert.ok(/s\.codex_uuid \|\| \(await findCodexSession/.test(sessions), 'resume prefers the captured UUID, then cwd-match');

const store = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
const migrations = readFileSync(new URL('../src/schema_migrations.js', import.meta.url), 'utf8');
assert.ok(migrations.includes("['codex_uuid', 'TEXT']"), 'the central ledger migrates a codex_uuid column');
assert.ok(/SESSION_FIELDS = \[[^\]]*'codex_uuid'/.test(store), 'codex_uuid is a writable session field');
assert.ok(storyApi.includes('_freshQueuedLaunch.get(s.id)'), 'fresh unresolved launches refuse unsafe cwd fallback');

console.log('codex_rollouts: all assertions passed');
