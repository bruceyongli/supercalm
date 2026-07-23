import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = await mkdtemp(join(tmpdir(), 'aios-session-usage-'));
process.env.AIOS_SESSION_USAGE_CACHE_MS = '60000';

const { db, createProject, createSession, updateSession } = await import('../src/store.js');
const { recordUsage, usageDashboardReport, usageForSession } = await import('../src/usage_store.js');

createProject({ id: 'p_usage', name: 'Usage', path: '/tmp/usage-project' });
createSession({ id: 's_usage', project_id: 'p_usage', tool: 'codex', tmux: 'tmux-usage', status: 'working', model: 'gpt-5.5', codex_uuid: 'uuid-usage' });
updateSession('s_usage', { codex_uuid: 'uuid-usage' });
const ts = Date.now();
for (let i = 0; i < 12000; i++) {
  recordUsage({
    source_id: 'usage-' + i,
    source: i % 2 ? 'codex-rollout' : 'proxy',
    ts: ts + i,
    session_id: 's_usage',
    tool: 'codex', provider: 'openai', model: 'gpt-5.5', project_id: 'p_usage', project: 'Usage', cwd: '/tmp/usage-project',
    input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, total_tokens: 13,
    raw: { deliberately: 'not returned by the session usage endpoint' },
  });
}
recordUsage({
  source_id: 'usage-external', source: 'codex-jsonl', ts: ts + 12001, external_session_id: 'uuid-usage',
  tool: 'codex', provider: 'openai', model: 'gpt-5.5', project_id: 'p_usage', cwd: '/tmp/usage-project',
  input_tokens: 7, output_tokens: 2, total_tokens: 9,
});
recordUsage({
  source_id: 'usage-other-external', source: 'codex-jsonl', ts: ts + 12002, external_session_id: 'uuid-someone-else',
  tool: 'codex', provider: 'openai', model: 'gpt-5.5', project_id: 'p_usage', cwd: '/tmp/usage-project',
  input_tokens: 99, output_tokens: 99, total_tokens: 198,
});
recordUsage({
  source_id: 'usage-ambiguous', source: 'proxy', ts: ts + 12003,
  tool: 'codex', provider: 'openai', model: 'gpt-5.5', project_id: 'p_usage', cwd: '/tmp/usage-project',
  input_tokens: 88, output_tokens: 88, total_tokens: 176,
});

const first = usageForSession('s_usage');
assert.equal(first.totals.events, 12001, 'internal and matching external identities are combined');
assert.equal(first.association.exact_events, 12001, 'the captured CLI UUID is authoritative attribution');
assert.equal(first.association.inferred_events, 0);
assert.equal(first.totals.total_tokens, 12000 * 13 + 9, 'concurrent and ambiguous same-project rows are never inferred when an identity is known');
assert.equal(first.byModel.length, 1);
assert.ok(first.recent.every((r) => !Object.hasOwn(r, 'raw')), 'recent rows omit raw payload blobs');
assert.strictEqual(usageForSession('s_usage'), first, 'repeat reads return the cached aggregate object');

const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT provider, tool, model, COUNT(*)
  FROM usage_events WHERE event_type='usage' AND session_id=? AND ts>=? AND ts<=?
  GROUP BY source, model, provider, tool`).all('s_usage', ts - 1, ts + 20000);
assert.ok(plan.some((r) => /idx_usage_events_session_ts/.test(r.detail)), 'SQLite selects the session/time composite index');

const externalPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT provider, tool, model, COUNT(*)
  FROM usage_events WHERE event_type='usage' AND external_session_id=? AND session_id IS NULL AND ts>=? AND ts<=?
  GROUP BY source, model, provider, tool`).all('uuid-usage', ts - 1, ts + 20000);
assert.ok(externalPlan.some((r) => /idx_usage_events_external_ts/.test(r.detail)), 'SQLite selects the external-session/time composite index');

// A legacy session without a captured CLI identity may still use strictly identity-free project inference.
createProject({ id: 'p_legacy_usage', name: 'Legacy Usage', path: '/tmp/legacy-usage-project' });
createSession({ id: 's_legacy_usage', project_id: 'p_legacy_usage', tool: 'codex', tmux: 'tmux-legacy-usage', status: 'working' });
recordUsage({ source_id: 'legacy-untagged', source: 'proxy', ts, tool: 'codex', project_id: 'p_legacy_usage', cwd: '/tmp/legacy-usage-project', total_tokens: 5 });
recordUsage({ source_id: 'legacy-other-uuid', source: 'codex-jsonl', ts, external_session_id: 'uuid-other', tool: 'codex', project_id: 'p_legacy_usage', cwd: '/tmp/legacy-usage-project', total_tokens: 500 });
const legacy = usageForSession('s_legacy_usage');
assert.equal(legacy.totals.events, 1, 'legacy inference accepts only rows without internal or external identity');
assert.equal(legacy.totals.total_tokens, 5);

// Capturing the CLI UUID after launch changes the association key and must bypass a cached heuristic view.
createProject({ id: 'p_late_usage', name: 'Late Usage', path: '/tmp/late-usage-project' });
createSession({ id: 's_late_usage', project_id: 'p_late_usage', tool: 'codex', tmux: 'tmux-late-usage', status: 'working' });
recordUsage({ source_id: 'late-ambiguous', source: 'proxy', ts, tool: 'codex', project_id: 'p_late_usage', cwd: '/tmp/late-usage-project', total_tokens: 5 });
assert.equal(usageForSession('s_late_usage').totals.total_tokens, 5);
updateSession('s_late_usage', { codex_uuid: 'uuid-late' });
recordUsage({ source_id: 'late-external', source: 'codex-jsonl', ts, external_session_id: 'uuid-late', tool: 'codex', project_id: 'p_late_usage', cwd: '/tmp/late-usage-project', total_tokens: 7 });
const rebound = usageForSession('s_late_usage');
assert.equal(rebound.totals.events, 1, 'capturing a UUID invalidates the cached heuristic association');
assert.equal(rebound.totals.total_tokens, 7);

// The interactive Usage screen gets one grouped projection, not the exhaustive analytics report.
const dashboard = usageDashboardReport({ since: ts - 1, until: ts + 20000, limit: 25 });
assert.equal(dashboard.totals.events, 12007, 'screen totals include every usage event in the selected window');
assert.equal(dashboard.totals.sessions, 8, 'distinct collector identities remain available without returning a giant session list');
assert.equal(dashboard.byModel[0].name, 'gpt-5.5');
assert(dashboard.byProject.some((row) => row.name === 'Usage'));
assert(dashboard.recent.length <= 25);
assert(dashboard.recent.every((row) => !Object.hasOwn(row, 'raw')), 'screen projection never reads raw payload blobs');
assert.equal(Object.hasOwn(dashboard, 'byTool'), false, 'unused exhaustive groupings stay off the interactive path');
assert.equal(Object.hasOwn(dashboard, 'options'), false, 'unused all-history filter scans stay off the interactive path');
const dashboardPlan = db.prepare(`EXPLAIN QUERY PLAN
  SELECT model, project, provider, tool, SUM(total_tokens)
  FROM usage_events
  WHERE event_type='usage' AND ts>=?
  GROUP BY model, project, provider, tool`).all(ts - 1);
assert(dashboardPlan.some((row) => /COVERING INDEX idx_usage_events_dashboard/.test(row.detail)),
  'interactive aggregates stay on the narrow covering index instead of reading raw table rows');

console.log('session_usage_query.test ok');
