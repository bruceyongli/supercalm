import { db, getProject, getSession } from './store.js';
import { now } from './util.js';
import { mergeCost, priceUsage, pricingCatalog } from './usage_pricing.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id                   TEXT NOT NULL UNIQUE,
    source                      TEXT NOT NULL,
    event_type                  TEXT NOT NULL DEFAULT 'usage',
    ts                          INTEGER NOT NULL,
    session_id                  TEXT,
    external_session_id         TEXT,
    request_id                  TEXT,
    tool                        TEXT,
    provider                    TEXT,
    model                       TEXT,
    project_id                  TEXT,
    project                     TEXT,
    cwd                         TEXT,
    input_tokens                INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens               INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens            INTEGER NOT NULL DEFAULT 0,
    total_tokens                INTEGER NOT NULL DEFAULT 0,
    message                     TEXT,
    raw                         TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_cursors (
    source_id  TEXT PRIMARY KEY,
    path       TEXT,
    offset     INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    meta       TEXT
  );

  CREATE TABLE IF NOT EXISTS session_usage_limits (
    session_id           TEXT PRIMARY KEY,
    enabled              INTEGER NOT NULL DEFAULT 1,
    token_limit_total    INTEGER,
    cost_limit_usd       REAL,
    weekly_limit_percent REAL,
    triggered_at         INTEGER,
    triggered_reason     TEXT,
    updated_at           INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_events_ts       ON usage_events(ts);
  CREATE INDEX IF NOT EXISTS idx_usage_events_tool     ON usage_events(tool, ts);
  CREATE INDEX IF NOT EXISTS idx_usage_events_source   ON usage_events(source, ts);
  CREATE INDEX IF NOT EXISTS idx_usage_events_project  ON usage_events(project_id, ts);
  CREATE INDEX IF NOT EXISTS idx_usage_events_model    ON usage_events(model, ts);
  CREATE INDEX IF NOT EXISTS idx_usage_events_type     ON usage_events(event_type, ts);
`);

const _insertUsage = db.prepare(`
  INSERT INTO usage_events (
    source_id, source, event_type, ts, session_id, external_session_id, request_id,
    tool, provider, model, project_id, project, cwd,
    input_tokens, cached_input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
    output_tokens, reasoning_tokens, total_tokens, message, raw
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(source_id) DO UPDATE SET
    source=excluded.source,
    event_type=excluded.event_type,
    ts=MAX(usage_events.ts, excluded.ts),
    session_id=COALESCE(excluded.session_id, usage_events.session_id),
    external_session_id=COALESCE(excluded.external_session_id, usage_events.external_session_id),
    request_id=COALESCE(excluded.request_id, usage_events.request_id),
    tool=COALESCE(excluded.tool, usage_events.tool),
    provider=COALESCE(excluded.provider, usage_events.provider),
    model=COALESCE(excluded.model, usage_events.model),
    project_id=COALESCE(excluded.project_id, usage_events.project_id),
    project=COALESCE(excluded.project, usage_events.project),
    cwd=COALESCE(excluded.cwd, usage_events.cwd),
    input_tokens=CASE WHEN excluded.ts >= usage_events.ts THEN excluded.input_tokens ELSE usage_events.input_tokens END,
    cached_input_tokens=CASE WHEN excluded.ts >= usage_events.ts THEN excluded.cached_input_tokens ELSE usage_events.cached_input_tokens END,
    cache_creation_input_tokens=CASE WHEN excluded.ts >= usage_events.ts THEN excluded.cache_creation_input_tokens ELSE usage_events.cache_creation_input_tokens END,
    cache_read_input_tokens=CASE WHEN excluded.ts >= usage_events.ts THEN excluded.cache_read_input_tokens ELSE usage_events.cache_read_input_tokens END,
    output_tokens=CASE WHEN excluded.ts >= usage_events.ts THEN excluded.output_tokens ELSE usage_events.output_tokens END,
    reasoning_tokens=CASE WHEN excluded.ts >= usage_events.ts THEN excluded.reasoning_tokens ELSE usage_events.reasoning_tokens END,
    total_tokens=CASE WHEN excluded.ts >= usage_events.ts THEN excluded.total_tokens ELSE usage_events.total_tokens END,
    message=CASE WHEN excluded.ts >= usage_events.ts THEN COALESCE(excluded.message, usage_events.message) ELSE usage_events.message END,
    raw=CASE WHEN excluded.ts >= usage_events.ts THEN COALESCE(excluded.raw, usage_events.raw) ELSE usage_events.raw END
`);
const _cursor = db.prepare('SELECT * FROM usage_cursors WHERE source_id = ?');
const _upsertCursor = db.prepare(`
  INSERT INTO usage_cursors (source_id,path,offset,updated_at,meta) VALUES (?,?,?,?,?)
  ON CONFLICT(source_id) DO UPDATE SET
    path=excluded.path, offset=excluded.offset, updated_at=excluded.updated_at, meta=excluded.meta
`);
const _delCursors = db.prepare('DELETE FROM usage_cursors WHERE source_id LIKE ?');
const _getSessionLimit = db.prepare('SELECT * FROM session_usage_limits WHERE session_id = ?');
const _upsertSessionLimit = db.prepare(`
  INSERT INTO session_usage_limits (
    session_id, enabled, token_limit_total, cost_limit_usd, weekly_limit_percent,
    triggered_at, triggered_reason, updated_at
  ) VALUES (?,?,?,?,?,NULL,NULL,?)
  ON CONFLICT(session_id) DO UPDATE SET
    enabled=excluded.enabled,
    token_limit_total=excluded.token_limit_total,
    cost_limit_usd=excluded.cost_limit_usd,
    weekly_limit_percent=excluded.weekly_limit_percent,
    triggered_at=NULL,
    triggered_reason=NULL,
    updated_at=excluded.updated_at
`);
const _clearSessionLimit = db.prepare('DELETE FROM session_usage_limits WHERE session_id = ?');
const _triggerSessionLimit = db.prepare(`
  UPDATE session_usage_limits
  SET triggered_at = COALESCE(triggered_at, ?), triggered_reason = COALESCE(triggered_reason, ?), updated_at = ?
  WHERE session_id = ?
`);

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
}

function positiveNumber(v, max = Infinity) {
  if (v == null || v === '') return null;
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return null;
  return Math.min(x, max);
}

function positiveInt(v) {
  const x = positiveNumber(v);
  return x == null ? null : Math.round(x);
}

export function recordUsage(e) {
  const input = n(e.input_tokens);
  const cacheCreation = n(e.cache_creation_input_tokens);
  const cacheRead = n(e.cache_read_input_tokens);
  const cached = n(e.cached_input_tokens) || cacheCreation + cacheRead;
  const output = n(e.output_tokens);
  const reasoning = n(e.reasoning_tokens);
  const total = n(e.total_tokens) || input + output;
  const raw = e.raw == null ? null : typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw);
  const r = _insertUsage.run(
    String(e.source_id),
    String(e.source || 'unknown'),
    String(e.event_type || 'usage'),
    n(e.ts) || now(),
    e.session_id || null,
    e.external_session_id || null,
    e.request_id || null,
    e.tool || null,
    e.provider || null,
    e.model || null,
    e.project_id || null,
    e.project || null,
    e.cwd || null,
    input,
    cached,
    cacheCreation,
    cacheRead,
    output,
    reasoning,
    total,
    e.message || null,
    raw
  );
  return r.changes > 0;
}

export function recordLimitEvent(e) {
  return recordUsage({ ...e, event_type: e.event_type || 'limit' });
}

export function getCursor(source_id) {
  return _cursor.get(source_id);
}

export function setCursor(source_id, path, offset, meta = null) {
  _upsertCursor.run(source_id, path || null, n(offset), now(), meta == null ? null : JSON.stringify(meta));
}

export function deleteCursors(prefix) {
  _delCursors.run(String(prefix) + '%');
}

const EMPTY_LIMIT = Object.freeze({
  enabled: false,
  token_limit_total: null,
  cost_limit_usd: null,
  weekly_limit_percent: null,
  triggered_at: null,
  triggered_reason: null,
  updated_at: null,
});

function normalizeLimit(row) {
  if (!row) return { ...EMPTY_LIMIT };
  return {
    session_id: row.session_id,
    enabled: !!row.enabled,
    token_limit_total: row.token_limit_total == null ? null : Number(row.token_limit_total),
    cost_limit_usd: row.cost_limit_usd == null ? null : Number(row.cost_limit_usd),
    weekly_limit_percent: row.weekly_limit_percent == null ? null : Number(row.weekly_limit_percent),
    triggered_at: row.triggered_at == null ? null : Number(row.triggered_at),
    triggered_reason: row.triggered_reason || null,
    updated_at: row.updated_at == null ? null : Number(row.updated_at),
  };
}

export function getSessionLimit(session_id) {
  return normalizeLimit(_getSessionLimit.get(session_id));
}

export function setSessionLimit(session_id, patch = {}) {
  const tokenLimit = positiveInt(patch.token_limit_total ?? patch.tokenLimitTotal);
  const costLimit = positiveNumber(patch.cost_limit_usd ?? patch.costLimitUsd);
  const weeklyLimit = positiveNumber(patch.weekly_limit_percent ?? patch.weeklyLimitPercent, 100);
  const hasLimit = tokenLimit != null || costLimit != null || weeklyLimit != null;
  const enabled = patch.enabled == null ? hasLimit : !!patch.enabled;
  _upsertSessionLimit.run(session_id, enabled ? 1 : 0, tokenLimit, costLimit, weeklyLimit, now());
  return getSessionLimit(session_id);
}

export function clearSessionLimit(session_id) {
  _clearSessionLimit.run(session_id);
  return getSessionLimit(session_id);
}

export function markSessionLimitTriggered(session_id, reason) {
  _triggerSessionLimit.run(now(), String(reason || 'usage limit reached').slice(0, 500), now(), session_id);
  return getSessionLimit(session_id);
}

function filtersWhere(f = {}, { usageOnly = true } = {}) {
  const where = [];
  const args = [];
  if (usageOnly) where.push("event_type = 'usage'");
  const eq = (sql, v) => { if (v) { where.push(sql); args.push(v); } };
  eq('project_id = ?', f.project);
  eq('session_id = ?', f.session);
  eq('tool = ?', f.tool);
  eq('model = ?', f.model);
  eq('source = ?', f.source);
  eq('event_type = ?', f.event_type);
  if (Number(f.since) > 0) { where.push('ts >= ?'); args.push(Number(f.since)); }
  if (Number(f.until) > 0) { where.push('ts <= ?'); args.push(Number(f.until)); }
  const q = String(f.q || '').trim();
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push("(project LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  return { W: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

const TOTAL_SQL = `
  COUNT(*) events,
  COALESCE(SUM(input_tokens),0) input_tokens,
  COALESCE(SUM(cached_input_tokens),0) cached_input_tokens,
  COALESCE(SUM(cache_creation_input_tokens),0) cache_creation_input_tokens,
  COALESCE(SUM(cache_read_input_tokens),0) cache_read_input_tokens,
  COALESCE(SUM(output_tokens),0) output_tokens,
  COALESCE(SUM(reasoning_tokens),0) reasoning_tokens,
  COALESCE(SUM(total_tokens),0) total_tokens
`;

export function usageReport(filters = {}) {
  const { W, args } = filtersWhere(filters);
  const totals = withCost(db.prepare(`SELECT ${TOTAL_SQL} FROM usage_events ${W}`).get(...args), costTotals(filters));
  const grouped = (field, limit = 20) =>
    withGroupCosts(db.prepare(`
      SELECT COALESCE(${field}, '(unknown)') name, ${TOTAL_SQL}
      FROM usage_events ${W}
      GROUP BY COALESCE(${field}, '(unknown)')
      ORDER BY (COALESCE(SUM(total_tokens),0) + COALESCE(SUM(cached_input_tokens),0)) DESC
      LIMIT ?
    `).all(...args, limit), filters, field);
  const recentWhere = filtersWhere(filters, { usageOnly: false });
  const recent = db.prepare(`
    SELECT *
    FROM usage_events ${recentWhere.W}
    ${recentWhere.W ? 'AND' : 'WHERE'} (event_type != 'usage' OR total_tokens > 0 OR input_tokens > 0 OR cached_input_tokens > 0 OR output_tokens > 0)
    ORDER BY ts DESC
    LIMIT ?
  `).all(...recentWhere.args, Math.min(300, Math.max(1, Number(filters.limit) || 80))).map(enrichEventCost);
  const summaryWhere = filtersWhere({ ...filters, event_type: 'summary' }, { usageOnly: false });
  const summaries = db.prepare(`
    SELECT *
    FROM usage_events ${summaryWhere.W}
    ORDER BY ts DESC
    LIMIT 50
  `).all(...summaryWhere.args).map(enrichEventCost);
  return {
    totals,
    byTool: grouped('tool'),
    bySource: grouped('source'),
    byModel: grouped('model'),
    byProject: grouped('project'),
    bySession: usageSessions(filters),
    quotaImpact: quotaImpactReport(filters),
    recent,
    summaries,
    pricing: pricingCatalog(),
  };
}

function parseRaw(row) {
  if (!row?.raw) return null;
  try {
    return JSON.parse(row.raw);
  } catch {
    return null;
  }
}

export function latestAgyStatusline(session_id = null) {
  const row = session_id
    ? db.prepare(`
        SELECT *
        FROM usage_events
        WHERE source = 'antigravity-statusline' AND event_type = 'snapshot' AND session_id = ?
        ORDER BY ts DESC
        LIMIT 1
      `).get(session_id)
    : db.prepare(`
        SELECT *
        FROM usage_events
        WHERE source = 'antigravity-statusline' AND event_type = 'snapshot'
        ORDER BY ts DESC
        LIMIT 1
      `).get();
  if (!row) return null;
  return { ...row, raw_json: parseRaw(row) };
}

function impactWhere(filters = {}) {
  const base = filtersWhere(filters, { usageOnly: false });
  return {
    W: `${base.W || 'WHERE 1=1'} AND event_type IN ('agent-call', 'limit')`,
    args: base.args,
  };
}

const IMPACT_SQL = `
  COUNT(*) events,
  COALESCE(SUM(CASE WHEN event_type = 'agent-call' THEN 1 ELSE 0 END),0) agent_calls,
  COALESCE(SUM(CASE WHEN event_type = 'limit' THEN 1 ELSE 0 END),0) limit_events,
  MAX(ts) last_ts
`;

function quotaImpactReport(filters = {}) {
  const { W, args } = impactWhere(filters);
  const totals = db.prepare(`SELECT ${IMPACT_SQL} FROM usage_events ${W}`).get(...args);
  const grouped = (field, limit = 20) => {
    const rows = db.prepare(`
      SELECT COALESCE(${field}, '(unknown)') name, ${IMPACT_SQL},
        NULL last_limit
      FROM usage_events ${W}
      GROUP BY COALESCE(${field}, '(unknown)')
      ORDER BY agent_calls DESC, limit_events DESC, last_ts DESC
      LIMIT ?
    `).all(...args, limit);
    const lastLimit = db.prepare(`
      SELECT message
      FROM usage_events ${W} AND event_type = 'limit' AND COALESCE(${field}, '(unknown)') = ?
      ORDER BY ts DESC
      LIMIT 1
    `);
    return rows.map((r) => ({ ...r, last_limit: lastLimit.get(...args, r.name)?.message || null }));
  };
  return {
    totals: {
      events: Number(totals?.events || 0),
      agent_calls: Number(totals?.agent_calls || 0),
      limit_events: Number(totals?.limit_events || 0),
      last_ts: Number(totals?.last_ts || 0),
    },
    byModel: grouped('model'),
    byProject: grouped('project'),
    bySession: grouped('session_id'),
    bySource: grouped('source'),
  };
}

function withCost(row, c) {
  const total = Number(row?.total_tokens || 0);
  const cached = Number(row?.cached_input_tokens || 0);
  return {
    ...row,
    token_traffic_tokens: total + cached,
    estimated_cost_usd: Number(c.estimated_cost_usd || 0),
    priced_events: Number(c.priced_events || 0),
    unpriced_events: Number(c.unpriced_events || 0),
    unpriced_tokens: Number(c.unpriced_tokens || 0),
  };
}

function enrichEventCost(row) {
  return withCost(row, priceUsage(row));
}

function costParts(filters, field = null) {
  const { W, args } = filtersWhere(filters);
  return costPartsWhere(W, args, field);
}

function costPartsWhere(W, args, field = null) {
  const nameExpr = field ? `COALESCE(${field}, '(unknown)') name,` : '';
  return db.prepare(`
    SELECT ${nameExpr}
      provider, tool, model,
      ${TOTAL_SQL}
    FROM usage_events ${W}
    GROUP BY ${field ? `COALESCE(${field}, '(unknown)'),` : ''} provider, tool, model
  `).all(...args);
}

function costTotals(filters) {
  const { W, args } = filtersWhere(filters);
  return costTotalsWhere(W, args);
}

function costTotalsWhere(W, args) {
  let out = {};
  for (const r of costPartsWhere(W, args)) out = mergeCost(out, priceUsage(r));
  return out;
}

function withGroupCosts(rows, filters, field) {
  const { W, args } = filtersWhere(filters);
  return withGroupCostsWhere(rows, W, args, field);
}

function withGroupCostsWhere(rows, W, args, field) {
  const costs = new Map();
  for (const r of costPartsWhere(W, args, field)) {
    costs.set(r.name, mergeCost(costs.get(r.name), priceUsage(r)));
  }
  return rows.map((r) => withCost(r, costs.get(r.name)));
}

function sessionUsageWhere(sessionOrId) {
  const s = typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId;
  if (!s) return null;
  const project = s.project_id ? getProject(s.project_id) : null;
  const since = Math.max(0, Number(s.started_at || 0) - 60_000);
  const until = Number(s.ended_at || 0) || now();
  const where = ["event_type = 'usage'", 'ts >= ?', 'ts <= ?'];
  const args = [since, until + 60_000];
  const match = ['session_id = ?'];
  const matchArgs = [s.id];
  if (s.tool && project?.id) {
    match.push('(tool = ? AND project_id = ?)');
    matchArgs.push(s.tool, project.id);
  }
  if (s.tool && project?.path) {
    match.push("(tool = ? AND (cwd = ? OR cwd LIKE ? ESCAPE '\\'))");
    matchArgs.push(s.tool, project.path, project.path.replace(/[\\%_]/g, (c) => '\\' + c) + '/%');
  }
  where.push('(' + match.join(' OR ') + ')');
  return {
    session: s,
    project,
    since,
    until,
    W: 'WHERE ' + where.join(' AND '),
    args: [...args, ...matchArgs],
  };
}

export function usageForSession(sessionOrId) {
  const ctx = sessionUsageWhere(sessionOrId);
  if (!ctx) return null;
  const { session: s, project, since, until, W, args } = ctx;
  const totals = withCost(db.prepare(`SELECT ${TOTAL_SQL} FROM usage_events ${W}`).get(...args), costTotalsWhere(W, args));
  const grouped = (field, limit = 12) =>
    withGroupCostsWhere(db.prepare(`
      SELECT COALESCE(${field}, '(unknown)') name, ${TOTAL_SQL}
      FROM usage_events ${W}
      GROUP BY COALESCE(${field}, '(unknown)')
      ORDER BY (COALESCE(SUM(total_tokens),0) + COALESCE(SUM(cached_input_tokens),0)) DESC
      LIMIT ?
    `).all(...args, limit), W, args, field);
  const recent = db.prepare(`
    SELECT *
    FROM usage_events ${W}
    ORDER BY ts DESC
    LIMIT 40
  `).all(...args).map(enrichEventCost);
  const statusline = s.tool === 'agy' ? latestAgyStatusline(s.id) : null;
  const exactEvents = Number(db.prepare(`
    SELECT COUNT(*) events
    FROM usage_events
    WHERE event_type = 'usage' AND session_id = ?
  `).get(s.id)?.events || 0);

  return {
    session_id: s.id,
    tool: s.tool,
    model: s.model,
    project: project ? { id: project.id, name: project.name, path: project.path } : null,
    window: { since, until, open: !s.ended_at },
    association: {
      exact_events: exactEvents,
      inferred_events: Math.max(0, Number(totals.events || 0) - exactEvents),
      note: exactEvents
        ? 'Includes events explicitly tagged with this Supercalm session plus matching project/tool CLI logs.'
        : 'Matched from CLI logs by same project, same tool, and this session time window.',
    },
    totals,
    byModel: grouped('model'),
    bySource: grouped('source'),
    statusline,
    recent,
  };
}

function usageSessions(filters = {}) {
  const { W, args } = filtersWhere(filters);
  const rows = db.prepare(`
    SELECT
      COALESCE(external_session_id, session_id, request_id, source_id) id,
      MAX(ts) ts,
      COALESCE(MAX(project), '(unknown)') project,
      COALESCE(MAX(tool), '(unknown)') tool,
      COALESCE(MAX(model), '(unknown)') model,
      ${TOTAL_SQL}
    FROM usage_events ${W}
    GROUP BY COALESCE(external_session_id, session_id, request_id, source_id), COALESCE(model, '(unknown)')
    ORDER BY (COALESCE(SUM(total_tokens),0) + COALESCE(SUM(cached_input_tokens),0)) DESC
    LIMIT 40
  `).all(...args);
  return rows.map((r) => withCost(r, priceUsage(r)));
}

export function usageOptions() {
  const one = (field) =>
    db.prepare(`SELECT DISTINCT ${field} value FROM usage_events WHERE ${field} IS NOT NULL AND ${field} != '' ORDER BY ${field}`).all();
  return {
    tools: one('tool'),
    sources: one('source'),
    models: one('model'),
    projects: db.prepare(`
      SELECT DISTINCT project_id value, project label
      FROM usage_events
      WHERE project_id IS NOT NULL AND project IS NOT NULL
      ORDER BY project
    `).all(),
  };
}
