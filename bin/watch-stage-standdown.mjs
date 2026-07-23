#!/usr/bin/env node
// Live watch for the Supervisor stage stand-down. Emits one line per meaningful event (stage transitions,
// stage.stand_down confirmations, and — critically — MISFIRES: an answer/nudge/challenge drafted while the
// decision's own snapshot stage is planning/awaiting_approval, which would mean the gate failed). Silence
// just means the session is executing. Poll the decision corpus (read-only) every 20s.
//   node bin/watch-stage-standdown.mjs <session_id>
import { DatabaseSync } from 'node:sqlite';

const sid = process.argv[2] || 's_0e9e27b282';
const DB = process.env.AIOS_DB || 'data/aios.db';
const STANDDOWN = new Set(['planning', 'awaiting_approval']);
const INTERVENE = new Set(['answer', 'nudge', 'challenge']);
const t = (ms) => new Date(Number(ms)).toLocaleTimeString('en-US', { hour12: false });

function all(sql, ...p) { const db = new DatabaseSync(DB, { readOnly: true }); try { return db.prepare(sql).all(...p); } finally { db.close(); } }
function one(sql, ...p) { return all(sql, ...p)[0] || {}; }
function snapStage(json) { try { const s = JSON.parse(json); return s?.stage?.stage || s?.session?.stage || ''; } catch { return ''; } }

let lastTs = Number(one('SELECT COALESCE(MAX(ts),0) v FROM supervisor_decisions WHERE session_id=?', sid).v || 0);
let lastStage = String(one('SELECT COALESCE(stage,\'\') v FROM sessions WHERE id=?', sid).v || '');
const s0 = one('SELECT status, COALESCE(stage,\'\') stage, substr(COALESCE(summary,\'\'),1,100) summary FROM sessions WHERE id=?', sid);
console.log(`armed: ${sid} status=${s0.status} stage=${s0.stage || 'none'} — watching stage.stand_down + misfires`);

function tick() {
  try {
    const s = one('SELECT status, COALESCE(stage,\'\') stage, substr(COALESCE(summary,\'\'),1,110) summary FROM sessions WHERE id=?', sid);
    if (s.stage !== lastStage) {
      const tag = STANDDOWN.has(s.stage) ? 'PLANNING — expect stand-down' : (s.stage === 'executing' ? 'executing' : (s.stage || 'none'));
      console.log(`STAGE -> ${s.stage || 'none'} [${tag}] status=${s.status}: ${s.summary}`);
      lastStage = s.stage;
    }
    const rows = all(`SELECT d.ts, d.rule_id, d.action_type, COALESCE(d.suppression_reason,'') sr, d.sent,
      COALESCE(d.snapshot_json, s.snapshot_json) snapshot_json
      FROM supervisor_decisions d LEFT JOIN supervisor_snapshots s ON s.snapshot_hash=d.snapshot_hash
      WHERE d.session_id=? AND d.ts>? ORDER BY d.ts`, sid, lastTs);
    for (const r of rows) {
      if (r.rule_id === 'stage.stand_down') {
        console.log(`STOOD DOWN @ ${t(r.ts)} — ${r.sr} (action=${r.action_type}, sent=${r.sent}) [gate working]`);
      } else if (r.rule_id === 'operator.finish_phases') {
        console.log(`PROCEED NUDGE @ ${t(r.ts)} — operator delegated finishing the phases; pushing builder to next phase (sent=${r.sent}) [correct]`);
      } else if (INTERVENE.has(r.action_type)) {
        const st = snapStage(r.snapshot_json);
        if (STANDDOWN.has(st)) console.log(`MISFIRE @ ${t(r.ts)} — ${r.rule_id}/${r.action_type} drafted while stage=${st} (sent=${r.sent}) [gate FAILED]`);
      }
    }
    if (rows.length) lastTs = Math.max(lastTs, ...rows.map((r) => Number(r.ts)));
  } catch (e) {
    console.log(`(watch error: ${e.message})`);
  }
}
setInterval(tick, 20000);
