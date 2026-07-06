// Bet 2 — the Supervisor's optimizable "playbook": the ANSWER rubric (SYS_ANSWER + the calibration /
// autonomy addenda) lifted out of hardcoded consts into a versioned, editable store. The live supervisor
// (runAnswer) and the offline replay-eval (bin/supervisor-eval.mjs) both resolve the ACTIVE version, so a
// proposed edit can be measured against the operator's REAL past decisions (decisions.response = ground
// truth) before it ever goes live. Default = the answer_prompt.js seed, so behavior is byte-identical until
// an operator activates a new version. SkillOpt/ACE: bounded edits, kept only when a held-out score rises.
//
// NB only the ANSWER rubric is externalized for now — that's the path the eval can score against real
// operator replies. The verify rubric (SYS_VERIFY) has no comparable self-labeled ground truth yet.

import { db } from '../store.js';
import { now, id as genId } from '../util.js';
import { SYS_ANSWER, CALIBRATION_ADDENDUM, AUTONOMY_ADDENDUM } from './answer_prompt.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS supervisor_playbooks (
    id                   TEXT PRIMARY KEY,
    version              INTEGER NOT NULL,
    sys_answer           TEXT NOT NULL,
    calibration_addendum TEXT NOT NULL,
    autonomy_addendum    TEXT NOT NULL,
    notes                TEXT,
    eval_json            TEXT,
    active               INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL
  )
`);

const SEED = { sys_answer: SYS_ANSWER, calibration_addendum: CALIBRATION_ADDENDUM, autonomy_addendum: AUTONOMY_ADDENDUM };

const _active = db.prepare('SELECT * FROM supervisor_playbooks WHERE active = 1 ORDER BY version DESC LIMIT 1');
const _get = db.prepare('SELECT * FROM supervisor_playbooks WHERE id = ?');
const _list = db.prepare('SELECT id,version,notes,eval_json,active,created_at FROM supervisor_playbooks ORDER BY version DESC');
const _maxV = db.prepare('SELECT MAX(version) v FROM supervisor_playbooks');
const _count = db.prepare('SELECT COUNT(*) c FROM supervisor_playbooks');
const _insert = db.prepare('INSERT INTO supervisor_playbooks (id,version,sys_answer,calibration_addendum,autonomy_addendum,notes,eval_json,active,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
const _deactivateAll = db.prepare('UPDATE supervisor_playbooks SET active = 0');
const _activate = db.prepare('UPDATE supervisor_playbooks SET active = 1 WHERE id = ?');

// seed v1 = the hardcoded baseline (so the active rubric is always backed by a row). Stage-awareness is a
// cross-cutting STAGE_ADDENDUM always appended in runAnswer (applies to ANY active version), so it does not
// depend on re-seeding this baseline.
try {
  if (_count.get().c === 0) _insert.run(genId('pb'), 1, SEED.sys_answer, SEED.calibration_addendum, SEED.autonomy_addendum, 'seed: hardcoded baseline', null, 1, now());
} catch (e) { console.error('[playbook] seed failed:', e.message); }

// The active rubric. Fail-safe: any DB hiccup -> the compiled-in seed, so runAnswer never breaks.
export function activePlaybook() {
  try {
    const r = _active.get();
    if (r && r.sys_answer) return r;
  } catch {}
  return { ...SEED, version: 0, id: null };
}
export function getPlaybook(id) { try { return _get.get(id) || null; } catch { return null; } }
export function listPlaybooks() { try { return _list.all(); } catch { return []; } }
export function nextVersion() { try { return (_maxV.get().v || 0) + 1; } catch { return 1; } }

// Save a NEW (inactive) version — e.g. a candidate proposed by the optimizer, with its eval scores.
export function savePlaybook({ sys_answer, calibration_addendum, autonomy_addendum, notes, eval_json }) {
  const v = nextVersion();
  const pid = genId('pb');
  _insert.run(pid, v, sys_answer ?? SEED.sys_answer, calibration_addendum ?? SEED.calibration_addendum, autonomy_addendum ?? SEED.autonomy_addendum, notes || '', eval_json ? JSON.stringify(eval_json) : null, 0, now());
  return { id: pid, version: v };
}

// The human apply-gate: make `id` the one active version (only ever ONE active).
export function activatePlaybook(id) {
  const r = getPlaybook(id);
  if (!r) throw new Error('no such playbook');
  _deactivateAll.run();
  _activate.run(id);
  return getPlaybook(id);
}
