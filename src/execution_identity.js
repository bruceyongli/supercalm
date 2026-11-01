// Execution ownership is independent of storage location and of process liveness.
// A disconnected worker must NEVER cause this host to recover its conversations locally.
export const EXECUTION_NODE = process.env.AIOS_EXECUTION_NODE || 'local';
export function remoteSession(session) {
  return !!session?.execution_node && session.execution_node !== EXECUTION_NODE;
}
export function migrationError(message, code = 'execution-migration', status = 409) {
  return Object.assign(new Error(message), { code, status });
}
export function executionId(value) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(String(value || '')) || value === 'local') {
    throw migrationError('Invalid execution device ID', 'execution-device-invalid', 400);
  }
  return value;
}
