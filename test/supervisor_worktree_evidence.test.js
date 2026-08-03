import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-worktree-evidence-data-'));
process.env.AIOS_NO_LISTEN = '1';

const root = await mkdtemp(join(tmpdir(), 'aios-worktree-evidence-repo-'));
const canonical = join(root, 'canonical');
const worktree = join(root, 'isolated');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', '-b', 'main', canonical]);
git(canonical, 'config', 'user.email', 'test@example.com');
git(canonical, 'config', 'user.name', 'Test');
await writeFile(join(canonical, 'state.txt'), 'base\n');
git(canonical, 'add', '.');
git(canonical, 'commit', '-qm', 'base');
const canonicalHead = git(canonical, 'rev-parse', 'HEAD');
git(canonical, 'worktree', 'add', '-qb', 'isolated-test', worktree);
await writeFile(join(worktree, 'state.txt'), 'base\nisolated progress\n');
git(worktree, 'add', '.');
git(worktree, 'commit', '-qm', 'isolated progress');
const isolatedHead = git(worktree, 'rev-parse', 'HEAD');
assert.notEqual(isolatedHead, canonicalHead, 'fixture checkouts diverge');

const store = await import('../src/store.js');
const { gitHead, sessionContext, sessionRepoPath } = await import('../src/agents/evidence.js');
const { gitProbe } = await import('../src/agents/probes.js');
store.createProject({ id: 'p_worktree_evidence', name: 'worktree evidence', path: canonical });
store.createSession({ id: 's_worktree_evidence', project_id: 'p_worktree_evidence', tool: 'codex', tmux: 'unused', status: 'waiting' });
store.updateSession('s_worktree_evidence', { worktree_path: worktree, branch: 'isolated-test' });
let session = store.getSession('s_worktree_evidence');
const project = store.getProject('p_worktree_evidence');

const observed = await gitProbe(sessionRepoPath(session, project));
assert.equal(observed.target, worktree, 'system probe targets the session worktree');
assert.equal(observed.result.sha, isolatedHead, 'system probe observes the session HEAD');
assert.equal(await gitHead(sessionRepoPath(session, project)), isolatedHead, 'baseline HEAD comes from the session worktree');

const evidence = await sessionContext(session, { baseRef: canonicalHead, includeDiff: false, terminalMax: 100 });
assert.equal(evidence.session.worktree_path, worktree, 'review evidence exposes its checkout provenance');
assert.match(evidence.git.commits_since_baseline, /isolated progress/, 'review evidence reads worktree commits');

// Supervisor-plane file writes must follow the same checkout resolver. A Git worktree is not a
// filesystem boundary if a privileged helper silently writes the canonical project path instead.
store.upsertGrant(session.id, 'fixture-writer', { caps: ['write-files'] });
const { makeContext } = await import('../src/agents/context.js');
const writer = makeContext({ id: 'fixture-writer', capabilities: ['write-files'] }, session.id);
await writer.writeProjectFile('supervisor-owned.txt', 'isolated only\n');
assert.equal(await readFile(join(worktree, 'supervisor-owned.txt'), 'utf8'), 'isolated only\n');
await assert.rejects(
  readFile(join(canonical, 'supervisor-owned.txt'), 'utf8'),
  (error) => error?.code === 'ENOENT',
  'the canonical checkout is not dirtied by a Supervisor write for an isolated session',
);

// Keep both Context probe call sites wired through the same resolver. This mutation lock catches a
// future direct project.path regression even though importing Context in isolation boots session IO.
const contextSource = await readFile(new URL('../src/agents/context.js', import.meta.url), 'utf8');
assert.ok(contextSource.split('sessionRepoPath(s, proj)').length >= 3, 'runProbes and gitHead resolve the session checkout');
assert.doesNotMatch(contextSource, /gitProbe\(proj\.path\)|gitHead\(proj\.path\)/, 'no direct shared-checkout probe remains');
assert.doesNotMatch(contextSource, /const base = normalize\(proj\.path\)/, 'Supervisor writes never bypass session checkout provenance');

// A recorded but unavailable worktree must fail closed, never fall back to plausible-looking state
// from the shared checkout.
store.updateSession('s_worktree_evidence', { worktree_path: join(root, 'missing-worktree') });
session = store.getSession('s_worktree_evidence');
const missingPath = sessionRepoPath(session, project);
const failedProbe = await gitProbe(missingPath);
assert.equal(failedProbe.target, join(root, 'missing-worktree'));
assert.equal(failedProbe.result.ok, false, 'stale worktree provenance fails closed');
assert.equal(await gitHead(missingPath), null, 'baseline does not silently substitute the shared HEAD');

console.log('supervisor_worktree_evidence.test ok');
process.exit(0); // importing the real Context also boots long-lived ancillary service scanners
