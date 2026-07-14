// HTTP surface for the autonomous deploy pipeline: the integrations audit list + the circuit-breaker
// view/clear. The integrate TRIGGER route is added alongside these in the orchestrator step. Read-only
// except the breaker clear (a deliberate operator action to re-arm after a thrash trip).
import { route, json, readJson } from './server.js';
import * as store from './store.js';
import * as I from './integrations.js';
import { breakerState, clearBreaker, evaluate } from './deploy_breaker.js';

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
