// Map — a passive view agent. No backend logic: the panel renders from the existing
// GET /api/session/:id/map endpoint. Registered here only so it appears in the agent registry /
// tab bar and illustrates the read-only end of the capability spectrum.
export const meta = {
  id: 'map',
  name: 'Graph',
  version: '2.0.0',
  description: 'Auto-built session graph: requests → subtasks → tool calls, sized by cost/time (3D or 2D).',
  kind: 'view',
  scope: 'session',
  capabilities: ['read-context'],
  ui: { tab: 'Graph', order: 10 },
  defaultEnabled: true,
  appliesTo: () => 1,
};
