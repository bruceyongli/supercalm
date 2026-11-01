import { getSession, db } from './store.js';
import { remoteSession, migrationError, EXECUTION_NODE } from './execution_identity.js';
import { executionNode, executionNodes, defaultExecutionNode, nodeRequest } from './execution_transport.js';

export function nodeForSession(sessionOrId) {
  const session = typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId;
  return remoteSession(session) ? executionNode(session.execution_node) : null;
}
export function executionRequest(sessionOrId, suffix, options) {
  const session = typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId;
  const node = nodeForSession(session);
  if (!node) throw migrationError('The session is not owned by a remote device');
  return nodeRequest(node, `/api/session/${encodeURIComponent(session.id)}${suffix}`, options);
}
export function assertExecutionAvailable(sid) {
  if (!sid) return;
  const operation = db.prepare("SELECT id FROM execution_operations WHERE session_id=? AND phase NOT IN ('complete','failed','cancelled') LIMIT 1").get(sid);
  if (operation) throw migrationError('This session is moving to another device. Its input and files are preserved.', 'execution-migration-in-progress');
}
export function executionDeviceList() {
  return [{ id: EXECUTION_NODE, label: process.env.AIOS_EXECUTION_LABEL || 'Controller', online: true, local: true, launchable: !defaultExecutionNode(), default: !defaultExecutionNode() },
    ...executionNodes().map(node => {
      const state = db.prepare('SELECT * FROM execution_sync WHERE node=?').get(node.id);
      let health = null;
      try { health = JSON.parse(state?.health || 'null'); } catch {}
      return { id: node.id, label: node.label, online: !!state?.online && Date.now() - state.checked_at < 20000,
        default: !!node.default, localSSD: true,
        checked_at: state?.checked_at || null, error: state?.error || null, health };
    })];
}
