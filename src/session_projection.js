import { TOOLS } from './config.js';
import { modelDisplayLabel, modelSupportsFast } from './model_catalog.js';

// Canonical public session shape. API detail responses, state snapshots, and lifecycle events all derive
// labels/capabilities here so a field cannot silently drift between three independent decorators.
export function projectSession(session, { project = null } = {}) {
  if (!session) return null;
  const tool = TOOLS[session.tool];
  const model = session.model || tool?.model;
  const fastCapable = session.tool === 'codex' && modelSupportsFast(model);
  return {
    ...session,
    revision: Math.max(1, Number(session.revision) || 1),
    fastMode: fastCapable && !!session.fast_mode,
    fastCapable,
    project,
    toolLabel: tool?.label || session.tool,
    toolColor: tool?.color || '#8b949e',
    modelLabel: (tool?.models || []).find((item) => item.id === session.model)?.label
      || modelDisplayLabel(session.model)
      || tool?.modelLabel
      || null,
  };
}

export function sessionStatusPayload(session, {
  previousStatus = null,
  source = 'status',
  extra = {},
  ts = Date.now(),
} = {}) {
  const row = projectSession(session, { project: session.project || null });
  return {
    session: row.id,
    revision: row.revision,
    status: row.status,
    previousStatus,
    question: row.question || null,
    summary: row.summary || null,
    category: row.category || null,
    stage: row.stage || null,
    title: row.title || null,
    tool: row.tool,
    toolLabel: row.toolLabel,
    toolColor: row.toolColor,
    model: row.model || null,
    modelLabel: row.modelLabel,
    last_activity: row.last_activity,
    started_at: row.started_at,
    ended_at: row.ended_at || null,
    exit_code: row.exit_code ?? null,
    parked: !!row.parked,
    degraded: !!row.degraded,
    project: row.project ? { id: row.project.id, name: row.project.name } : null,
    source,
    ts,
    ...extra,
  };
}
