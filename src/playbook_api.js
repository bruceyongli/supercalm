// Global REST for the Supervisor playbook (Bet 2). Kept SEPARATE from src/agents/playbook.js so the store
// stays server-free — the offline optimizer (bin/supervisor-optimize.mjs) imports the store to read/write
// candidate versions without booting an HTTP listener. Loaded as a feature module by server.js.
import { route, json } from './server.js';
import { listPlaybooks, getPlaybook, activatePlaybook } from './agents/playbook.js';
import { listVerifyLabels, verifyLabelCounts } from './agents/verify_labels.js';

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

route('GET', '/api/supervisor/playbooks', (req, res) => {
  json(res, 200, { ok: true, playbooks: listPlaybooks().map((p) => ({ id: p.id, version: p.version, notes: p.notes, active: !!p.active, created_at: p.created_at, eval: p.eval_json ? safeParse(p.eval_json) : null })) });
});

route('GET', '/api/supervisor/playbook/:id', (req, res, { id }) => {
  const p = getPlaybook(id);
  if (!p) return json(res, 404, { error: 'no such playbook' });
  json(res, 200, { ok: true, playbook: { ...p, active: !!p.active, eval: p.eval_json ? safeParse(p.eval_json) : null } });
});

// Verify-path ground-truth labels (re-open -> was the "done" real?) + the bad-behavior taxonomy counts.
route('GET', '/api/supervisor/verify-labels', (req, res, _p, url) => {
  const pid = url?.searchParams?.get('project') || null;
  json(res, 200, { ok: true, counts: verifyLabelCounts(), labels: listVerifyLabels(pid) });
});

// The human apply-gate: promote a measured candidate to the live rubric.
route('POST', '/api/supervisor/playbook/:id/activate', (req, res, { id }) => {
  try {
    const p = activatePlaybook(id);
    json(res, 200, { ok: true, active: p.version, id: p.id });
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});
