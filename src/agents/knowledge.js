// "Project Knowledge" agent — the registry manifest so a Knowledge tab appears in the side panel. The
// panel (web/agents/knowledge.js) drives the existing REST routes (/api/project/:id/context[/generate],
// /api/project/:id/wiki[/rebuild], /api/project/:id/helpers); this module is meta-only (like the Map
// agent). Always-on tab (defaultEnabled); the actual per-project enables live in project_helpers and are
// toggled inside the panel. Covers #2 (CONTEXT.md, injected into launches) + #4 (wiki, served via MCP).
export const meta = {
  id: 'knowledge',
  name: 'Knowledge',
  version: '1.0.0',
  description: 'Per-project knowledge: a shared CONTEXT.md (vocabulary, injected into launches) and a self-maintaining wiki served to agents over MCP.',
  kind: 'agent',
  scope: 'session',
  capabilities: ['read-context'],
  ui: { tab: 'Knowledge', order: 30 },
  defaultEnabled: true,
  appliesTo: (session) => (session?.project_id ? 0.6 : 0),
};
