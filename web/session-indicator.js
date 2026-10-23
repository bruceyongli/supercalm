// Shared by desktop, phone/PWA, session header and browser identity. The CLI can remain alive while
// its provider is blocked; don't project that as a dead session or a question waiting for an answer.
export function sessionIndicator(session = {}) {
  const issue = session.provider_issue;
  if (['working', 'waiting'].includes(session.status) && issue?.code === 'capacity') {
    if (issue.phase === 'blocked') return { state: 'error', label: 'Model at capacity',
      detail: 'Blocked: model at capacity. Retry later or choose another model.', dot: 'error', color: '#f85149', blocked: true };
    if (issue.phase === 'retrying') return { state: 'retrying', label: 'Retrying',
      detail: 'Model at capacity — the CLI is retrying.', dot: 'warn pulse', color: '#d29922', blocked: false };
  }
  const state = session.status || 'starting';
  const label = { working: 'Working', waiting: 'Waiting', starting: 'Starting', exited: 'Stopped', error: 'Failed' }[state] || state;
  return { state, label, detail: state === 'waiting' ? 'Waiting for your reply or review' : label,
    dot: state === 'working' ? 'ok pulse' : state === 'waiting' ? 'warn' : state === 'error' ? 'error' : '',
    color: { working: '#3fb950', waiting: '#d29922', starting: '#58a6ff', error: '#f85149' }[state] || '#8b949e', blocked: false };
}
