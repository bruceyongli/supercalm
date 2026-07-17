// Operator-facing capability minting (v4 Phase 2, S1). Routes are tailnet-operator surfaces by
// deployment; the mint provenance is therefore operator_tap. The kernel-escalation notification
// links here (session?id=<sid>&mint=<class>) so a blocked reserved action becomes: tap the push →
// one confirm → the capability exists → the next supervisor attempt consumes it and proceeds.
import { route, json, readJson } from './server.js';
import { mintCapability, getCapability } from './capabilities.js';
import * as store from './store.js';
import { RESERVED_CLASSES } from './agents/send_kernel.js';

route('POST', '/api/capability/mint', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  const action = String(b.action || '');
  if (!RESERVED_CLASSES.includes(action)) return json(res, 400, { error: `action must be a reserved class: ${RESERVED_CLASSES.join(' | ')}` });
  const sid = b.session ? String(b.session) : null;
  if (sid && !store.getSession(sid)) return json(res, 404, { error: 'no such session' });
  const cap = mintCapability({
    sessionId: sid,
    projectId: sid ? store.getSession(sid)?.project_id : null,
    action,
    scope: String(b.scope || ''),
    ttlMs: Number(b.ttlMs) > 0 ? Number(b.ttlMs) : 15 * 60_000,
    uses: Number(b.uses) > 0 ? Number(b.uses) : 1,
    mintedBy: 'operator_tap',
  });
  store.addEvent(sid || 'global', 'capability-minted', { capability: cap.id, action, scope: cap.scope, ttlMs: cap.expires_at - cap.created_at });
  json(res, 201, { ok: true, capability: cap });
});

route('GET', '/api/capability/:id', (req, res, { id }) => {
  const cap = getCapability(id);
  if (!cap) return json(res, 404, { error: 'no such capability' });
  json(res, 200, { ok: true, capability: cap });
});
