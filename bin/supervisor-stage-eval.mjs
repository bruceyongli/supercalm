#!/usr/bin/env node
// Stage-awareness eval on the REAL decision corpus (read-only). Replays every historical intervention the
// Supervisor drafted (answer / nudge / challenge) through the new stage classifier and reports how many it
// would now STAND DOWN on — i.e. how many were the "jumped in during planning" misfire. This is the
// data-driven half of the training loop: it turns supervisor_decisions into a labeled measurement of the
// gate before/after, and surfaces the worst offending sessions to sanity-check the heuristic.
//
//   node bin/supervisor-stage-eval.mjs [--db data/aios.db] [--limit 8000] [--session s_...] [--examples 8]
import { DatabaseSync } from 'node:sqlite';
import { resolveStage, isStandDownStage } from '../src/agents/supervisor/stage.js';

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : def; }
const DB = arg('db', 'data/aios.db');
const LIMIT = Number(arg('limit', 8000));
const SESSION = arg('session', '');
const EXAMPLES = Number(arg('examples', 8));

const db = new DatabaseSync(DB, { readOnly: true });
const INTERVENTIONS = ['answer', 'nudge', 'challenge']; // the agent-directed actions a wrong stage misfires
const where = ["action_type IN ('answer','nudge','challenge')", 'snapshot_json IS NOT NULL'];
const params = [];
if (SESSION) { where.push('session_id = ?'); params.push(SESSION); }
const rows = db.prepare(
  `SELECT id, session_id, ts, action_type, rule_id, sent, snapshot_json
   FROM supervisor_decisions WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`
).all(...params, LIMIT);

const byRule = new Map();      // rule_id -> { total, standDown }
const byStage = new Map();     // resolved stage -> count (of interventions)
const bySession = new Map();   // session_id -> { total, standDown }
const examples = [];
let total = 0, standDown = 0, sentStandDown = 0;

for (const r of rows) {
  let snap;
  try { snap = JSON.parse(r.snapshot_json); } catch { continue; }
  total++;
  const stage = resolveStage(snap);
  const suppress = isStandDownStage(stage.stage) && (snap?.session?.status === 'waiting');
  byStage.set(stage.stage, (byStage.get(stage.stage) || 0) + 1);
  const ruleAgg = byRule.get(r.rule_id) || { total: 0, standDown: 0 }; ruleAgg.total++; if (suppress) ruleAgg.standDown++; byRule.set(r.rule_id, ruleAgg);
  const sesAgg = bySession.get(r.session_id) || { total: 0, standDown: 0 }; sesAgg.total++; if (suppress) sesAgg.standDown++; bySession.set(r.session_id, sesAgg);
  if (suppress) {
    standDown++;
    if (r.sent) sentStandDown++;
    if (examples.length < EXAMPLES) examples.push({ session: r.session_id, rule: r.rule_id, stage: stage.stage, why: (stage.reasons || []).join(','), summary: String(snap?.session?.summary || '').slice(0, 90) });
  }
}

const pct = (n) => total ? ((100 * n) / total).toFixed(1) + '%' : '—';
console.log(`\nSupervisor stage-awareness eval — ${total} historical interventions (${INTERVENTIONS.join('/')})${SESSION ? ` for ${SESSION}` : ''}\n`);
console.log(`Would now STAND DOWN (planning / awaiting_approval): ${standDown}  (${pct(standDown)})`);
console.log(`  … of which were actually SENT to the agent: ${sentStandDown} (auto-pilot would have jumped in)\n`);
console.log('By original rule (drafts → suppressed by stage):');
for (const [rule, a] of [...byRule].sort((x, y) => y[1].standDown - x[1].standDown)) console.log(`  ${rule.padEnd(26)} ${String(a.standDown).padStart(5)} / ${a.total}`);
console.log('\nResolved stage mix of interventions:');
for (const [s, n] of [...byStage].sort((x, y) => y[1] - x[1])) console.log(`  ${s.padEnd(18)} ${n}`);
console.log('\nTop sessions by suppressed interventions:');
for (const [sid, a] of [...bySession].sort((x, y) => y[1].standDown - x[1].standDown).slice(0, 8)) if (a.standDown) console.log(`  ${sid}  ${a.standDown}/${a.total}`);
if (examples.length) { console.log('\nExamples now stood down:'); for (const e of examples) console.log(`  [${e.stage}] ${e.session} (${e.rule}; ${e.why}) — ${e.summary}`); }
console.log('');
db.close();
