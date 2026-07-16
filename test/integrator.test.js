// Autonomous integrate-&-deploy — the deterministic GATE (docs/specs/autonomous-deploy-plan.md step 3).
// Verifies driveGate() on throwaway repos: a clean passing candidate → APPROVED; failing tests → REJECTED;
// a PROTECTED-PATH change → REJECTED (never runs checks); a rebase CONFLICT → REJECTED. Scratch DB + scratch
// worktree root — never the live system.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'gate-db-'));
process.env.AIOS_WORKTREE_ROOT = mkdtempSync(join(tmpdir(), 'gate-wt-'));

const store = await import('../src/store.js');
const I = await import('../src/integrations.js');
const { driveGate } = await import('../src/integrator.js');

const repo = mkdtempSync(join(tmpdir(), 'gate-repo-'));
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
writeFileSync(join(repo, 'f'), 'base\n'); g('add', '.'); g('commit', '-qm', 'base');

const proj = store.createProject({ id: 'p_gate', name: 'gate', path: repo });

// Build a candidate commit off main (returns its SHA); leaves main checked out.
function candidate(branch, files) {
  g('checkout', '-q', '-b', branch, 'main');
  for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(repo, name)), { recursive: true }); writeFileSync(join(repo, name), content); }
  g('add', '.'); g('commit', '-qm', branch);
  const sha = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  return sha;
}
// After a gate verdict that leaves the pipeline OCCUPIED (APPROVED/HELD), free it so the next test can claim.
function free(it) { const r = I.getIntegration(it.id); if (!['REJECTED', 'GREEN', 'ROLLED_BACK', 'QUEUED'].includes(r.stage)) I.transition(it.id, 'REJECTED', { fenceToken: r.fence_token }); }

// 1) clean candidate + passing tests → APPROVED
const c1 = candidate('c1', { 'newfile.txt': 'hello\n' });
const i1 = I.enqueue({ projectId: proj.id, sourceBranch: 'c1', candidateSha: c1 });
const r1 = await driveGate(i1.id, { testCmd: 'true' });
assert.equal(r1.stage, 'APPROVED', 'clean + passing → APPROVED (got ' + r1.stage + '/' + r1.failure_code + ')');
assert.ok(r1.checks_digest, 'checks_digest bound to the verdict');
assert.ok(r1.candidate_sha, 'rebased candidate_sha recorded');
free(i1);

// 2) failing tests → REJECTED (checks_failed)
const c2 = candidate('c2', { 'newfile2.txt': 'x\n' });
const i2 = I.enqueue({ projectId: proj.id, sourceBranch: 'c2', candidateSha: c2 });
const r2 = await driveGate(i2.id, { testCmd: 'false' });
assert.equal(r2.stage, 'REJECTED', 'failing tests → REJECTED');
assert.equal(r2.failure_code, 'checks_failed', 'failure_code checks_failed');
free(i2);

// 3) protected-path change → REJECTED (protected_path), checks never run
const c3 = candidate('c3', { 'bin/deploy': 'echo hacked\n' });
const i3 = I.enqueue({ projectId: proj.id, sourceBranch: 'c3', candidateSha: c3 });
const r3 = await driveGate(i3.id, { testCmd: 'true' }); // even with passing tests, a protected path is ineligible
assert.equal(r3.stage, 'REJECTED', 'protected path → REJECTED even with passing tests');
assert.equal(r3.failure_code, 'protected_path', 'failure_code protected_path');
free(i3);

// 4) rebase conflict (main moved on the same file) → REJECTED (rebase_conflict)
const c4 = candidate('c4', { f: 'candidate change\n' });
// main diverges on the SAME file after c4 branched
writeFileSync(join(repo, 'f'), 'main change\n'); g('add', '.'); g('commit', '-qm', 'main-moved');
const i4 = I.enqueue({ projectId: proj.id, sourceBranch: 'c4', candidateSha: c4 });
const r4 = await driveGate(i4.id, { testCmd: 'true' });
assert.equal(r4.stage, 'REJECTED', 'rebase conflict → REJECTED');
assert.equal(r4.failure_code, 'rebase_conflict', 'failure_code rebase_conflict');
free(i4);

// 5) AI reviewer panel (flag on): a failing panel → REJECTED ai_review_failed (checks passed, but review blocks)
process.env.AIOS_AI_REVIEWERS = '1';
const c5 = candidate('c5', { 'r.txt': 'hello\n' });
const i5 = I.enqueue({ projectId: proj.id, sourceBranch: 'c5', candidateSha: c5 });
const r5 = await driveGate(i5.id, { testCmd: 'true', review: async () => ({ pass: false, reviews: [{ lens: 'prod_failure', verdict: 'FAIL', severity: 'high' }], blocking: ['prod_failure'] }) });
assert.equal(r5.stage, 'REJECTED', 'failing AI panel → REJECTED even with passing deterministic checks');
assert.equal(r5.failure_code, 'ai_review_failed', 'failure_code ai_review_failed');
free(i5);

// 6) AI reviewer panel: a passing panel → APPROVED
const c6 = candidate('c6', { 's.txt': 'hi\n' });
const i6 = I.enqueue({ projectId: proj.id, sourceBranch: 'c6', candidateSha: c6 });
const r6 = await driveGate(i6.id, { testCmd: 'true', review: async () => ({ pass: true, reviews: [{ lens: 'diff_risk', verdict: 'PASS', severity: 'none' }], blocking: [] }) });
assert.equal(r6.stage, 'APPROVED', 'passing AI panel → APPROVED');
free(i6);
process.env.AIOS_AI_REVIEWERS = '';

// 7) store.js / tests / package.json are NO LONGER protected (narrowed list) — an additive schema change
// flows through the gate → APPROVED (the pipeline can now auto-ship real multi-session work).
const c7 = candidate('c7', { 'src/store.js': 'db.exec("CREATE TABLE IF NOT EXISTS t (id TEXT)");\n', 'test/new.test.js': 'console.log("ok");\n' });
const i7 = I.enqueue({ projectId: proj.id, sourceBranch: 'c7', candidateSha: c7 });
const r7 = await driveGate(i7.id, { testCmd: 'true' });
assert.equal(r7.stage, 'APPROVED', 'additive store.js + test change is no longer protected → APPROVED (got ' + r7.stage + '/' + r7.failure_code + ')');
free(i7);

// 8) a destructive schema op → HELD destructive_change (never auto-deploy; protects live user data)
const c8 = candidate('c8', { 'src/store.js': 'db.exec("DROP TABLE sessions");\n' });
const i8 = I.enqueue({ projectId: proj.id, sourceBranch: 'c8', candidateSha: c8 });
const r8 = await driveGate(i8.id, { testCmd: 'true' });
assert.equal(r8.stage, 'HELD', 'destructive schema op → HELD (got ' + r8.stage + '/' + r8.failure_code + ')');
assert.equal(r8.failure_code, 'destructive_change', 'failure_code destructive_change');
free(i8);

// the gate never left an integration occupying the pipeline
assert.equal(I.occupiedBy(), null, 'pipeline free after all gate runs');

console.log('integrator.test: all assertions passed');
