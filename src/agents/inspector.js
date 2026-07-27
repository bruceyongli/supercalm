// Evidence inspector — a view-only agent-dock surface. The focused read/teach/retry endpoints live in
// inspector_api.js because they are explicit operator actions, not autonomous background-agent ticks.
export const meta = {
  id: 'inspector',
  name: 'Evidence',
  version: '1.0.0',
  description: 'Optional, on-demand exception review. It has no background work and can be unpinned without affecting sessions or saved project rules.',
  kind: 'tool',
  scope: 'session',
  capabilities: ['read-context'],
  ui: { tab: 'Evidence', order: 5 },
  // Story/Needs-you links can still open the panel on demand. Enabling it only pins it in the dock.
  defaultEnabled: false,
  appliesTo: () => 1,
};
