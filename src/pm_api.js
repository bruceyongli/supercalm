// Project Memory task routes (phase 3) — the operator's EXPLICIT boundary controls (the panel's
// primary mechanism per the design reviews; suggestions come later as a fallback, never as the
// authority). Core store: src/agents/supervisor/project_memory.js. Route order: all paths here are
// static-prefixed (/api/session/:id/tasks, /api/pm/task/:id) so the :id-swallowing gotcha from the
// doctrine triage incident does not apply — but keep any future /api/pm/task/<literal> ABOVE the
// :id route anyway.

import { route, json } from './server.js';
import { getSession, getProject } from './store.js';
import {
  createTask, getTask, taskCard, amendTask, addCriterion, supersedeCriterion, setTaskStatus,
  listTasks, listCriteria, appendEvent, getRuntime, upsertRuntime, writeProjection, listEvents,
} from './agents/supervisor/project_memory.js';
import { bus } from './bus.js';

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}
async function bodyJson(req) {
  try { return JSON.parse(await readBody(req) || '{}'); } catch { return {}; }
}
function sessionProject(sid) {
  const sess = getSession(sid);
  if (!sess) return { error: 'no such session' };
  const project = sess.project_id ? getProject(sess.project_id) : null;
  return { sess, project, projectId: sess.project_id || null, projectPath: project?.path || null };
}
function project(card, projectPath) {
  if (card && projectPath) { try { writeProjection(projectPath, card, { force: true }); } catch {} }
}

// The panel's read: active card + open/paused list + archive drawer.
route('GET', '/api/session/:id/tasks', (req, res, { id: sid }) => {
  const { error, projectId, sess } = sessionProject(sid);
  if (error) return json(res, 404, { error });
  const rt = getRuntime(sid);
  const active = rt?.active_task_id ? taskCard(rt.active_task_id) : null;
  const all = projectId ? listTasks(projectId) : [];
  return json(res, 200, {
    ok: true,
    active,
    open: all.filter((t) => ['proposed', 'active', 'paused', 'verify_pending'].includes(t.status) && t.id !== active?.task?.id),
    archived: all.filter((t) => ['done', 'abandoned', 'superseded'].includes(t.status)).slice(0, 20),
  });
});

// Create (+activate by default): the panel's "New task" — the explicit boundary control.
route('POST', '/api/session/:id/tasks', async (req, res, { id: sid }) => {
  const { error, projectId, projectPath, sess } = sessionProject(sid);
  if (error) return json(res, 404, { error });
  if (!projectId) return json(res, 400, { error: 'session has no project' });
  const b = await bodyJson(req);
  if (!String(b.title || b.goal || '').trim()) return json(res, 400, { error: 'title or goal required' });
  const card = createTask({
    projectId, sessionId: sid, actor: 'operator',
    title: String(b.title || '').trim(), goal: String(b.goal || '').trim(),
    criteria: Array.isArray(b.criteria) ? b.criteria.map((c) => String(c).trim()).filter(Boolean) : [],
  });
  if (b.activate !== false) {
    const prev = getRuntime(sid)?.active_task_id || null;
    setTaskStatus(card.task.id, 'active', { actor: 'operator', sessionId: sid });
    upsertRuntime(sid, { project_id: projectId, active_task_id: card.task.id });
    if (prev && prev !== card.task.id) {
      const p = getTask(prev);
      if (p && p.status === 'active') setTaskStatus(prev, 'paused', { actor: 'operator', sessionId: sid });
    }
    appendEvent({ projectId, taskId: card.task.id, sessionId: sid, actor: 'operator', type: 'claimed', summary: `Task claimed by ${sid}` });
    project(taskCard(card.task.id), projectPath);
  }
  bus.emit('changed');
  return json(res, 200, { ok: true, card: taskCard(card.task.id) });
});

// Switch the session onto an existing card (resume a paused one, adopt an open one).
route('POST', '/api/session/:id/tasks/activate', async (req, res, { id: sid }) => {
  const { error, projectId, projectPath } = sessionProject(sid);
  if (error) return json(res, 404, { error });
  const b = await bodyJson(req);
  const t = getTask(String(b.taskId || ''));
  if (!t) return json(res, 404, { error: 'no such task' });
  if (t.project_id !== projectId) return json(res, 400, { error: 'task belongs to another project' });
  const prev = getRuntime(sid)?.active_task_id || null;
  if (prev && prev !== t.id) {
    const p = getTask(prev);
    if (p && p.status === 'active') setTaskStatus(prev, 'paused', { actor: 'operator', sessionId: sid });
  }
  if (t.status !== 'active') setTaskStatus(t.id, 'active', { actor: 'operator', sessionId: sid });
  upsertRuntime(sid, { project_id: projectId, active_task_id: t.id });
  appendEvent({ projectId, taskId: t.id, sessionId: sid, actor: 'operator', type: 'claimed', summary: `Task claimed by ${sid}` });
  project(taskCard(t.id), projectPath);
  bus.emit('changed');
  return json(res, 200, { ok: true, card: taskCard(t.id) });
});

// Amend / close the card: goal & title edits, add/supersede criteria, status transitions.
route('POST', '/api/pm/task/:id', async (req, res, { id: tid }) => {
  const t = getTask(tid);
  if (!t) return json(res, 404, { error: 'no such task' });
  const b = await bodyJson(req);
  if (b.title != null || b.goal != null) amendTask(tid, { title: b.title, goal: b.goal }, { actor: 'operator', summary: 'Card edited by operator' });
  for (const c of Array.isArray(b.addCriteria) ? b.addCriteria : []) addCriterion(tid, String(c), { actor: 'operator' });
  if (b.supersedeCriterion?.id && b.supersedeCriterion?.text) supersedeCriterion(b.supersedeCriterion.id, b.supersedeCriterion.text, { actor: 'operator' });
  if (b.status && ['proposed', 'active', 'paused', 'verify_pending', 'done', 'abandoned', 'superseded'].includes(b.status)) {
    setTaskStatus(tid, b.status, { actor: 'operator', outcome: String(b.outcome || '') });
  }
  // keep the projection current for whichever session drives this task
  const fresh = getTask(tid);
  const driver = fresh?.driven_by_session;
  const projectPath = driver ? sessionProject(driver).projectPath : null;
  project(taskCard(tid), projectPath);
  bus.emit('changed');
  return json(res, 200, { ok: true, card: taskCard(tid) });
});

// Recent history for the card drawer (typed events, retrieval-surface only).
route('GET', '/api/pm/task/:id/events', (req, res, { id: tid }) => {
  const t = getTask(tid);
  if (!t) return json(res, 404, { error: 'no such task' });
  return json(res, 200, { ok: true, events: listEvents({ projectId: t.project_id, taskId: tid, limit: 30 }), criteria: listCriteria(tid, { includeInactive: true }) });
});
