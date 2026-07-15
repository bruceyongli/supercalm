// Autonomous integrate-&-deploy — the ORCHESTRATOR (the piece that ties the pieces together). Dequeues one
// QUEUED integration at a time (FIFO, single-active) and drives it through the whole flow: circuit-breaker
// guard → deterministic gate (integrator.js) → publish (publisher.js) → the reborn server verifies. Runs on
// a tick + on-enqueue kick. Enable is PER-PROJECT (autoPublish + isolation on for that project); an
// integration whose project isn't opted in is REJECTED, never deployed. Every heavy step is injectable.
import * as I from './integrations.js';
import * as store from './store.js';
import { helperEnabled } from './project_helpers.js';
import { breakerBlocks } from './deploy_breaker.js';
import { driveGate } from './integrator.js';
import { drivePublish, publishEnabled } from './publisher.js';

const TICK_MS = Number(process.env.AIOS_DEPLOY_TICK_MS || 20000);
let _busy = false;

// Process at most ONE integration. Returns { skipped } when there's nothing to do, else { result } (the row
// after the step we drove it to) or { error }. The enable decision is PER-PROJECT (autoPublish + isolation on
// for that project), checked after the dequeue. Deps are injectable for tests; production uses the real ones.
export async function orchestrateOnce(deps = {}) {
  const {
    publishOn = publishEnabled,
    blocks = breakerBlocks,
    isolation = (pid) => helperEnabled(pid, 'isolation'),
    gate = driveGate,
    publish = drivePublish,
  } = deps;
  if (_busy) return { skipped: 'busy' };
  if (I.occupiedBy()) return { skipped: 'occupied' };       // single-active (incl. a parked HELD blocking the queue)
  const q = I.nextQueued();
  if (!q) return { skipped: 'empty' };
  _busy = true;
  try {
    const proj = q.project_id ? store.getProject(q.project_id) : null;
    const repoPath = proj?.path;
    const ft0 = () => I.getIntegration(q.id).fence_token;

    // Per-project gates: THIS project must have autonomous deploy + isolation on (the trigger enforces both,
    // so this is defensive), and its breaker must be closed.
    if (!publishOn(q.project_id)) return { result: I.transition(q.id, 'REJECTED', { fenceToken: ft0(), patch: { failure_code: 'autopublish_off' }, data: { note: "project's autonomous deploy is off" } }) };
    if (!isolation(q.project_id)) return { result: I.transition(q.id, 'REJECTED', { fenceToken: ft0(), patch: { failure_code: 'isolation_off' }, data: { note: 'project multi-session isolation is off' } }) };
    const brk = await blocks(q.project_id, repoPath);
    if (brk.blocked) return { result: I.transition(q.id, 'REJECTED', { fenceToken: ft0(), patch: { failure_code: 'breaker_open' }, data: { reason: brk.reason } }) };

    const gated = await gate(q.id, { fenceToken: ft0() });     // → APPROVED or REJECTED/HELD
    if (!gated || gated.stage !== 'APPROVED') return { result: gated };

    const pub = await publish(q.id, { fenceToken: ft0() });    // → RESTART_REQUESTED (+ detached deploy) or HELD
    return { result: pub };
  } catch (e) { console.error('[aios] orchestrate error:', e?.message || e); return { error: String(e?.message || e) }; }
  finally { _busy = false; }
}

// Fire an orchestration pass soon (used right after an enqueue, so a trigger doesn't wait for the tick).
export function kick() { setTimeout(() => orchestrateOnce().catch(() => {}), 50); }

// Boot recovery for GATE-stage orphans (the publisher owns the publish/rollback stages). A server restart
// mid-gate leaves an integration in PREPARING/CHECKING/APPROVED with no worker; park it HELD so the pipeline
// isn't wedged and a human (or requeue) can retry. integrations.js recoverOnBoot has already bumped the fence.
function recoverGateOnBoot() {
  const occ = I.occupiedBy();
  if (occ && ['PREPARING', 'CHECKING', 'APPROVED'].includes(occ.stage)) {
    try { I.transition(occ.id, 'HELD', { fenceToken: occ.fence_token, patch: { failure_code: 'gate_interrupted' }, data: { note: 'server restarted mid-gate' } }); }
    catch (e) { console.error('[aios] gate recover:', e?.message || e); }
  }
}

if (!process.env.AIOS_NO_LISTEN) {
  recoverGateOnBoot();
  const iv = setInterval(() => orchestrateOnce().catch(() => {}), TICK_MS);
  if (iv.unref) iv.unref();
}
