// Project Memory (PSS) — phase 1: the data layer that replaces the per-session supervision doc.
// Plan: docs/specs/project-memory-plan.md. Panel-hardened decisions baked in here:
//   - DB-authoritative (the builder can never write the judge's contract); the repo gets a
//     read-only, hash-pinned PROJECTION whose edits are detected as tampering, not accepted.
//   - Criteria are first-class rows with validity intervals (never a JSON blob inside the card):
//     "which criteria were current at version N?" must be a query, and the gate grills them one
//     by one with per-criterion evidence.
//   - Every card mutation bumps an immutable version snapshot (pm_task_versions) — audit lines
//     ("gate passed v3") stay meaningful after the card moves on.
//   - Events are typed, two-sentence records (the Timeline/Decisions/Resolved replacement);
//     retrieval-only by design — nothing here is injected wholesale.
// Phase 1 is DATA-ONLY: the supervisor does not import this module yet (locked by test).
// Behavior phases (3+) gate on flags.js `projectMemory`.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { db } from '../../store.js';
import { now, id as genId } from '../../util.js';

// ---- schema -------------------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS pm_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','active','paused','verify_pending','done','abandoned','superseded')),
  superseded_by TEXT,
  driven_by_session TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_pm_tasks_project ON pm_tasks(project_id, status);
CREATE TABLE IF NOT EXISTS pm_criteria (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','satisfied','superseded','removed')),
  evidence_id TEXT,
  source TEXT NOT NULL DEFAULT 'operator',
  valid_from INTEGER NOT NULL,
  superseded_at INTEGER,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_pm_criteria_task ON pm_criteria(task_id, status);
CREATE TABLE IF NOT EXISTS pm_task_versions (
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, version)
);
CREATE TABLE IF NOT EXISTS pm_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  criterion_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('git_diff','test_output','terminal','screenshot','url','file','operator')),
  ref TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_evidence_task ON pm_evidence(task_id);
CREATE TABLE IF NOT EXISTS pm_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('operator','supervisor','maintainer','migration')),
  type TEXT NOT NULL CHECK (type IN ('opened','amended','claimed','released','blocked','unblocked',
    'verify_pass','verify_fail','closed','incident','deploy','rollback','legacy_doc')),
  summary TEXT NOT NULL,
  refs_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_pm_events_project ON pm_events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_pm_events_task ON pm_events(task_id, ts);
CREATE TABLE IF NOT EXISTS pm_standards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_standards_project ON pm_standards(project_id, status);
CREATE TABLE IF NOT EXISTS pm_session_runtime (
  session_id TEXT PRIMARY KEY,
  project_id TEXT,
  active_task_id TEXT,
  branch TEXT,
  worktree TEXT,
  test_cmd TEXT,
  ports_json TEXT,
  files_touched_json TEXT,
  updated_at INTEGER NOT NULL
);
`);

// ---- card + versioning ---------------------------------------------------------------------------
export function getTask(taskId) {
  return db.prepare('SELECT * FROM pm_tasks WHERE id = ?').get(taskId) || null;
}
export function listCriteria(taskId, { includeInactive = false } = {}) {
  const rows = db.prepare('SELECT * FROM pm_criteria WHERE task_id = ? ORDER BY valid_from, id').all(taskId);
  return includeInactive ? rows : rows.filter((c) => c.status === 'open' || c.status === 'satisfied');
}
// The injectable card: the task + its live criteria + a stable content hash. The hash covers the
// CONTRACT (goal + criteria + constraints), not bookkeeping — it's what audit records cite.
export function taskCard(taskId) {
  const task = getTask(taskId);
  if (!task) return null;
  const criteria = listCriteria(taskId);
  return { task, criteria, hash: cardHash(task, criteria) };
}
export function cardHash(task, criteria) {
  const canon = JSON.stringify({
    title: task.title, goal: task.goal, status: task.status,
    criteria: criteria.map((c) => ({ id: c.id, text: c.text, status: c.status })),
  });
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}
function snapshotVersion(taskId, actor) {
  const card = taskCard(taskId);
  db.prepare('INSERT OR REPLACE INTO pm_task_versions (task_id, version, hash, snapshot_json, actor, created_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, card.task.version, card.hash, JSON.stringify({ task: card.task, criteria: listCriteria(taskId, { includeInactive: true }) }), actor, now());
  return card;
}

export function createTask({ projectId, title = '', goal = '', criteria = [], sessionId = null, actor = 'operator' }) {
  const tid = 'task_' + genId();
  const ts = now();
  db.prepare('INSERT INTO pm_tasks (id, project_id, title, goal, status, driven_by_session, version, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)')
    .run(tid, projectId, String(title).slice(0, 200), String(goal).slice(0, 4000), 'proposed', sessionId, ts, ts);
  for (const c of criteria) addCriterion(tid, c, { snapshot: false });
  appendEvent({ projectId, taskId: tid, sessionId, actor, type: 'opened', summary: `Task opened: ${title || goal.slice(0, 80)}` });
  return snapshotVersion(tid, actor);
}

function bumpVersion(taskId, actor, summary) {
  const t = getTask(taskId);
  db.prepare('UPDATE pm_tasks SET version = version + 1, updated_at = ? WHERE id = ?').run(now(), taskId);
  if (summary) appendEvent({ projectId: t.project_id, taskId, actor, type: 'amended', summary });
  return snapshotVersion(taskId, actor);
}

export function amendTask(taskId, { title, goal } = {}, { actor = 'operator', summary = '' } = {}) {
  const t = getTask(taskId);
  if (!t) return null;
  db.prepare('UPDATE pm_tasks SET title = COALESCE(?, title), goal = COALESCE(?, goal), updated_at = ? WHERE id = ?')
    .run(title != null ? String(title).slice(0, 200) : null, goal != null ? String(goal).slice(0, 4000) : null, now(), taskId);
  return bumpVersion(taskId, actor, summary || 'Card amended');
}

export function addCriterion(taskId, text, { actor = 'operator', snapshot = true } = {}) {
  const cid = 'crit_' + genId();
  db.prepare('INSERT INTO pm_criteria (id, task_id, text, status, source, valid_from) VALUES (?,?,?,?,?,?)')
    .run(cid, taskId, String(text).slice(0, 1000), 'open', actor, now());
  if (snapshot) bumpVersion(taskId, actor, `Criterion added: ${String(text).slice(0, 80)}`);
  return cid;
}

// Supersede-not-edit: the old criterion keeps its validity interval (Zep-style), the replacement
// starts a fresh one. "What did 'done' mean at version N" stays answerable forever.
export function supersedeCriterion(criterionId, newText, { actor = 'operator' } = {}) {
  const old = db.prepare('SELECT * FROM pm_criteria WHERE id = ?').get(criterionId);
  if (!old) return null;
  const cid = 'crit_' + genId();
  const ts = now();
  db.prepare('INSERT INTO pm_criteria (id, task_id, text, status, source, valid_from) VALUES (?,?,?,?,?,?)')
    .run(cid, old.task_id, String(newText).slice(0, 1000), 'open', actor, ts);
  db.prepare("UPDATE pm_criteria SET status = 'superseded', superseded_at = ?, superseded_by = ? WHERE id = ?").run(ts, cid, criterionId);
  bumpVersion(old.task_id, actor, `Criterion superseded: ${String(newText).slice(0, 80)}`);
  return cid;
}

export function addEvidence({ taskId, criterionId = null, kind, ref = '', summary = '' }) {
  const eid = 'ev_' + genId();
  db.prepare('INSERT INTO pm_evidence (id, task_id, criterion_id, kind, ref, summary, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(eid, taskId, criterionId, kind, String(ref).slice(0, 500), String(summary).slice(0, 500), now());
  return eid;
}
export function satisfyCriterion(criterionId, evidenceId, { actor = 'supervisor' } = {}) {
  const c = db.prepare('SELECT * FROM pm_criteria WHERE id = ?').get(criterionId);
  if (!c || c.status !== 'open') return false;
  db.prepare("UPDATE pm_criteria SET status = 'satisfied', evidence_id = ? WHERE id = ?").run(evidenceId, criterionId);
  bumpVersion(c.task_id, actor, `Criterion satisfied: ${c.text.slice(0, 80)}`);
  return true;
}

const CLOSING = { done: 1, abandoned: 1, superseded: 1 };
export function setTaskStatus(taskId, status, { actor = 'operator', outcome = '', sessionId = null, supersededBy = null } = {}) {
  const t = getTask(taskId);
  if (!t) return null;
  const ts = now();
  db.prepare('UPDATE pm_tasks SET status = ?, outcome = COALESCE(NULLIF(?, \'\'), outcome), closed_at = ?, superseded_by = COALESCE(?, superseded_by), driven_by_session = COALESCE(?, driven_by_session), updated_at = ? WHERE id = ?')
    .run(status, String(outcome).slice(0, 500), CLOSING[status] ? ts : null, supersededBy, sessionId, ts, taskId);
  appendEvent({
    projectId: t.project_id, taskId, sessionId, actor,
    type: CLOSING[status] ? 'closed' : status === 'blocked' ? 'blocked' : 'amended',
    summary: CLOSING[status] ? `Task ${status}${outcome ? `: ${String(outcome).slice(0, 120)}` : ''}` : `Status → ${status}`,
  });
  return bumpVersion(taskId, actor);
}

export function listTasks(projectId, { statuses = null } = {}) {
  const rows = db.prepare('SELECT * FROM pm_tasks WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
  return statuses ? rows.filter((t) => statuses.includes(t.status)) : rows;
}

// ---- events (the Timeline/Decisions/Resolved replacement — retrieval-only) ------------------------
export function appendEvent({ projectId, taskId = null, sessionId = null, actor = 'supervisor', type, summary, refs = null }) {
  const eid = 'pev_' + genId();
  db.prepare('INSERT INTO pm_events (id, project_id, task_id, session_id, ts, actor, type, summary, refs_json) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(eid, projectId, taskId, sessionId, now(), actor, type, String(summary).slice(0, 400), refs ? JSON.stringify(refs).slice(0, 2000) : null);
  return eid;
}
// File-overlap retrieval — the pre-action gate's query ("did this approach fail on these files before?").
export function listEvents({ projectId, taskId = null, types = null, files = null, limit = 50 } = {}) {
  let rows = taskId
    ? db.prepare('SELECT * FROM pm_events WHERE task_id = ? ORDER BY ts DESC LIMIT ?').all(taskId, limit * 4)
    : db.prepare('SELECT * FROM pm_events WHERE project_id = ? ORDER BY ts DESC LIMIT ?').all(projectId, limit * 4);
  if (types) rows = rows.filter((e) => types.includes(e.type));
  if (files?.length) {
    const set = new Set(files);
    rows = rows.filter((e) => {
      try { return (JSON.parse(e.refs_json || '{}').files || []).some((f) => set.has(f)); } catch { return false; }
    });
  }
  return rows.slice(0, limit);
}

// ---- standards + runtime ---------------------------------------------------------------------------
export function addStandard(projectId, text, { sourceRef = '' } = {}) {
  const sid = 'std_' + genId();
  const ts = now();
  db.prepare('INSERT INTO pm_standards (id, project_id, text, source_ref, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(sid, projectId, String(text).slice(0, 1000), sourceRef, 'active', ts, ts);
  return sid;
}
export function listStandards(projectId, { status = 'active' } = {}) {
  return db.prepare('SELECT * FROM pm_standards WHERE project_id = ? AND status = ? ORDER BY created_at').all(projectId, status);
}
export function upsertRuntime(sessionId, patch = {}) {
  const cur = db.prepare('SELECT * FROM pm_session_runtime WHERE session_id = ?').get(sessionId) || {};
  const next = { ...cur, ...patch, session_id: sessionId, updated_at: now() };
  db.prepare(`INSERT OR REPLACE INTO pm_session_runtime
    (session_id, project_id, active_task_id, branch, worktree, test_cmd, ports_json, files_touched_json, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sessionId, next.project_id ?? null, next.active_task_id ?? null, next.branch ?? null, next.worktree ?? null,
      next.test_cmd ?? null, next.ports_json ?? null, next.files_touched_json ?? null, next.updated_at);
  return next;
}
export function getRuntime(sessionId) {
  return db.prepare('SELECT * FROM pm_session_runtime WHERE session_id = ?').get(sessionId) || null;
}

// ---- repo projection (GOAL.md grown up: always-on later, zero-config, tamper-evident) --------------
// The rendered active card is written into the project so BUILDERS can see the contract — but the
// file is a projection, never the authority. A marker line pins {task, version, sha256(body)}; edits
// are detected (tampered), a marker-less file is foreign (never overwritten), and the file is
// registered in .git/info/exclude (repo-local ignore — no commits polluted, no tracked .gitignore edits).
export const PROJECTION_FILE = 'GOAL.md';
const MARKER_RX = /^<!-- supercalm:task=(\S+) v=(\d+) hash=([0-9a-f]+) -->$/m;

export function renderCardMd(card) {
  const { task, criteria } = card;
  const mark = (c) => (c.status === 'satisfied' ? 'x' : ' ');
  return [
    `# ${task.title || 'Current task'}`,
    '',
    '> Maintained by Supercalm (read-only projection — edits here are detected, not applied).',
    '',
    '## Goal',
    task.goal || '(none set)',
    '',
    '## Acceptance criteria',
    ...(criteria.length ? criteria.map((c) => `- [${mark(c)}] ${c.text}`) : ['- (none yet)']),
    '',
    `_status: ${task.status} · v${task.version}_`,
    '',
  ].join('\n');
}

function bodyHash(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export function writeProjection(projectPath, card, { force = false } = {}) {
  const file = join(projectPath, PROJECTION_FILE);
  if (existsSync(file) && !force) {
    const cur = readFileSync(file, 'utf8');
    if (!MARKER_RX.test(cur)) return { ok: false, state: 'foreign' }; // someone else's GOAL.md — never clobber
  }
  const body = renderCardMd(card);
  const content = `<!-- supercalm:task=${card.task.id} v=${card.task.version} hash=${bodyHash(body)} -->\n${body}`;
  try { if (existsSync(file)) chmodSync(file, 0o644); } catch {}
  writeFileSync(file, content);
  try { chmodSync(file, 0o444); } catch {} // read-only on disk: the "don't edit me" signal
  // repo-local ignore — never touch the project's tracked .gitignore
  try {
    const ex = join(projectPath, '.git', 'info', 'exclude');
    if (existsSync(dirname(ex))) {
      const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
      if (!cur.split('\n').includes(PROJECTION_FILE)) writeFileSync(ex, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + PROJECTION_FILE + '\n');
    }
  } catch {}
  return { ok: true, state: 'written', hash: bodyHash(body) };
}

// Tamper check: the marker's self-declared hash vs the actual body. tampered = builder edited the
// projection (evidence for the skeptical supervisor); stale = the card moved on; foreign = not ours.
export function checkProjection(projectPath, card) {
  const file = join(projectPath, PROJECTION_FILE);
  if (!existsSync(file)) return { state: 'missing' };
  const content = readFileSync(file, 'utf8');
  const m = content.match(MARKER_RX);
  if (!m) return { state: 'foreign' };
  const [, taskId, version, declared] = m;
  const body = content.slice(content.indexOf('\n') + 1);
  if (bodyHash(body) !== declared) return { state: 'tampered', taskId, version: Number(version) };
  if (card && (taskId !== card.task.id || Number(version) !== card.task.version)) return { state: 'stale', taskId, version: Number(version) };
  return { state: 'ok', taskId, version: Number(version) };
}
