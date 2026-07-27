// Evidence inspector — a view-only agent-dock surface. The focused read/teach/retry endpoints live in
// inspector_api.js because they are explicit operator actions, not autonomous background-agent ticks.
export const meta = {
  id: 'inspector',
  name: 'Evidence',
  version: '1.0.0',
  description: 'Inspect the focused exception, see which project rules were in context, teach a durable correction, and retry.',
  kind: 'tool',
  scope: 'session',
  capabilities: ['read-context'],
  ui: { tab: 'Evidence', order: 5 },
  defaultEnabled: true,
  appliesTo: () => 1,
};
