import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'aios-integration-request-'));
process.env.AIOS_NO_LISTEN = '1';

const { integrationReadiness, requestSessionIntegration } = await import('../src/integration_request.js');

const root = '/repo/main';
const session = {
  id: 's_int',
  project_id: 'p_int',
  branch: 'supercalm/aios/s_int',
  worktree_path: '/repo/worktree',
};
const project = { id: 'p_int', path: root };

function deps(over = {}) {
  const flags = { autoPublish: true, isolation: true, ...(over.flags || {}) };
  const responses = {
    'rev-parse HEAD@/repo/worktree': { text: 'candidate123', error: '' },
    'branch --show-current@/repo/worktree': { text: session.branch, error: '' },
    'status --porcelain@/repo/worktree': { text: '', error: '' },
    'rev-parse HEAD@/repo/main': { text: 'base123', error: '' },
    ...(over.responses || {}),
  };
  const rows = over.rows || [];
  const enqueued = [];
  let kicked = 0;
  return {
    getSession: (id) => id === session.id ? (over.session || session) : null,
    getProject: (id) => id === project.id ? (over.project || project) : null,
    helperEnabled: (_pid, key) => !!flags[key],
    root,
    sameRepo: over.sameRepo || ((a, b) => a === b),
    expectedCandidateSha: over.expectedCandidateSha || '',
    gitOut: async (cwd, args) => responses[`${args.join(' ')}@${cwd}`] || { text: '', error: 'unexpected git call' },
    listIntegrations: () => rows,
    enqueue: (row) => {
      enqueued.push(row);
      return { id: 'int_new', stage: 'QUEUED', session_id: row.sessionId, candidate_sha: row.candidateSha };
    },
    kick: () => { kicked++; },
    _enqueued: enqueued,
    _kicked: () => kicked,
  };
}

{
  const d = deps({ flags: { autoPublish: false } });
  assert.equal(integrationReadiness(session.id, d).code, 'autopublish_off');
  assert.equal(d._enqueued.length, 0);
}
{
  const d = deps({ flags: { isolation: false } });
  assert.equal(integrationReadiness(session.id, d).code, 'isolation_off');
}
{
  const d = deps({ session: { ...session, worktree_path: null } });
  assert.equal(integrationReadiness(session.id, d).code, 'no_worktree');
}
{
  const d = deps({ sameRepo: () => false });
  assert.equal(integrationReadiness(session.id, d).code, 'unsupported_target');
}
{
  const d = deps({ responses: { 'status --porcelain@/repo/worktree': { text: ' M src/file.js', error: '' } } });
  const r = await requestSessionIntegration(session.id, d);
  assert.equal(r.code, 'dirty_worktree');
  assert.equal(d._enqueued.length, 0, 'dirty candidate never queues');
  assert.equal(d._kicked(), 0);
}
{
  const d = deps({ responses: { 'branch --show-current@/repo/worktree': { text: 'wrong-branch', error: '' } } });
  assert.equal((await requestSessionIntegration(session.id, d)).code, 'branch_mismatch');
}
{
  const d = deps({ expectedCandidateSha: 'candidate123' });
  const r = await requestSessionIntegration(session.id, d);
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.integration.stage, 'QUEUED');
  assert.deepEqual(d._enqueued, [{
    projectId: 'p_int',
    sessionId: 's_int',
    sourceBranch: session.branch,
    sourceSha: 'candidate123',
    candidateSha: 'candidate123',
    baseSha: 'base123',
  }]);
  assert.equal(d._kicked(), 1);
}
{
  const d = deps({ expectedCandidateSha: 'verified-before-race' });
  const r = await requestSessionIntegration(session.id, d);
  assert.equal(r.code, 'candidate_changed');
  assert.equal(d._enqueued.length, 0, 'a post-verification HEAD change never queues');
  assert.equal(d._kicked(), 0);
}
{
  const d = deps({ responses: { 'rev-parse HEAD@/repo/worktree': { text: 'stale-stdout', error: 'git failed' } } });
  assert.equal((await requestSessionIntegration(session.id, d)).code, 'git_head_failed');
  assert.equal(d._enqueued.length, 0, 'git errors fail closed even when stdout is non-empty');
}
{
  const prior = { id: 'int_prior', stage: 'VERIFYING', session_id: session.id, candidate_sha: 'candidate123' };
  const d = deps({ rows: [prior] });
  const r = await requestSessionIntegration(session.id, d);
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
  assert.equal(r.integration.id, prior.id);
  assert.equal(d._enqueued.length, 0, 'same exact candidate is idempotent');
  assert.equal(d._kicked(), 0);
}
{
  const prior = { id: 'int_failed', stage: 'REJECTED', session_id: session.id, candidate_sha: 'candidate123' };
  const d = deps({ rows: [prior] });
  const r = await requestSessionIntegration(session.id, d);
  assert.equal(r.code, 'candidate_previously_failed');
  assert.equal(d._enqueued.length, 0, 'failed exact candidate is never blindly retried');
}

console.log('integration_request.test ok');
