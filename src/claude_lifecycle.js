// Claude's foreground turn, background work and operator attention are distinct lifecycles.
// Pure adapter: no database, process probes, transcript reads or model calls on the poll loop.
import { stripAnsi } from './util.js';

const states = new Map();
const text = (value, max = 1000) => typeof value === 'string' ? value.slice(0, max) : '';
const activeTask = task => !/^(?:completed|failed|killed|stopped|cancelled|canceled)$/i.test(task.status || '');

export function normalizeClaudeHook(input = {}) {
  const b = {
    event: text(input.event || input.hook_event_name || input.type, 80),
    native_session_id: text(input.native_session_id || input.session_id, 128),
    notification_type: text(input.notification_type, 80),
    agent_id: text(input.agent_id, 128),
    message: text(input.message || input.question, 8000),
    last_assistant_message: text(input.last_assistant_message, 8000),
    error: text(input.error, 80),
    error_details: text(input.error_details, 2000),
    sent_at: Number(input.sent_at) || Date.now(),
  };
  if (Array.isArray(input.background_tasks)) b.background_tasks = input.background_tasks.slice(0, 64)
    .filter(task => task && typeof task === 'object').map(task => ({
      id: text(task.id, 128), type: text(task.type, 80), status: text(task.status, 80),
      description: text(task.description), command: text(task.command),
    }));
  if (Array.isArray(input.session_crons)) b.session_crons = input.session_crons.slice(0, 64)
    .filter(cron => cron && typeof cron === 'object').map(cron => ({ id: text(cron.id, 128), recurring: cron.recurring !== false }));
  return b;
}

// Only recognizable standalone service commands qualify. An `until ...; do sleep ...; done` wait,
// a build, acceptance run, agent, workflow or Monitor is real work, however quiet it becomes.
export function isClaudeServiceTask(task) {
  if (task.type !== 'shell') return false;
  const command = String(task.command || '').trim();
  if (/[;&]|\|\||\b(?:until|while|for)\b/.test(command)) return false;
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|(?:python[\d.]*)\s+-m\s+http\.server\b|tail\s+(?:-[\w]*[fF]\b|--follow\b)|watch\s|(?:node\s+\S*\bserver\.[cm]?js\b))/i.test(command);
}

export function claudeBackgroundWork(state) {
  const tasks = (state?.background_tasks || []).filter(activeTask);
  const work = tasks.filter(task => !isClaudeServiceTask(task));
  const wakeups = (state?.session_crons || []).filter(cron => cron.recurring === false);
  return { count: tasks.length, work: work.length, servicesOnly: tasks.length > 0 && !work.length, wakeups: wakeups.length };
}

export function getClaudeLifecycle(id) { return states.get(id) || null; }
export function clearClaudeLifecycle(id) { states.delete(id); }
export function clearClaudeAttention(id) {
  const state = states.get(id);
  if (state) { state.attention = false; state.failure = ''; }
}

// Mid-turn HUMAN input is now an attachment, not necessarily another user-role message. Never use
// the rendered system-reminder prose as attribution: background notifications use the same wrapper.
export function claudeQueuedUser(record) {
  const a = record?.attachment;
  if (record?.isSidechain || a?.type !== 'queued_command' || a.origin?.kind !== 'human'
      || !(a.humanTurn === true || a.commandMode === 'prompt') || typeof a.prompt !== 'string') return null;
  return { text: a.prompt, id: a.source_uuid || a.delivery_id || record.uuid,
    timestamp: a.timestamp || record.timestamp };
}

export function claudeSystemInput(record) {
  return record?.promptSource === 'system' || record?.turnOrigin === 'task_notification'
    || /^(?:task-notification|system)$/.test(record?.origin?.kind || '');
}

// Keep the latest task snapshot through notifications. A later empty Stop snapshot retires it.
// Restores use the recorded send time, not boot time, so an old completion never gets a fresh TTL.
export function rememberClaudeHook(id, input) {
  const b = normalizeClaudeHook(input);
  const previous = states.get(id);
  if (previous && b.sent_at < previous.sent_at) return { ignored: true, state: previous };
  const same = !b.native_session_id || !previous?.native_session_id || b.native_session_id === previous.native_session_id;
  const state = { ...(same ? previous : {}), ...b,
    background_tasks: b.background_tasks ?? (same ? previous?.background_tasks : undefined),
    session_crons: b.session_crons ?? (same ? previous?.session_crons : undefined),
  };
  if (b.event === 'SessionEnd') { states.delete(id); return { state, status: null }; }
  states.set(id, state);
  if (states.size > 1024) states.delete(states.keys().next().value);
  const emit = (status, question = null, extra = {}) => {
    state.attention = !!extra.attention;
    state.failure = b.event === 'StopFailure' ? b.error : '';
    return { state, status, question, ...extra };
  };
  const bg = claudeBackgroundWork(state);
  const pending = bg.work > 0 || bg.wakeups > 0;
  switch (b.event) {
    case 'SessionStart': case 'UserPromptSubmit': case 'PreCompact': case 'PostCompact':
      return emit('working');
    case 'Stop':
      return emit(pending ? 'working' : 'waiting', pending ? null : b.last_assistant_message || null);
    case 'StopFailure':
      return emit('waiting', b.last_assistant_message || b.error_details || `Claude API error: ${b.error || 'unknown'}`, {
        authNeeded: /^(?:authentication_failed|cloud_credential_error)$/.test(b.error),
        degraded: /^(?:rate_limit|overloaded|server_error)$/.test(b.error) });
    case 'PermissionRequest': case 'Elicitation':
      return emit('waiting', b.message || null, { attention: true });
    case 'ElicitationResult':
      return emit('working');
    case 'Notification':
      if (/^(?:permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|quota_auto_resume_stale|quota_auto_resume_disabled)$/.test(b.notification_type)) {
        return emit('waiting', b.message || null, { attention: true });
      }
      if (b.notification_type === 'quota_auto_resume_fired') return emit('working');
      if (!b.notification_type || b.notification_type === 'idle_prompt') {
        if (state.attention || state.failure) return { state, status: null }; // an idle ping cannot answer a pending prompt
        return emit(pending ? 'working' : 'waiting', pending ? null : b.message || null);
      }
      return { state, status: null }; // auth_success / informational / future types are not completion
    case 'SubagentStart': case 'SubagentStop':
      return { state, status: null }; // a helper finishing is NOT the parent finishing
    default:
      return { state, status: null }; // TaskCompleted is a checklist item, not a foreground turn
  }
}

// Bound recognition to the LIVE composer/footer, not matching report prose quoting a spinner or task
// count. Keep the raw slice above the composer available for question extraction without its draft.
export function claudeTerminalFrame(screen) {
  const lines = stripAnsi(String(screen || '')).replace(/\r/g, '').split('\n');
  const footerRx = /bypass permissions|accept edits|plan mode|shift\+tab|⏵⏵|⏸|← for agents/i;
  let footerAt = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    if (footerRx.test(lines[i])) { footerAt = i; break; }
  }
  if (footerAt < 0) return null;
  let composerAt = -1;
  for (let i = footerAt - 1; i >= Math.max(0, footerAt - 120); i--) {
    if (/^\s*❯(?:\s|$)/.test(lines[i]) && !/^\s*❯\s*\d+[.)]\s/.test(lines[i])) { composerAt = i; break; }
  }
  if (composerAt < 0) return null;
  const footer = lines.slice(footerAt).join('\n');
  const counts = [...footer.matchAll(/\b(\d+)\s+(shells?|agents?|tasks?|monitors?)\b/gi)];
  const count = counts.length ? counts.reduce((n, match) => n + Number(match[1]), 0) : 0;
  const body = lines.slice(0, composerAt).join('\n');
  const recent = lines.slice(Math.max(0, composerAt - 6), composerAt)
    .filter(line => line.trim() && !/^\s*[─━═_-]{8,}\s*$/.test(line)).at(-1) || '';
  const done = /^[\s✻✢✽✶✳✼*─━]*[A-Z][a-z]+ for \d/.test(recent);
  // Older CLI versions put the only count on the adjacent turn-end line.
  const olderCount = done ? recent.match(/\b(\d+)\s+(?:shells?|agents?|tasks?)\s+still running\b/i) : null;
  return { body, footer, count: count || Number(olderCount?.[1] || 0), countKnown: counts.length > 0 || !!olderCount,
    background: counts.map(match => `${match[1]} ${match[2]}`).join(', ') || (olderCount ? olderCount[0] : ''), done };
}
