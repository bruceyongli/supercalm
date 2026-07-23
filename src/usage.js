// Usage monitor: token attribution across CLI transcript stores + read-only subscription windows
// from the local proxy fleet. The collectors live in usage_collect.js so they can also run one-off.

import { route, json, readJson } from './server.js';
import { Worker } from 'node:worker_threads';
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

const SUMMARY_CACHE_MS = Math.max(5000, Number(process.env.AIOS_USAGE_SUMMARY_CACHE_MS || 60000));
const summaryCache = new Map();
const summaryFlights = new Map();

function summaryKey(f) {
  return JSON.stringify({
    range: f.range,
    since: Math.floor(Number(f.since || 0) / 300000),
    until: Math.floor(Number(f.until || 0) / 300000),
    project: f.project, session: f.session, tool: f.tool, model: f.model, source: f.source, q: f.q, limit: f.limit,
  });
}

function buildSummaryOffThread(f) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./usage_summary_worker.js', import.meta.url), { workerData: { filters: f } });
    worker.once('message', (message) => {
      if (message?.ok) resolve(message.report);
      else reject(new Error(message?.error || 'usage summary worker failed'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`usage summary worker exited ${code}`)); });
  });
}

function refreshSummary(f, key = summaryKey(f)) {
  if (summaryFlights.has(key)) return summaryFlights.get(key);
  const flight = buildSummaryOffThread(f)
    .then((report) => {
      summaryCache.set(key, { at: Date.now(), report });
      if (summaryCache.size > 24) {
        const oldest = [...summaryCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, summaryCache.size - 16);
        for (const [oldKey] of oldest) summaryCache.delete(oldKey);
      }
      return report;
    })
    .finally(() => summaryFlights.delete(key));
  summaryFlights.set(key, flight);
  return flight;
}

route('GET', '/api/usage/summary', async (req, res, _params, url) => {
  try {
    const f = filters(url.searchParams);
    const key = summaryKey(f);
    const cached = summaryCache.get(key);
    if (cached) {
      // Stale-while-revalidate: analytics may be a minute old, but navigating to Usage never blocks
      // Node's request loop or waits on disk after the first snapshot exists.
      if (Date.now() - cached.at >= SUMMARY_CACHE_MS) refreshSummary(f, key).catch(() => {});
      return json(res, 200, { ok: true, filters: f, ...cached.report });
    }
    const report = await refreshSummary(f, key);
    json(res, 200, { ok: true, filters: f, ...report });
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
const warmSummaryTimer = setTimeout(() => {
  refreshSummary(filters(new URLSearchParams({ range: '30d' }))).catch(() => {});
}, 1000);
warmSummaryTimer.unref?.();
console.log('[aios] usage monitor ready (/api/usage)');
