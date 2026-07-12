// codex rollout identity — locks the cwd-mismatch fix: a session's transcript is found by the UUID
// captured at launch, INDEPENDENT of the rollout's recorded cwd (the operator's failure: a codex
// session whose sandbox workspace cwd ≠ its AIOS project path showed no transcript). Unit-tests the
// pure logic + FS walk directly (codex_rollouts.js has no side-effect imports), then source-locks the
// wiring in sessions.js/story_api.js/store.js (importing those boots the poll loop / tmux keepalive).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rolloutUuidFromName, pickRolloutByUuid, codexRolloutFiles } from '../src/codex_rollouts.js';

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

// ---- source locks: the wiring the pure module can't observe (importing these boots their loops) ----
const storyApi = readFileSync(new URL('../src/story_api.js', import.meta.url), 'utf8');
// findCodexLog must consult the captured UUID BEFORE the cwd match.
const iPick = storyApi.indexOf('pickRolloutByUuid(files, s.codex_uuid)');
const iCwd = storyApi.indexOf("cm[1] === cwd");
assert.ok(iPick > 0, 'story_api findCodexLog uses pickRolloutByUuid(files, s.codex_uuid)');
assert.ok(iCwd > 0 && iPick < iCwd, 'UUID match runs before the cwd match (UUID is authoritative)');

const sessions = readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
assert.ok(/const codexBefore = tool === 'codex' \? new Set\(await codexRolloutFiles\(\)/.test(sessions), 'launch snapshots the rollout set for codex');
assert.ok(/if \(codexBefore\) captureCodexUuid\(sid, codexBefore\)/.test(sessions), 'launch fires captureCodexUuid (fire-and-forget)');
assert.ok(sessions.includes('store.updateSession(sid, { codex_uuid: uuid })'), 'captureCodexUuid persists the UUID');
assert.ok(/s\.codex_uuid \|\| \(await findCodexSession/.test(sessions), 'resume prefers the captured UUID, then cwd-match');

const store = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
assert.ok(store.includes("'codex_uuid TEXT'"), 'store migrates a codex_uuid column');
assert.ok(/SESSION_FIELDS = \[[^\]]*'codex_uuid'/.test(store), 'codex_uuid is a writable session field');

console.log('codex_rollouts: all assertions passed');
