import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, LOG_DIR, DB_PATH } from './config.js';
import { now } from './util.js';

mkdirSync(LOG_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 4000;

  CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    project_id    TEXT,
    tool          TEXT NOT NULL,
    tmux          TEXT NOT NULL,
    title         TEXT,
    status        TEXT NOT NULL DEFAULT 'starting',
    question      TEXT,
    autonomy      TEXT,
    effort        TEXT,
    model         TEXT,
    fast_mode     INTEGER NOT NULL DEFAULT 0,
    orchestration TEXT,
    summary       TEXT,
    category      TEXT,
    started_at    INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    ended_at      INTEGER,
    exit_code     INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    direction  TEXT NOT NULL,          -- 'in' (you -> session) | 'out' (extracted question)
    source     TEXT,                   -- 'text' | 'voice' | 'auto' | 'detect'
    text       TEXT NOT NULL
  );

  -- Decision events: one row per agent "ask" (a -> waiting transition). Captures the FULL ask
  -- (terminal context), the model's category + one-line summary, and is later updated with YOUR
  -- response. Denormalized project/tool/model so it survives session/project deletion -> clean
  -- training data (situation -> human decision) + a fast history view.
  CREATE TABLE IF NOT EXISTS decisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    project_id      TEXT,
    project         TEXT,
    tool            TEXT,
    model           TEXT,
    asked_at        INTEGER NOT NULL,
    category        TEXT,                  -- action | decision | review (model classification)
    summary         TEXT,                  -- the model's one-line summary
    question        TEXT,                  -- the short extracted question (detect.js)
    ask             TEXT,                  -- the FULL ask: stripped terminal context at waiting
    responded_at    INTEGER,
    response        TEXT,                  -- your reply (null until answered)
    response_source TEXT,                  -- text | voice | auto
    status          TEXT NOT NULL DEFAULT 'pending'  -- pending | answered | superseded
  );

  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_session    ON events(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_messages_session  ON messages(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, asked_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_asked   ON decisions(asked_at);
`);

// Migrations for DBs created before a column existed (ALTER errors if it already does).
for (const col of ['autonomy TEXT', 'effort TEXT', 'model TEXT', 'fast_mode INTEGER NOT NULL DEFAULT 0', 'orchestration TEXT', 'summary TEXT', 'category TEXT', 'stage TEXT', 'codex_via_proxy INTEGER NOT NULL DEFAULT 0', 'codex_uuid TEXT']) {
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
  } catch {}
}

// ---- projects ---------------------------------------------------------------
const _insProject = db.prepare('INSERT INTO projects (id,name,path,created_at) VALUES (?,?,?,?)');
const _allProjects = db.prepare('SELECT * FROM projects ORDER BY name');
const _getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const _projectByPath = db.prepare('SELECT * FROM projects WHERE path = ?');

export function createProject({ id, name, path }) {
  _insProject.run(id, name, path, now());
  return _getProject.get(id);
}
export const listProjects = () => _allProjects.all();
export const getProject = (id) => _getProject.get(id);
export const getProjectByPath = (p) => _projectByPath.get(p);
const _delProject = db.prepare('DELETE FROM projects WHERE id = ?');
const _liveForProject = db.prepare("SELECT COUNT(*) n FROM sessions WHERE project_id = ? AND status != 'exited'");
export const deleteProject = (id) => _delProject.run(id);
export const liveSessionsForProject = (id) => _liveForProject.get(id).n;

// ---- sessions ---------------------------------------------------------------
const _insSession = db.prepare(
  `INSERT INTO sessions (id,project_id,tool,tmux,title,status,autonomy,effort,model,fast_mode,orchestration,started_at,last_activity)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const _getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const _getSessionByTmux = db.prepare('SELECT * FROM sessions WHERE tmux = ?');
const _allSessions = db.prepare('SELECT * FROM sessions ORDER BY last_activity DESC');
const _liveSessions = db.prepare(
  "SELECT * FROM sessions WHERE status != 'exited' ORDER BY last_activity DESC"
);

export function createSession(s) {
  const t = now();
  _insSession.run(s.id, s.project_id ?? null, s.tool, s.tmux, s.title ?? null, s.status ?? 'starting', s.autonomy ?? null, s.effort ?? null, s.model ?? null, s.fast_mode ? 1 : 0, s.orchestration ?? null, t, t);
  return _getSession.get(s.id);
}
export const getSession = (id) => _getSession.get(id);
export const getSessionByTmux = (t) => _getSessionByTmux.get(t);
export const listSessions = () => _allSessions.all();
export const listLiveSessions = () => _liveSessions.all();

const SESSION_FIELDS = ['project_id', 'tool', 'tmux', 'title', 'status', 'question', 'summary', 'category', 'stage', 'autonomy', 'effort', 'model', 'fast_mode', 'orchestration', 'codex_via_proxy', 'codex_uuid', 'last_activity', 'ended_at', 'exit_code'];
export function updateSession(id, patch) {
  const keys = Object.keys(patch).filter((k) => SESSION_FIELDS.includes(k));
  if (!keys.length) return getSession(id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE sessions SET ${set} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
  return getSession(id);
}

// ---- events -----------------------------------------------------------------
const _insEvent = db.prepare('INSERT INTO events (session_id,ts,type,payload) VALUES (?,?,?,?)');
const _eventsFor = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ?');
export function addEvent(session_id, type, payload) {
  _insEvent.run(session_id, now(), type, payload != null ? JSON.stringify(payload) : null);
}
export const eventsFor = (id, limit = 100) => _eventsFor.all(id, limit);

// ---- attention governor helpers ---------------------------------------------
// Newest OPERATOR act per session (messages from text/voice sources) in ONE grouped query — buildState
// computes an engagement tier for every session each poll, so per-session queries would be O(n) hot-path.
const _lastTouchBySession = db.prepare(
  "SELECT session_id, MAX(ts) t FROM messages WHERE direction = 'in' AND source IN ('text','voice','text+attachments') GROUP BY session_id"
);
export function lastOperatorTouchBySession() {
  const out = new Map();
  try { for (const r of _lastTouchBySession.all()) out.set(r.session_id, Number(r.t) || 0); } catch {}
  return out;
}

// Ask garbage-collection: pending asks past the TTL become 'expired' (archived out of any queue math)
// instead of rotting as false workload (64 leaked rows, oldest 33 days, before this existed).
const _expireAsks = db.prepare("UPDATE decisions SET status = 'expired' WHERE status = 'pending' AND asked_at < ?");
export function expireStaleAsks(ttlMs) {
  try { return _expireAsks.run(Date.now() - ttlMs).changes || 0; } catch { return 0; }
}

// ---- messages ---------------------------------------------------------------
const _insMessage = db.prepare('INSERT INTO messages (session_id,ts,direction,source,text) VALUES (?,?,?,?,?)');
const _messagesFor = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC LIMIT ?');
const _recentMessagesFor = db.prepare('SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC');
export function addMessage(session_id, direction, source, text) {
  _insMessage.run(session_id, now(), direction, source ?? null, text);
}
export const messagesFor = (id, limit = 200) => _messagesFor.all(id, limit);
export const recentMessagesFor = (id, limit = 40) => _recentMessagesFor.all(id, limit);

// ---- decisions (ask -> response events; the training-grade history) -----------
const _insDecision = db.prepare(
  `INSERT INTO decisions (session_id,project_id,project,tool,model,asked_at,category,summary,question,ask,status)
   VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`
);
const _supersedeDecisions = db.prepare("UPDATE decisions SET status='superseded' WHERE session_id = ? AND status = 'pending'");
const _answerDecision = db.prepare(
  `UPDATE decisions SET response = ?, response_source = ?, responded_at = ?, status = 'answered'
   WHERE id = (SELECT id FROM decisions WHERE session_id = ? AND status = 'pending' ORDER BY asked_at DESC LIMIT 1)`
);
const _decisionsFor = db.prepare('SELECT * FROM decisions WHERE session_id = ? ORDER BY asked_at ASC LIMIT ?');
// Record a new ask. Supersedes any still-open ask for the session so at most one is 'pending'.
export function createDecision(d) {
  _supersedeDecisions.run(d.session_id);
  const r = _insDecision.run(
    d.session_id, d.project_id ?? null, d.project ?? null, d.tool ?? null, d.model ?? null,
    d.asked_at ?? now(), d.category ?? null, d.summary ?? null, d.question ?? null, d.ask ?? null
  );
  return r.lastInsertRowid;
}
// Link a reply to the session's open ask. No-op (returns false) if none is pending — e.g. a
// message you sent proactively while the agent was working (that's still in the messages table).
export function answerPendingDecision(session_id, { response, response_source, ts } = {}) {
  const r = _answerDecision.run(response ?? null, response_source ?? null, ts ?? now(), session_id);
  return r.changes > 0;
}
export const decisionsFor = (id, limit = 100) => _decisionsFor.all(id, limit);

// ---- agent grants (per-session capability/consent + config/state for panel agents) ----
// One row per (session, agent). `enabled` drives the host scheduler; `caps` is the operator-granted
// capability set (default-deny — never auto-populated); config/state are the agent's own JSON blobs.
// Global-scope agents (e.g. the builder) use the sentinel session_id '@global'.
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_grants (
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 0,
    caps_json   TEXT,
    config_json TEXT,
    state_json  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_grants_enabled ON agent_grants(enabled);
`);

export const GLOBAL_AGENT_SCOPE = '@global';

const _getGrant = db.prepare('SELECT * FROM agent_grants WHERE session_id = ? AND agent_id = ?');
const _grantsForSession = db.prepare('SELECT * FROM agent_grants WHERE session_id = ?');
const _enabledGrants = db.prepare('SELECT * FROM agent_grants WHERE enabled = 1');
const _delGrant = db.prepare('DELETE FROM agent_grants WHERE session_id = ? AND agent_id = ?');
const _upsertGrant = db.prepare(`
  INSERT INTO agent_grants (session_id, agent_id, enabled, caps_json, config_json, state_json, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(session_id, agent_id) DO UPDATE SET
    enabled=excluded.enabled, caps_json=excluded.caps_json,
    config_json=excluded.config_json, state_json=excluded.state_json, updated_at=excluded.updated_at
`);

function parseGrant(row) {
  if (!row) return null;
  const j = (s, d) => {
    try {
      return s ? JSON.parse(s) : d;
    } catch {
      return d;
    }
  };
  return {
    session_id: row.session_id,
    agent_id: row.agent_id,
    enabled: !!row.enabled,
    caps: j(row.caps_json, []),
    config: j(row.config_json, {}),
    state: j(row.state_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const getGrant = (session_id, agent_id) => parseGrant(_getGrant.get(session_id, agent_id));
export const listGrantsForSession = (session_id) => _grantsForSession.all(session_id).map(parseGrant);
export const listEnabledGrants = () => _enabledGrants.all().map(parseGrant);
export const deleteGrant = (session_id, agent_id) => _delGrant.run(session_id, agent_id);

// Merge-patch a grant. `caps` replaces wholesale (it's the granted set); `config`/`state` shallow-merge
// (so callers can patch one key). Returns the parsed, persisted grant.
export function upsertGrant(session_id, agent_id, patch = {}) {
  const cur = getGrant(session_id, agent_id) || { enabled: false, caps: [], config: {}, state: {} };
  const next = {
    enabled: patch.enabled != null ? !!patch.enabled : cur.enabled,
    caps: Array.isArray(patch.caps) ? patch.caps : cur.caps,
    config: patch.config != null ? { ...cur.config, ...patch.config } : cur.config,
    state: patch.state != null ? { ...cur.state, ...patch.state } : cur.state,
  };
  const t = now();
  const existing = _getGrant.get(session_id, agent_id);
  _upsertGrant.run(
    session_id,
    agent_id,
    next.enabled ? 1 : 0,
    JSON.stringify(next.caps),
    JSON.stringify(next.config),
    JSON.stringify(next.state),
    existing?.created_at || t,
    t
  );
  return getGrant(session_id, agent_id);
}

// ---- push subscriptions -----------------------------------------------------
const _insSub = db.prepare('INSERT OR REPLACE INTO push_subs (endpoint,data,created_at) VALUES (?,?,?)');
const _allSubs = db.prepare('SELECT data FROM push_subs');
const _delSub = db.prepare('DELETE FROM push_subs WHERE endpoint = ?');
export function addSub(sub) {
  _insSub.run(sub.endpoint, JSON.stringify(sub), now());
}
export const listSubs = () => _allSubs.all().map((r) => JSON.parse(r.data));
export const removeSub = (endpoint) => _delSub.run(endpoint);
