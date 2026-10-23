// Shared by desktop, phone/PWA, session header and browser identity. The CLI can remain alive while
// its provider is blocked; don't project that as a dead session or a question waiting for an answer.
import { providerIssueInfo } from './provider-issue.js';
export function sessionIndicator(session = {}) {
  const issue = session.provider_issue;
  const info = providerIssueInfo(issue);
  if (['working', 'waiting'].includes(session.status) && info) {
    if (issue.phase === 'blocked') return { state: 'error', label: info.title,
      detail: `Blocked: ${info.title[0].toLowerCase()}${info.title.slice(1)}. ${info.advice}`, dot: 'error', color: '#f85149', blocked: true };
    if (issue.phase === 'retrying') return { state: 'retrying', label: 'Retrying',
      detail: info.message, dot: 'warn pulse', color: '#d29922', blocked: false };
  }
  const state = session.status || 'starting';
  const label = { working: 'Working', waiting: 'Waiting', starting: 'Starting', exited: 'Stopped', error: 'Failed' }[state] || state;
  return { state, label, detail: state === 'waiting' ? 'Waiting for your reply or review' : label,
    dot: state === 'working' ? 'ok pulse' : state === 'waiting' ? 'warn' : state === 'error' ? 'error' : '',
    color: { working: '#3fb950', waiting: '#d29922', starting: '#58a6ff', error: '#f85149' }[state] || '#8b949e', blocked: false };
}

// Counters and their destinations must select exactly the same sessions. These are runtime filters,
// not the attention inbox: age, unread state and report dismissal never hide a counted session.
export function sessionsByStatus(sessions, status) {
  return (sessions || []).filter(session => {
    if (status === 'blocked') return sessionIndicator(session).blocked;
    return ['waiting', 'working'].includes(status) && session.status === status && !sessionIndicator(session).blocked;
  });
}
