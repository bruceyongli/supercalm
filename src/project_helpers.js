// Per-project enable + model config for the launch-path "helpers" — #2 context-inject, #3 preflight,
// #4 wiki-MCP — surfaced + toggled in the right-side agent panel (Project Knowledge + Preflight),
// replacing the blunt global flags as the user-facing control. The AIOS_* env vars remain as emergency
// kill-switches (env=0 forces OFF, env=1 forces ON, unset → per-project toggle). Everything defaults
// OFF, so until an operator enables a helper for a project, launches are byte-identical to before.
import { db } from './store.js';
import { now } from './util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS project_helpers (
    project_id      TEXT PRIMARY KEY,
    context_inject  INTEGER NOT NULL DEFAULT 0,
    context_model   TEXT,
    preflight       INTEGER NOT NULL DEFAULT 0,
    preflight_model TEXT,
    wiki_mcp        INTEGER NOT NULL DEFAULT 0,
    wiki_model      TEXT,
    lessons         INTEGER NOT NULL DEFAULT 0,
    lessons_model   TEXT,
    updated_at      TEXT
  )
`);
// migrate existing installs (table predates the lessons columns)
for (const col of ['lessons INTEGER NOT NULL DEFAULT 0', 'lessons_model TEXT']) {
  try { db.exec(`ALTER TABLE project_helpers ADD COLUMN ${col}`); } catch {}
}

const DEFAULTS = { context_inject: 0, context_model: null, preflight: 0, preflight_model: null, wiki_mcp: 0, wiki_model: null, lessons: 0, lessons_model: null };
const BOOL_COLS = ['context_inject', 'preflight', 'wiki_mcp', 'lessons'];
const MODEL_COLS = ['context_model', 'preflight_model', 'wiki_model', 'lessons_model'];
const _get = db.prepare('SELECT * FROM project_helpers WHERE project_id = ?');
const _upsert = db.prepare(`INSERT INTO project_helpers
  (project_id,context_inject,context_model,preflight,preflight_model,wiki_mcp,wiki_model,lessons,lessons_model,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(project_id) DO UPDATE SET context_inject=excluded.context_inject,context_model=excluded.context_model,
    preflight=excluded.preflight,preflight_model=excluded.preflight_model,wiki_mcp=excluded.wiki_mcp,
    wiki_model=excluded.wiki_model,lessons=excluded.lessons,lessons_model=excluded.lessons_model,updated_at=excluded.updated_at`);

export function getHelpers(pid) {
  return { ...DEFAULTS, ...(pid ? (_get.get(pid) || {}) : {}) };
}

export function setHelpers(pid, patch = {}) {
  if (!pid) throw new Error('project required');
  const cur = { ...DEFAULTS, ...(_get.get(pid) || {}) };
  for (const k of BOOL_COLS) if (k in patch) cur[k] = patch[k] ? 1 : 0;
  for (const k of MODEL_COLS) if (k in patch) cur[k] = patch[k] ? String(patch[k]).slice(0, 80) : null;
  _upsert.run(pid, cur.context_inject, cur.context_model, cur.preflight, cur.preflight_model, cur.wiki_mcp, cur.wiki_model, cur.lessons, cur.lessons_model, now());
  return getHelpers(pid);
}

// helper key -> { col, env }. Maps the panel/launch concept to the column + the env kill-switch.
const KEYS = {
  contextInject: { col: 'context_inject', env: 'AIOS_CONTEXT_INJECT' },
  preflight: { col: 'preflight', env: 'AIOS_PREFLIGHT_GRILL' },
  wiki: { col: 'wiki_mcp', env: 'AIOS_WIKI' },
  lessons: { col: 'lessons', env: 'AIOS_LESSONS' },
};

function envState(name) {
  const v = process.env[name];
  if (v == null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return undefined;
}

// Effective enable at launch: env=0 kills, env=1 forces on, else the per-project toggle. Default OFF.
export function helperEnabled(pid, key) {
  const def = KEYS[key];
  if (!def) return false;
  const env = envState(def.env);
  if (env === false) return false;
  if (env === true) return true;
  if (!pid) return false;
  return !!(_get.get(pid)?.[def.col]);
}

// Effective model for a helper (per-project override, else null → caller's default chain).
export function helperModelFor(pid, key) {
  const col = { contextInject: 'context_model', preflight: 'preflight_model', wiki: 'wiki_model', lessons: 'lessons_model' }[key];
  return (pid && col) ? (_get.get(pid)?.[col] || null) : null;
}
