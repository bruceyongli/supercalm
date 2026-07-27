// One reusable request seam for the autonomous integration pipeline. The HTTP route and the Supervisor
// context both call this function, so "Supervisor may integrate" cannot drift into a weaker, separate
// deploy path. This ONLY enqueues an exact clean worktree HEAD; the existing orchestrator still owns every
// gate, publication, health, and rollback transition.
import { realpathSync } from 'node:fs';
import { ROOT } from './config.js';
import * as store from './store.js';
import * as I from './integrations.js';
import { gitOut } from './git.js';
import { helperEnabled } from './project_helpers.js';

function sameRepo(a, b) {
  if (!a || !b) return false;
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
}

function refusal(code, error, status = 400) {
  return { ok: false, code, error, status };
}

export function integrationReadiness(sessionId, deps = {}) {
  const getSession = deps.getSession || store.getSession;
  const getProject = deps.getProject || store.getProject;
  const enabled = deps.helperEnabled || helperEnabled;
  const root = deps.root || ROOT;
  const same = deps.sameRepo || sameRepo;
  const s = getSession(sessionId);
  if (!s) return refusal('no_session', 'no such session', 404);
  if (!s.project_id) return refusal('no_project', 'session has no project');
  if (!enabled(s.project_id, 'autoPublish')) {
    return refusal('autopublish_off', 'autonomous deployment is not enabled for this project');
  }
  if (!enabled(s.project_id, 'isolation')) {
    return refusal('isolation_off', 'session project is not isolated — enable multi-session collaboration first');
  }
  if (!s.branch || !s.worktree_path) {
    return refusal('no_worktree', 'session has no isolated worktree branch to integrate');
  }
  const project = getProject(s.project_id);
  if (!project || !same(project.path, root)) {
    return refusal('unsupported_target', "autonomous deployment currently supports only Supercalm's self-deploy pipeline");
  }
  return { ok: true, ready: true, session: s, project };
}

export async function requestSessionIntegration(sessionId, deps = {}) {
  const ready = integrationReadiness(sessionId, deps);
  if (!ready.ok) return ready;
  const git = deps.gitOut || gitOut;
  const enqueue = deps.enqueue || I.enqueue;
  const list = deps.listIntegrations || I.listIntegrations;
  const kick = deps.kick || (await import('./deploy_orchestrator.js')).kick;
  const { session: s, project } = ready;

  const head = await git(s.worktree_path, ['rev-parse', 'HEAD']);
  const candidateSha = String(head.text || '').trim();
  if (!candidateSha) return refusal('no_candidate', 'could not resolve the session worktree HEAD');

  const branch = await git(s.worktree_path, ['branch', '--show-current']);
  if (String(branch.text || '').trim() !== s.branch) {
    return refusal('branch_mismatch', `session branch is ${s.branch}, but the worktree is on ${String(branch.text || '').trim() || '(detached)'}`);
  }

  const dirty = await git(s.worktree_path, ['status', '--porcelain']);
  if (dirty.error) return refusal('git_status_failed', 'could not verify that the candidate worktree is clean');
  if (String(dirty.text || '').trim()) {
    return refusal('dirty_worktree', 'candidate worktree is dirty — commit the verified work before integration');
  }

  // Idempotent by exact session+candidate. A heartbeat/tick or server restart may ask again; it must
  // observe the durable row, never enqueue duplicate deployments. A failed exact candidate is also not
  // retried blindly — a new commit (or an explicit operator requeue) is required.
  const prior = list(200).find((row) => row.session_id === sessionId && row.candidate_sha === candidateSha);
  if (prior) {
    if (['REJECTED', 'ROLLED_BACK'].includes(prior.stage)) {
      return refusal('candidate_previously_failed', `this exact candidate already ended ${prior.stage}; produce a corrected commit before retrying`);
    }
    return { ok: true, duplicate: true, integration: prior, candidateSha };
  }

  const base = await git(project.path, ['rev-parse', 'HEAD']);
  const baseSha = String(base.text || '').trim();
  if (!baseSha) return refusal('no_base', 'could not resolve the integration base HEAD');

  const integration = enqueue({
    projectId: s.project_id,
    sessionId,
    sourceBranch: s.branch,
    sourceSha: candidateSha,
    candidateSha,
    baseSha,
  });
  kick();
  return { ok: true, duplicate: false, integration, candidateSha, baseSha };
}
