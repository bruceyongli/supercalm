// HTTP surface for the autonomous deploy pipeline: the integrations audit list + the circuit-breaker
// view/clear. The integrate TRIGGER route is added alongside these in the orchestrator step. Read-only
// except the breaker clear (a deliberate operator action to re-arm after a thrash trip).
import { route, json, readJson } from './server.js';
import * as store from './store.js';
import * as I from './integrations.js';
import { gitOut } from './git.js';
import { helperEnabled } from './project_helpers.js';
import { breakerState, clearBreaker, evaluate } from './deploy_breaker.js';
import { kick } from './deploy_orchestrator.js';

// Recent integrations (audit): stage, failure_code, shas, timestamps. Newest first.
route('GET', '/api/deploy/integrations', (req, res, params, url) => {
  const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
  json(res, 200, { ok: true, integrations: I.listIntegrations(limit), occupied: I.occupiedBy() });
});

// One integration + its immutable event trail.
route('GET', '/api/deploy/integration/:id', (req, res, { id }) => {
  const it = I.getIntegration(id);
  if (!it) return json(res, 404, { error: 'no such integration' });
  json(res, 200, { ok: true, integration: it, events: I.eventsFor(id) });
});

// Circuit-breaker state for a project (evaluates trip conditions on read).
route('GET', '/api/deploy/breaker', async (req, res, params, url) => {
  const pid = url.searchParams.get('project');
  if (!pid) return json(res, 400, { error: 'project required' });
  const proj = store.getProject(pid);
  json(res, 200, { ok: true, breaker: await evaluate(pid, proj?.path) });
});

// Clear (re-arm) a tripped breaker — an explicit operator action.
route('POST', '/api/deploy/breaker/clear', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  const pid = b.project;
  if (!pid) return json(res, 400, { error: 'project required' });
  json(res, 200, { ok: true, breaker: clearBreaker(pid) });
});

// The TRIGGER: request that a session's isolated branch be integrated + (if autoPublish is on) deployed.
// Requires the project's multi-session isolation (so the session has its own worktree + branch to ship).
// Enqueues an integration from the branch HEAD; the orchestrator picks it up. Callable by the session's
// agent, its supervisor, or the operator — nothing merges by hand.
route('POST', '/api/session/:id/integrate', async (req, res, { id }) => {
  const s = store.getSession(id);
  if (!s) return json(res, 404, { error: 'no such session' });
  if (!s.project_id || !helperEnabled(s.project_id, 'isolation')) return json(res, 400, { error: 'session project is not isolated — enable multi-session collaboration first' });
  if (!helperEnabled(s.project_id, 'autoPublish')) return json(res, 400, { error: 'autonomous deploy is not enabled for this project — turn it on in the Projects view' });
  if (!s.branch || !s.worktree_path) return json(res, 400, { error: 'session has no worktree branch to integrate' });
  const proj = store.getProject(s.project_id);
  const candidateSha = (await gitOut(s.worktree_path, ['rev-parse', 'HEAD'])).text.trim();
  const baseSha = (await gitOut(proj?.path || s.worktree_path, ['rev-parse', 'HEAD'])).text.trim();
  if (!candidateSha) return json(res, 400, { error: 'could not resolve the session branch HEAD' });
  const it = I.enqueue({ projectId: s.project_id, sessionId: id, sourceBranch: s.branch, sourceSha: candidateSha, candidateSha, baseSha });
  kick();
  json(res, 201, { ok: true, integration: it });
});
