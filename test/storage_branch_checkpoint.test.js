import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'aios-storage-branch-'));
process.env.AIOS_DATA = join(root, 'data');
const { createStorageBranchCheckpoint, storageBranchCheckpointAllows: allows, storageBranchEvidenceValid } = await import('../src/storage_maintenance.js');
const { verifyResume } = await import('../src/launch_contract.js');
try {
  const native = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const pending = { id: 's_branch', token: 'private-job-nonce', phase: 'parked', tool: 'codex', codex_uuid: native,
    worktree_path: '/Users/operator/worktrees/project/s_branch', project_path: '/Users/operator/project' };
  const session = { ...pending, desired_status: 'waiting', status_reason: 'storage-maintenance' };
  const manifest = { sid: pending.id, tool: 'codex', worktree_path: pending.worktree_path, cwd: pending.worktree_path,
    project_path: pending.project_path, branch: 'supercalm/project/s_branch' };
  pending.branchCheckpoint = createStorageBranchCheckpoint(pending, 'design/site-refresh-dark', 1000);
  const verdict = verifyResume(manifest, session, { branch: pending.branchCheckpoint.branch });
  const input = { manifest, verdict, pending, session, actualBranch: pending.branchCheckpoint.branch,
    actualWorktreePath: pending.worktree_path, projectPath: pending.project_path, maintenanceToken: pending.token,
    recoveryReason: 'storage-maintenance', now: 2000 };
  assert.equal(allows(input), true, 'same native conversation can preserve its recorded pre-freeze branch');
  assert.equal(await storageBranchEvidenceValid(pending.branchCheckpoint), true);
  for (const patch of [
    { recoveryReason: 'resume' }, { recoveryReason: 'boot-recovery' }, { maintenanceToken: null }, { maintenanceToken: 'another-job' },
    { actualBranch: 'another-branch' }, { actualBranch: null }, { actualWorktreePath: pending.project_path }, { projectPath: '/another/project' },
    { session: { ...session, codex_uuid: '11111111-bbbb-cccc-dddd-eeeeeeeeeeee' } },
    { session: { ...session, tool: 'claude' } }, { session: { ...session, desired_status: 'exited' } },
    { session: { ...session, status_reason: 'operator-kill' } }, { session: { ...session, id: 's_other' } },
    { session: { ...session, worktree_path: '/another/worktree' } },
    { pending: { ...pending, phase: 'complete' } }, { pending: { ...pending, branchCheckpoint: null } },
    { pending: { ...pending, branchCheckpoint: { ...pending.branchCheckpoint, capturedAt: 3000 } } },
    { pending: { ...pending, branchCheckpoint: { ...pending.branchCheckpoint, token: 'old-job' } } },
    { manifest: { ...manifest, project_path: '/different/project' } },
    { manifest: { ...manifest, cwd: '/different/cwd' } },
  ]) assert.equal(allows({ ...input, ...patch }), false, JSON.stringify(patch));
  const wrongTree = { ...session, worktree_path: '/another/worktree' };
  assert.equal(allows({ ...input, session: wrongTree, verdict: verifyResume(manifest, wrongTree, { branch: input.actualBranch }) }), false);
  const wrongTool = { ...session, tool: 'claude' };
  assert.equal(allows({ ...input, session: wrongTool, verdict: verifyResume(manifest, wrongTool, { branch: input.actualBranch }) }), false);
  assert.equal(allows({ ...input, actualWorktreePath: '/mounted/project/s_branch', pathsEqual: (a, b) => a === b
    || a === pending.worktree_path && b === '/mounted/project/s_branch' }), true, 'registered physical identity can represent the same logical worktree');
  assert.equal(createStorageBranchCheckpoint({ ...pending, codex_uuid: null }, input.actualBranch), null);
  assert.equal(createStorageBranchCheckpoint(pending, 'HEAD'), null);

  const evidencePath = join(root, 'pre-maintenance-terminal.txt'), contents = 'pre-maintenance commit on design/site-refresh-dark';
  await writeFile(evidencePath, contents);
  const recovered = { ...pending.branchCheckpoint, source: 'recovered-pre-maintenance-evidence',
    evidence: [{ path: evidencePath, sha256: createHash('sha256').update(contents).digest('hex') }] };
  assert.equal(allows({ ...input, pending: { ...pending, branchCheckpoint: recovered } }), true);
  assert.equal(await storageBranchEvidenceValid(recovered), true);
  await writeFile(evidencePath, 'changed after approval');
  assert.equal(await storageBranchEvidenceValid(recovered), false, 'evidence hashes are actually checked before the exception');
  await writeFile(evidencePath, contents); const alias = join(root, 'evidence-alias'); await symlink(evidencePath, alias);
  assert.equal(await storageBranchEvidenceValid({ ...recovered, evidence: [{ ...recovered.evidence[0], path: alias }] }), false);
  assert.equal(await storageBranchEvidenceValid({ ...recovered, evidence: [] }), false);
  const source = await readFile(new URL('../bin/storage-maintenance.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('s.branchCheckpoint = createStorageBranchCheckpoint') < source.indexOf("process.kill(p.pid, 'SIGSTOP')"), 'checkpoint is durably collected before any pause signal');
  console.log('storage branch checkpoint passed: branch-only maintenance exception, exact nonce/native/path binding, unchanged isolation/tool guards, real evidence hashing');
} finally { await rm(root, { recursive: true, force: true }); }
