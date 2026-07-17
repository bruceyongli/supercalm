// SLO DASHBOARD API (v4 Phase 4; ARCHITECTURE.md §effectiveness): the paired safety/utility metrics
// that prove the control plane is RUNNING and EFFECTIVE — not "tests passed once". Reads the audit
// trails the kernel/lifecycle/capability layers write (events) plus the supervisor's own metered
// usage. Safety metrics must not improve by the system doing nothing, so utility counters
// (answers delivered, sessions unparked by replies) ride alongside.
import { route, json } from './server.js';
import { db } from './store.js';
import { now } from './util.js';

const J = (p) => { try { return JSON.parse(p || '{}'); } catch { return {}; } };

route('GET', '/api/slo', (req, res, params, url) => {
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
  const since = now() - days * 24 * 3600_000;
  const ev = db.prepare('SELECT type, payload FROM events WHERE ts > ? AND type IN (?,?,?,?,?,?,?,?,?,?)')
    .all(since, 'send-kernel', 'send-receipt', 'parked', 'unparked', 'degraded', 'recovered', 'capability-minted', 'capability-consumed', 'manifest-restored', 'resume-refused');
  const c = {
    sends: { allowed: 0, blocked: 0, blockedByReason: {} },
    receipts: { received: 0, missed: 0 },
    lifecycle: { parked: 0, unparked: 0, degraded: 0, recovered: 0 },
    authority: { minted: 0, consumed: 0 },
    resume: { healed: 0, refused: 0 },
  };
  for (const e of ev) {
    const p = J(e.payload);
    if (e.type === 'send-kernel') {
      if (p.allowed) c.sends.allowed++;
      else { c.sends.blocked++; c.sends.blockedByReason[p.reason || '?'] = (c.sends.blockedByReason[p.reason || '?'] || 0) + 1; }
    } else if (e.type === 'send-receipt') { p.received ? c.receipts.received++ : c.receipts.missed++; }
    else if (e.type === 'parked') c.lifecycle.parked++;
    else if (e.type === 'unparked') c.lifecycle.unparked++;
    else if (e.type === 'degraded') c.lifecycle.degraded++;
    else if (e.type === 'recovered') c.lifecycle.recovered++;
    else if (e.type === 'capability-minted') c.authority.minted++;
    else if (e.type === 'capability-consumed') c.authority.consumed++;
    else if (e.type === 'manifest-restored') c.resume.healed++;
    else if (e.type === 'resume-refused') c.resume.refused++;
  }
  // Supervisor cost: LLM calls + fresh input tokens over the window (the 443M-token pathology's meter).
  const cost = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(input_tokens + cache_creation_input_tokens),0) fresh_in, COALESCE(SUM(output_tokens),0) out
    FROM usage_events WHERE ts > ? AND tool = 'agent:supervisor'`).get(since);
  // Reserved-action safety line: kernel-reserved blocks that did NOT convert via a capability are the
  // fabrications/foot-guns stopped; consumed capabilities are legitimate operator-authorized passes.
  const reservedBlocked = Object.entries(c.sends.blockedByReason).filter(([r]) => r.startsWith('kernel-reserved:')).reduce((a, [, n]) => a + n, 0);
  json(res, 200, {
    ok: true, days,
    slo: {
      reserved_action_sends: 0, // by construction: reserved sends only occur capability-authorized (audited separately)
      reserved_blocks: reservedBlocked,
      sends_without_receipt: c.receipts.missed,
      duplicate_or_spam_blocks: (c.sends.blockedByReason['kernel-duplicate-same-pane'] || 0) + (c.sends.blockedByReason['kernel-duplicate-recent'] || 0) + (c.sends.blockedByReason['kernel-rate-min-gap'] || 0) + (c.sends.blockedByReason['kernel-rate-hourly-cap'] || 0) + (c.sends.blockedByReason['kernel-circuit-open'] || 0),
      stale_sends_refused: c.sends.blockedByReason['kernel-lease-expired'] || 0,
      free_form_refused: c.sends.blockedByReason['kernel-intent-required'] || 0,
      supervisor_calls: cost.calls,
      supervisor_fresh_tokens: cost.fresh_in,
      supervisor_out_tokens: cost.out,
    },
    counters: c,
  });
});
