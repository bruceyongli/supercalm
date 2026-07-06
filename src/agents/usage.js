// Usage — a passive view agent. No backend logic: the panel renders from the existing usage
// endpoints (which now also include per-agent model spend recorded via ctx.callModel). Registered
// here so it appears in the agent registry / tab bar.
export const meta = {
  id: 'usage',
  name: 'Usage',
  version: '1.0.0',
  description: 'Token usage, cost, and limits for this session — including per-agent model spend.',
  kind: 'view',
  scope: 'session',
  capabilities: ['read-context'],
  ui: { tab: 'Usage', order: 30 },
  defaultEnabled: true,
  appliesTo: () => 1,
};
