// Routes for the operator-doctrine approval gate (src/agents/doctrine.js holds the store + distiller —
// split like playbook.js/playbook_api.js so the core module never pulls in server.js). The POST status
// flip candidate→active IS the production deployment: active rules inject into the supervisor's answer
// prompt on the next tick.

import { route, json } from './server.js';
import { listDoctrine, getDoctrine, updateDoctrine, deleteDoctrine, distillFromReply, triageDoctrine, applyTriage } from './agents/doctrine.js';

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

route('GET', '/api/doctrine', (req, res) => {
  const rows = listDoctrine();
  json(res, 200, {
    ok: true,
    counts: rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}),
    rules: rows,
  });
});

// Approve / reject / edit (edit + approve in one call: pass status + revised text).
route('POST', '/api/doctrine/:id', async (req, res, { id }) => {
  if (!getDoctrine(id)) return json(res, 404, { error: 'no such doctrine rule' });
  let body = {};
  try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
  // Arrival audit: the operator's approve clicks have silently vanished before — log every arrival so
  // "the click didn't take" is diagnosable as network-vs-client (pair with the status-transition line).
  console.log(`[doctrine] POST ${id} body=${JSON.stringify(body).slice(0, 120)} ua="${String(req.headers['user-agent'] || '').slice(0, 60)}"`);
  if (body.status && !['candidate', 'active', 'rejected'].includes(body.status)) {
    return json(res, 400, { error: 'status must be candidate|active|rejected' });
  }
  json(res, 200, { ok: true, rule: updateDoctrine(id, body) });
});

route('DELETE', '/api/doctrine/:id', (req, res, { id }) => {
  deleteDoctrine(id);
  json(res, 200, { ok: true, deleted: id });
});

// TRIAGE: the supervisor model reviews + ranks the candidate backlog (stored as recommendations;
// nothing changes status until the operator applies or acts per-card).
route('POST', '/api/doctrine/triage', async (req, res) => {
  try {
    const r = await triageDoctrine();
    json(res, 200, { ok: true, ...r, rules: listDoctrine() });
  } catch (e) {
    json(res, 502, { ok: false, error: String(e.message || e).slice(0, 200) });
  }
});
route('POST', '/api/doctrine/triage/apply', (req, res) => {
  json(res, 200, { ok: true, ...applyTriage(), rules: listDoctrine() });
});

// Manual distill of the session's latest answered decision (testing / backfill an interesting reply).
route('POST', '/api/session/:id/doctrine/distill', async (req, res, { id: sid }) => {
  const r = await distillFromReply(sid, { maxAgeMs: 7 * 24 * 3600 * 1000 }).catch((e) => ({ error: String(e.message || e) }));
  json(res, 200, { ok: !r?.error, result: r || { skipped: 'no-answered-decision-or-not-supervised' } });
});
