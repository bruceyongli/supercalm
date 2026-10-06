const locks = new Set();
export function sessionIsCleaning(id) { return locks.has(id); }
export function assertSessionNotCleaning(id) {
  if (!locks.has(id)) return;
  const error = new Error('This session is being cleaned. Wait for cleanup to finish.');
  error.code = 'session-cleanup-in-progress';
  error.status = 409;
  throw error;
}
export async function withSessionCleanup(id, operation) {
  assertSessionNotCleaning(id);
  locks.add(id);
  try { return await operation(); } finally { locks.delete(id); }
}
