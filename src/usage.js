// Usage monitor: token attribution across CLI transcript stores + read-only subscription windows
// from the local proxy fleet. The collectors live in usage_collect.js so they can also run one-off.

import { route, json, readJson } from './server.js';
import { usageOptions, usageReport } from './usage_store.js';
import { recordAgyStatuslinePayload, rescanUsage, startUsageCollector, subscriptionStatus } from './usage_collect.js';

function filters(q) {
  const range = q.get('range') || '7d';
  let since = Number(q.get('since')) || 0;
  const until = Number(q.get('until')) || 0;
  if (!since && range !== 'all') {
    const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
    since = Date.now() - days * 86400 * 1000;
  }
  return {
    range,
    since,
    until,
    project: q.get('project') || '',
    session: q.get('session') || '',
    tool: q.get('tool') || '',
    model: q.get('model') || '',
    source: q.get('source') || '',
    q: q.get('q') || '',
    limit: Number(q.get('limit')) || 80,
  };
}

route('GET', '/api/usage', (req, res, _params, url) => {
  try {
    const f = filters(url.searchParams);
    json(res, 200, { ok: true, filters: f, ...usageReport(f), options: usageOptions() });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

route('GET', '/api/usage/subscriptions', async (req, res) => {
  try {
    json(res, 200, { ok: true, ...(await subscriptionStatus()) });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

route('POST', '/api/usage/rescan', async (req, res) => {
  try {
    const b = await readJson(req).catch(() => ({}));
    const counts = await rescanUsage({
      resetCursors: !!b.resetCursors,
      maxFiles: Math.min(5000, Math.max(1, Number(b.maxFiles) || 1000)),
    });
    json(res, 200, { ok: true, ...counts });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

route('POST', '/api/hook/agy/statusline', async (req, res) => {
  try {
    const b = await readJson(req).catch(() => ({}));
    const payload = b.payload && typeof b.payload === 'object' ? b.payload : b;
    const ok = recordAgyStatuslinePayload(payload, { ts: b.ts || Date.now(), session_id: b.session_id || null });
    json(res, 200, { ok: true, recorded: !!ok });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

startUsageCollector();
console.log('[aios] usage monitor ready (/api/usage)');
