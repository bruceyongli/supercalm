#!/usr/bin/env node
// Bet 2 — Supervisor ANSWER-rubric optimizer (SkillOpt × ACE × EmbodiSkill).
//
// The loop: score the ACTIVE rubric on held-out past decisions (operator's real reply = ground truth) ->
// gather the cases it got WRONG -> ask a model to ATTRIBUTE each miss (EmbodiSkill: rubric-fault vs
// context-fault) and propose MINIMAL bounded edits that fix only the rubric-faults (ACE: no bloat, no
// case-specific hacks) -> re-score each candidate on the SAME held-out set -> KEEP a candidate only if its
// match/mop rate beats the baseline (SkillOpt). Winners are saved as INACTIVE playbook versions with their
// scores; a human activates one via POST /api/supervisor/playbook/:id/activate. NEVER auto-applies — the
// ground truth is real but the judge is an LLM, so a human gates the live change.
//
// Usage:
//   node bin/supervisor-optimize.mjs [--limit 120] [--heldout 0.5] [--candidates 3]
//        [--model gemini-pro-agent] [--judge claude-haiku-4-5] [--propose-model gemini-pro-agent]
//        [--category decision,action] [--temp 0] [--exclude sid,sid] [--verbose]
// Reads decisions read-only; writes only NEW inactive supervisor_playbooks rows. No live behavior change.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyCatalog, routeForModel } from '../src/model_catalog.js';
import { callProxyModel, parseJsonObject } from '../src/agents/model.js';
import { buildAnswerUserText, SYS_ANSWER } from '../src/agents/answer_prompt.js';
import { activePlaybook, savePlaybook } from '../src/agents/playbook.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIVE_DB = process.env.AIOS_EVAL_DB || join(ROOT, 'data', 'aios.db');
const LIVE_CATALOG = process.env.AIOS_EVAL_CATALOG || join(ROOT, 'data', 'model_catalog.json');

function parseArgs(argv) {
  const a = { limit: 120, heldout: 0.5, candidates: 3, model: 'gemini-pro-agent', judge: 'claude-haiku-4-5', 'propose-model': 'gemini-pro-agent', category: 'decision,action', temp: '0', concurrency: 6, retries: 5, verbose: false, exclude: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--verbose') a.verbose = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  a.limit = Number(a.limit) || 120;
  a.heldout = Number(a.heldout) || 0.5;
  a.candidates = Number(a.candidates) || 3;
  a.concurrency = Number(a.concurrency) || 6;
  a.retries = Number(a.retries) || 5;
  a.temp = Number(a.temp) || 0;
  a.exclude = String(a.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);
  return a;
}
const args = parseArgs(process.argv.slice(2));

const tail = (s, max) => { const t = String(s || ''); return t.length > max ? t.slice(0, max) : t; };
const safeParse = (s) => { try { return parseJsonObject(s); } catch { return null; } };
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '—');

const SYS_JUDGE = `You compare two answers to the SAME situation an autonomous coding agent faced: (A) what an AI supervisor PROPOSED, and (B) what the human operator ACTUALLY replied (ground truth). Judge whether sending A instead of B would have produced substantially the same outcome — same decision, direction, and key constraints. Ignore wording, length, and tone.
- "match": A captures B's decision and its key constraints; A instead of B would be fine.
- "partial": A is in the right direction but misses a material part (a constraint, a chosen option, scope).
- "mismatch": A would lead somewhere different from B, or contradicts it.
- "offtopic": B is not actually an answer to the situation (a brand-new unrelated instruction, or just "/compact"); exclude from scoring.
Return STRICT minified JSON only: {"verdict":"match|partial|mismatch|offtopic","reason":"<one short sentence>"}`;

const SYS_PROPOSE = `You improve the SYSTEM PROMPT ("rubric") that an AI supervisor uses to ANSWER on behalf of a human operator when an autonomous coding agent stops to ask something. You are given the CURRENT rubric and CASES where the answer it produced did NOT match what the operator actually decided (with the judge's reason).

First, for each case, ATTRIBUTE the miss:
- "rubric": the rubric itself guided toward the wrong call — a fixable instruction-level problem.
- "context": the miss needed case-specific context the rubric cannot encode (the operator's private intent / project specifics) — NOT the rubric's fault, do not try to fix it.

Then propose a REVISED rubric that fixes ONLY the "rubric"-attributed misses. Rules (ACE):
- MINIMAL, bounded edits; preserve everything that already works.
- Stay GENERAL — no case-specific hacks, names, or values memorised from the cases.
- Do NOT bloat — keep it about the same length; tighten as you add.
- Keep the STRICT-JSON output contract the rubric demands of the supervisor intact and unchanged.

Return EXACTLY this format and nothing else (the rubric is multi-line, so it is NOT JSON — use the delimiters verbatim):
ATTRIBUTION: <which cases were rubric-fault vs context-fault, brief>
CHANGELOG: <1-3 short bullets: what you changed and why>
REVISED_RUBRIC:
===BEGIN===
<the FULL revised rubric text, verbatim — keep its strict-JSON output contract intact>
===END===`;

async function call(model, messages, maxTokens, temp = args.temp, json = true) {
  const r = await callProxyModel(routeForModel(model), messages, { json, temperature: temp, maxTokens, retries: args.retries });
  return r.content;
}

function loadRows(db) {
  const cats = args.category === 'all' ? ['decision', 'action', 'review'] : args.category.split(',').map((s) => s.trim());
  const ph = cats.map(() => '?').join(',');
  const exPh = args.exclude.length ? ` AND session_id NOT IN (${args.exclude.map(() => '?').join(',')})` : '';
  const exProj = String(args['exclude-project'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const exProjPh = exProj.length ? ` AND (project IS NULL OR project NOT IN (${exProj.map(() => '?').join(',')}))` : '';
  return db.prepare(
    `SELECT id, session_id, project_id, project, tool, asked_at, category, summary, question, ask, response
     FROM decisions
     WHERE response IS NOT NULL AND trim(response) <> '' AND status='answered'
       AND category IN (${ph}) AND substr(trim(response),1,1) <> '/'${exPh}${exProjPh}
     ORDER BY asked_at DESC LIMIT ?`
  ).all(...cats, ...args.exclude, ...exProj, args.limit);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// Run ONE decision through the supervisor ANSWER prompt with a GIVEN rubric, then judge vs operator reply.
async function judgeRow(db, msgsStmt, sysAnswer, row) {
  const recent = msgsStmt.all(row.session_id, row.asked_at).reverse().map((m) => ({ dir: m.dir, src: m.src, text: tail(m.text, 1500) }));
  const userText = buildAnswerUserText({ doc: '', question: row.question || row.summary || '', category: row.category, summary: row.summary, recent_messages: recent, terminal_tail: row.ask || '', action: row.category === 'action' });
  let parsed;
  try { parsed = safeParse(await call(args.model, [{ role: 'system', content: sysAnswer }, { role: 'user', content: userText }], 1500)); }
  catch (e) { return { action: 'error', error: String(e.message || e).slice(0, 120) }; }
  if (!parsed) return { action: 'error', error: 'unparsed answer' };
  if (parsed.action === 'escalate' || !String(parsed.answer || '').trim()) return { action: 'escalate' };
  const sup = String(parsed.answer).trim();
  let j;
  try {
    const judgeUser = `SITUATION:\n${tail(row.ask || row.question || row.summary || '', 2000)}\n\nA) SUPERVISOR PROPOSED:\n${tail(sup, 1500)}\n\nB) OPERATOR ACTUALLY REPLIED:\n${tail(row.response || '', 1500)}\n\nReturn JSON only.`;
    j = safeParse(await call(args.judge, [{ role: 'system', content: SYS_JUDGE }, { role: 'user', content: judgeUser }], 300));
  } catch (e) { return { action: 'error', error: 'judge: ' + String(e.message || e).slice(0, 110) }; }
  if (!j) return { action: 'error', error: 'unparsed judge' };
  return { action: 'answer', verdict: j.verdict || 'mismatch', reason: tail(j.reason || '', 160), supervisor: tail(sup, 400) };
}

async function score(db, msgsStmt, sysAnswer, rows, label) {
  const res = await pool(rows, args.concurrency, (row) => judgeRow(db, msgsStmt, sysAnswer, row).then((r) => ({ row, ...r })));
  const valid = res.filter((r) => r.action !== 'error' && r.verdict !== 'offtopic');
  const N = valid.length;
  const match = valid.filter((r) => r.action === 'answer' && r.verdict === 'match').length;
  const mop = valid.filter((r) => r.action === 'answer' && (r.verdict === 'match' || r.verdict === 'partial')).length;
  const esc = valid.filter((r) => r.action === 'escalate').length;
  // misses fed to the proposer = answered-but-wrong AND escalations: every corpus row IS a decision the
  // operator actually answered, so escalating was itself a miss (the supervisor should have decided).
  const misses = valid.filter((r) => (r.action === 'answer' && r.verdict !== 'match') || r.action === 'escalate');
  if (args.verbose) console.error(`  [${label}] N=${N} match=${match} mop=${mop} esc=${esc} (errors ${res.length - res.filter((r) => r.action !== 'error').length})`);
  return { N, match, mop, esc, match_rate: N ? match / N : 0, mop_rate: N ? mop / N : 0, misses, res };
}

// Robustly pull the revised rubric out of the proposer's reply — models are inconsistent about the
// delimiters, so try the ===BEGIN===/===END=== block, then a fenced code block, then "everything after
// the REVISED_RUBRIC: marker" with stray fences/markers stripped.
function extractRubric(text) {
  let m = String(text || '').match(/===\s*BEGIN\s*===\s*([\s\S]*?)\s*===\s*END\s*===/i);
  if (m) return m[1].trim();
  m = String(text || '').match(/REVISED_RUBRIC:?\s*```[a-z]*\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = String(text || '').match(/REVISED_RUBRIC:?\s*([\s\S]+)$/i);
  if (m) return m[1].replace(/===\s*(BEGIN|END)\s*===/gi, '').replace(/```/g, '').trim();
  return '';
}

function casesBlock(misses, k = 8) {
  return misses.slice(0, k).map((m, i) => {
    const proposed = m.action === 'escalate' ? 'ESCALATED to the operator (declined to answer)' : tail(m.supervisor, 400);
    const why = m.action === 'escalate' ? 'the operator answered this themselves — escalating was the wrong call; the rubric should have decided from the context' : `${m.verdict}: ${m.reason}`;
    return `CASE ${i + 1}:\nSITUATION: ${tail(m.row.ask || m.row.question || m.row.summary || '', 700)}\nSUPERVISOR (current rubric): ${proposed}\nOPERATOR ACTUALLY DECIDED: ${tail(m.row.response, 500)}\nWHY IT MISSED: ${why}`;
  }).join('\n\n');
}

async function main() {
  applyCatalog(JSON.parse(readFileSync(LIVE_CATALOG, 'utf8')).providers, {});
  const db = new DatabaseSync(LIVE_DB, { readOnly: true });
  const msgsStmt = db.prepare('SELECT direction dir, source src, text, ts FROM messages WHERE session_id=? AND ts<=? ORDER BY ts DESC LIMIT 20');

  const baseline = activePlaybook();
  const baseSys = baseline.sys_answer || SYS_ANSWER;
  const all = loadRows(db);
  // deterministic split (no Math.random): even indices = train (propose from), odd = held-out (score on)
  const train = all.filter((_, i) => i % 2 === 0);
  const held = all.filter((_, i) => i % 2 === 1);
  console.log(`\nOPTIMIZE supervisor answer rubric — active v${baseline.version}.  corpus=${all.length} (train ${train.length} / held-out ${held.length})  answer=${args.model} judge=${args.judge} propose=${args['propose-model']}\n`);
  if (held.length < 6) { console.log('Not enough answered decisions to optimize reliably (need >= ~12). Aborting — accumulate more operator decisions first.'); db.close(); return; }

  // 1) baseline on BOTH splits (train misses feed the proposer; held-out is the gate)
  process.stderr.write('scoring baseline…\n');
  const baseTrain = await score(db, msgsStmt, baseSys, train, 'baseline/train');
  const baseHeld = await score(db, msgsStmt, baseSys, held, 'baseline/held');
  console.log(`baseline (held-out N=${baseHeld.N}):  match ${pct(baseHeld.match, baseHeld.N)}  match+partial ${pct(baseHeld.mop, baseHeld.N)}  escalate ${pct(baseHeld.esc, baseHeld.N)}`);

  if (!baseTrain.misses.length) { console.log('\nBaseline already matches every train decision — nothing to optimize.'); db.close(); return; }

  // 2) propose K candidate rubrics (diverse temperatures), EmbodiSkill-attributed, ACE-bounded
  const cases = casesBlock(baseTrain.misses);
  const proposeUser = `CURRENT RUBRIC:\n"""\n${baseSys}\n"""\n\nCASES THE CURRENT RUBRIC GOT WRONG (judge compared its answer to the operator's real reply):\n\n${cases}\n\nReturn JSON only.`;
  const temps = [0.3, 0.6, 0.9].slice(0, args.candidates);
  process.stderr.write(`proposing ${temps.length} candidate(s)…\n`);
  const proposals = await pool(temps, 3, async (t) => {
    let lastErr = 'no parseable rubric';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await call(args['propose-model'], [{ role: 'system', content: SYS_PROPOSE }, { role: 'user', content: proposeUser }], 4000, t, false);
        const rubric = extractRubric(text);
        if (rubric && rubric.length >= 200) {
          const changelog = (text.match(/CHANGELOG:\s*([\s\S]*?)(?:\nREVISED_RUBRIC|\n===|```|$)/i) || [])[1]?.trim() || '';
          const attribution = (text.match(/ATTRIBUTION:\s*([^\n]+)/i) || [])[1]?.trim() || '';
          return { temp: t, rubric, changelog, attribution };
        }
        lastErr = `unparseable (got ${rubric.length} chars)`;
      } catch (e) { lastErr = String(e.message || e); }
    }
    return { temp: t, error: lastErr };
  });

  // 3) score each candidate on the SAME held-out set; keep only if it beats baseline (SkillOpt)
  const kept = [];
  for (const p of proposals) {
    const cand = String(p.rubric || '').trim();
    if (!cand || cand.length < 200 || cand === baseSys) { console.log(`\n· candidate@${p.temp}: ${p.error ? 'proposer error: ' + p.error : 'no usable edit'} — skipped`); continue; }
    const s = await score(db, msgsStmt, cand, held, `cand@${p.temp}`);
    const dMatch = s.match_rate - baseHeld.match_rate;
    const dMop = s.mop_rate - baseHeld.mop_rate;
    const better = (s.match > baseHeld.match) || (s.match === baseHeld.match && s.mop > baseHeld.mop);
    console.log(`\n· candidate@${p.temp}: held-out match ${pct(s.match, s.N)} (Δ${(dMatch * 100).toFixed(1)}pts) · match+partial ${pct(s.mop, s.N)} (Δ${(dMop * 100).toFixed(1)}pts) · escalate ${pct(s.esc, s.N)}  ${better ? '✅ BEATS baseline' : '— not better'}`);
    console.log(`  changelog: ${tail(p.changelog || '(none)', 400)}`);
    if (better) {
      const evalJson = { baseline: { version: baseline.version, heldout_N: baseHeld.N, match: baseHeld.match, mop: baseHeld.mop, esc: baseHeld.esc }, candidate: { heldout_N: s.N, match: s.match, mop: s.mop, esc: s.esc, dMatch_pts: +(dMatch * 100).toFixed(1), dMop_pts: +(dMop * 100).toFixed(1) }, propose_temp: p.temp, attribution: p.attribution || null, judge: args.judge, answer_model: args.model, ts: new Date().toISOString() };
      const saved = savePlaybook({ sys_answer: cand, notes: `optimizer: +${(dMatch * 100).toFixed(1)}pts match on held-out N=${s.N} vs v${baseline.version} — ${tail(p.changelog || '', 160)}`, eval_json: evalJson });
      kept.push({ ...saved, dMatch, dMop, N: s.N });
      console.log(`  -> saved as INACTIVE playbook v${saved.version} (${saved.id})`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  if (kept.length) {
    kept.sort((a, b) => b.dMatch - a.dMatch);
    const best = kept[0];
    console.log(`${kept.length} candidate(s) beat baseline. Best: v${best.version} (+${(best.dMatch * 100).toFixed(1)}pts match on held-out N=${best.N}).`);
    console.log(`Review:   curl -sS http://127.0.0.1:8793/api/supervisor/playbook/${best.id}`);
    console.log(`Activate: curl -XPOST http://127.0.0.1:8793/api/supervisor/playbook/${best.id}/activate   (human apply-gate)`);
  } else {
    console.log('No candidate beat the baseline on held-out. Rubric kept as-is (this is the safe outcome — no reward-hacked edit shipped).');
  }
  db.close();
}

main().catch((e) => { console.error('optimize failed:', e); process.exit(1); });
