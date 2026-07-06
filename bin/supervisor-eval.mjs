#!/usr/bin/env node
// Supervisor replay-eval.
//
// Replays historical ANSWERED decisions from the LIVE corpus (read-only) through the supervisor's exact
// ANSWER prompt, BLIND (operator's reply withheld), then LLM-judges whether the supervisor's answer
// matches what the operator actually did.
//
//   --pairs   MATCHED-PAIRS: score EACH decision by BOTH arms (baseline = no memory, memory = RAG
//             precedents) so the lift is apples-to-apples on an identical denominator, with pairwise
//             wins/regressions + McNemar. Leakage-guarded (precedents only from before each decision,
//             target excluded). Writes a committed markdown summary.
//   (default) single arm; add --memory for the memory arm alone.
//
// Usage:
//   node bin/supervisor-eval.mjs --pairs [--limit 200] [--model gemini-pro-agent]
//        [--judge claude-haiku-4-5] [--category decision,action|all] [--concurrency 6] [--temp 0]
//        [--exclude sid,sid] [--outmd docs/supervisor-evalmem-results.md] [--verbose]
// Reads the live data/aios.db read-only; never writes the live corpus. JSON -> data/eval/.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyCatalog, routeForModel } from '../src/model_catalog.js';
import { callProxyModel, parseJsonObject } from '../src/agents/model.js';
import { SYS_ANSWER, CALIBRATION_ADDENDUM, buildAnswerUserText } from '../src/agents/answer_prompt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DB = process.env.AIOS_EVAL_DB || join(REPO, 'data', 'aios.db');
const LIVE_CATALOG = process.env.AIOS_EVAL_CATALOG || join(REPO, 'data', 'model_catalog.json');

function parseArgs(argv) {
  const a = { limit: 200, model: 'gemini-pro-agent', judge: 'claude-haiku-4-5', category: 'decision,action', concurrency: 6, temp: '0', memory: false, live: false, calibrate: false, pairs: false, verbose: false, outmd: 'docs/supervisor-evalmem-results.md' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--memory') a.memory = true;
    else if (k === '--live') a.live = true;
    else if (k === '--calibrate') a.calibrate = true;
    else if (k === '--pairs') a.pairs = true;
    else if (k === '--verbose') a.verbose = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  a.limit = Number(a.limit) || 200;
  a.concurrency = Number(a.concurrency) || 6;
  a.retries = a.retries == null ? 5 : Number(a.retries);
  a.temp = Number(a.temp);
  a.exclude = (a.exclude || process.env.AIOS_EVAL_EXCLUDE_SESSIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
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
- "offtopic": B is not actually an answer to the situation (e.g. a brand-new unrelated instruction, or just "/compact"); exclude from scoring.
Return STRICT minified JSON only: {"verdict":"match|partial|mismatch|offtopic","reason":"<one short sentence>"}`;

async function call(model, messages, maxTokens) {
  const r = await callProxyModel(routeForModel(model), messages, { json: true, temperature: args.temp, maxTokens, retries: args.retries });
  return r.content;
}

function recentFor(msgsStmt, row) {
  return msgsStmt.all(row.session_id, row.asked_at).reverse().map((m) => ({ dir: m.dir, src: m.src, text: tail(m.text, 1500) }));
}

// One arm. `treat` = { memoryMod, liveMod } (both null => baseline). Returns the judged outcome.
// Leakage-guarded: precedents and live signals are drawn only from BEFORE this decision (beforeTs).
async function runArm(db, msgsStmt, treat, row) {
  let precedents = '';
  if (treat.memoryMod) {
    const pre = treat.memoryMod.retrievePrecedents({
      db,
      queryText: [row.ask, row.question, row.summary].filter(Boolean).join(' \n '),
      projectId: row.project_id,
      beforeTs: row.asked_at,
      excludeId: row.id,
      k: 3,
    });
    precedents = treat.memoryMod.formatPrecedents(pre);
  }
  let liveContext = '';
  if (treat.liveMod) {
    liveContext = treat.liveMod.formatLiveContext(treat.liveMod.recentOperatorSignals({ db, sessionId: row.session_id, beforeTs: row.asked_at }));
  }
  const userText = buildAnswerUserText({
    doc: '',
    question: row.question || row.summary || '',
    category: row.category,
    summary: row.summary,
    recent_messages: recentFor(msgsStmt, row),
    terminal_tail: row.ask || '',
    action: row.category === 'action',
    precedents,
    liveContext,
  });
  const sys = treat.calibrate ? SYS_ANSWER + '\n\n' + CALIBRATION_ADDENDUM : SYS_ANSWER;
  let parsed;
  try {
    parsed = safeParse(await call(args.model, [{ role: 'system', content: sys }, { role: 'user', content: userText }], 1500));
  } catch (e) {
    return { action: 'error', error: String(e.message || e).slice(0, 120) };
  }
  if (!parsed) return { action: 'error', error: 'unparsed answer' };
  if (parsed.action === 'escalate' || !String(parsed.answer || '').trim()) return { action: 'escalate', reason: tail(parsed.reason || '', 160) };
  const sup = String(parsed.answer).trim();
  let j;
  try {
    const judgeUser = `SITUATION:\n${tail(row.ask || row.question || row.summary || '', 2000)}\n\nA) SUPERVISOR PROPOSED:\n${tail(sup, 1500)}\n\nB) OPERATOR ACTUALLY REPLIED:\n${tail(row.response || '', 1500)}\n\nReturn JSON only.`;
    j = safeParse(await call(args.judge, [{ role: 'system', content: SYS_JUDGE }, { role: 'user', content: judgeUser }], 300));
  } catch (e) {
    return { action: 'error', error: 'judge: ' + String(e.message || e).slice(0, 110) };
  }
  if (!j) return { action: 'error', error: 'unparsed judge' };
  return { action: 'answer', verdict: j.verdict || 'mismatch', reason: tail(j.reason || '', 160), supervisor: tail(sup, 260) };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
        if (!args.verbose) process.stderr.write(`\r  ${++done}/${items.length}   `);
      }
    })
  );
  if (!args.verbose) process.stderr.write('\n');
  return out;
}

function loadRows(db) {
  const cats = args.category === 'all' ? ['decision', 'action', 'review'] : args.category.split(',').map((s) => s.trim());
  const ph = cats.map(() => '?').join(',');
  const exPh = args.exclude.length ? ` AND session_id NOT IN (${args.exclude.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(
      `SELECT id, session_id, project_id, project, tool, model, asked_at, category, summary, question, ask, response
       FROM decisions
       WHERE response IS NOT NULL AND trim(response) <> '' AND status='answered'
         AND category IN (${ph}) AND substr(trim(response),1,1) <> '/'${exPh}
       ORDER BY asked_at DESC LIMIT ?`
    )
    .all(...cats, ...args.exclude, args.limit);
  return { cats, rows };
}

const Q = { match: 2, partial: 1, mismatch: 0 }; // escalate => 0
const quality = (arm) => (arm.action === 'answer' ? Q[arm.verdict] ?? 0 : 0);
const isMatch = (arm) => arm.action === 'answer' && arm.verdict === 'match';
const isMOP = (arm) => arm.action === 'answer' && (arm.verdict === 'match' || arm.verdict === 'partial');

async function buildTreatment() {
  // default treatment = memory (back-compat) only when NO flag is chosen; otherwise honor the flags.
  const wantMem = args.memory || (!args.memory && !args.live && !args.calibrate);
  return {
    memoryMod: wantMem ? await import('../src/agents/decision_memory.js') : null,
    liveMod: args.live ? await import('../src/agents/live_context.js') : null,
    calibrate: args.calibrate,
    label: [wantMem && 'memory', args.live && 'live', args.calibrate && 'calibrate'].filter(Boolean).join('+') || 'treatment',
  };
}

async function runPairs(db, msgsStmt) {
  const treat = await buildTreatment();
  const base = { memoryMod: null, liveMod: null, calibrate: false };
  const { cats, rows } = loadRows(db);
  console.log(`\nMATCHED-PAIRS replay-eval: ${rows.length} decisions [${cats.join(',')}]  treatment=${treat.label}  answer=${args.model}  judge=${args.judge}  temp=${args.temp}\n`);
  const pairs = await pool(rows, args.concurrency, async (row) => {
    const baseRes = await runArm(db, msgsStmt, base, row);
    const mem = await runArm(db, msgsStmt, treat, row);
    return { row, base: baseRes, mem };
  });

  // valid pair = neither arm errored, and no answered arm was judged offtopic (operator reply was noise)
  const valid = pairs.filter((p) => p.base.action !== 'error' && p.mem.action !== 'error' && p.base.verdict !== 'offtopic' && p.mem.verdict !== 'offtopic');
  const N = valid.length;
  const sum = (f) => valid.reduce((a, p) => a + (f(p) ? 1 : 0), 0);
  const bMatch = sum((p) => isMatch(p.base));
  const mMatch = sum((p) => isMatch(p.mem));
  const bMOP = sum((p) => isMOP(p.base));
  const mMOP = sum((p) => isMOP(p.mem));
  const bEsc = sum((p) => p.base.action === 'escalate');
  const mEsc = sum((p) => p.mem.action === 'escalate');
  const bAns = sum((p) => p.base.action === 'answer');
  const mAns = sum((p) => p.mem.action === 'answer');
  const wins = sum((p) => quality(p.mem) > quality(p.base));
  const regress = sum((p) => quality(p.mem) < quality(p.base));
  const ties = N - wins - regress;
  // McNemar on strict match: b = base-match-only (regressions), c = mem-match-only (gains)
  const b = sum((p) => isMatch(p.base) && !isMatch(p.mem));
  const c = sum((p) => !isMatch(p.base) && isMatch(p.mem));

  const summary = {
    ts: new Date().toISOString(),
    config: { mode: 'matched-pairs', treatment: treat.label, limit: args.limit, category: cats, model: args.model, judge: args.judge, temp: args.temp, exclude: args.exclude },
    totals: { rows: rows.length, valid: N, errored: pairs.length - pairs.filter((p) => p.base.action !== 'error' && p.mem.action !== 'error').length, offtopic_excluded: pairs.filter((p) => (p.base.verdict === 'offtopic' || p.mem.verdict === 'offtopic')).length },
    baseline: { match: bMatch, match_rate: pct(bMatch, N), mop: bMOP, mop_rate: pct(bMOP, N), escalate: bEsc, escalate_rate: pct(bEsc, N), answered: bAns, match_rate_answered: pct(bMatch, bAns) },
    memory: { match: mMatch, match_rate: pct(mMatch, N), mop: mMOP, mop_rate: pct(mMOP, N), escalate: mEsc, escalate_rate: pct(mEsc, N), answered: mAns, match_rate_answered: pct(mMatch, mAns) },
    pairwise: { wins, regressions: regress, ties, net: wins - regress, mcnemar_b_baseOnlyMatch: b, mcnemar_c_memOnlyMatch: c },
  };

  // console
  console.log('── Matched-pairs (identical N) ────────────────');
  console.log(`valid pairs N:    ${N}   (rows ${rows.length}, offtopic/errored excluded)`);
  console.log(`              ${'baseline'.padEnd(12)} ${treat.label.padEnd(12)}`);
  console.log(`match:        ${summary.baseline.match_rate.padEnd(12)} ${summary.memory.match_rate.padEnd(12)} (${bMatch} -> ${mMatch})`);
  console.log(`match+partial:${summary.baseline.mop_rate.padEnd(12)} ${summary.memory.mop_rate.padEnd(12)} (${bMOP} -> ${mMOP})`);
  console.log(`escalate:     ${summary.baseline.escalate_rate.padEnd(12)} ${summary.memory.escalate_rate.padEnd(12)} (${bEsc} -> ${mEsc})`);
  console.log(`\npairwise:  wins ${wins}  regressions ${regress}  ties ${ties}  (net ${wins - regress})`);
  console.log(`McNemar:   base-only-match b=${b}  mem-only-match c=${c}  (gains vs regressions on strict match)`);

  // examples: wins (esp. escalate/mismatch -> match), and regressions
  const winEx = valid.filter((p) => quality(p.mem) > quality(p.base)).sort((x, y) => quality(y.mem) - quality(y.base) - (quality(x.mem) - quality(x.base))).slice(0, 6);
  const regEx = valid.filter((p) => quality(p.mem) < quality(p.base)).slice(0, 4);
  const fmtEx = (p) => {
    const sit = tail(p.row.ask || p.row.question || p.row.summary || '', 220);
    const arm = (a) => (a.action === 'answer' ? `${a.verdict}: ${tail(a.supervisor, 200)}` : a.action === 'escalate' ? 'escalated' : 'error');
    return `- **[${p.row.project || '?'}]** ${sit}\n  - baseline → ${arm(p.base)}\n  - ${treat.label} → ${arm(p.mem)}\n  - operator actually → ${tail(p.row.response, 220)}`;
  };

  const T = treat.label;
  const md = `# Supervisor living-context — matched-pairs eval (treatment: ${T})

_Generated ${summary.ts} on branch \`feat/supervisor-evalmem\` (worktree, read-only live corpus). flags default OFF; nothing deployed._

Each genuine answered decision is scored by **both** arms — baseline (frozen doc + transcript only) and
**${T}** (decision-memory precedents and/or live-context staleness reconciliation) — apples-to-apples on
an identical denominator. Leakage-guarded: precedents and live signals are drawn only from **before**
each target, and the target itself is excluded.

**Config:** N=${N} valid pairs (of ${rows.length} ${cats.join('+')} decisions; offtopic/errored excluded), answer model \`${args.model}\`, judge \`${args.judge}\`, temperature ${args.temp}, excluded sessions: ${args.exclude.join(', ') || '(none)'}.

## Result (same ${N} decisions, both arms)

| metric | baseline | ${T} | Δ |
|---|---|---|---|
| **match** | ${summary.baseline.match_rate} (${bMatch}) | **${summary.memory.match_rate} (${mMatch})** | ${(((mMatch - bMatch) / (N || 1)) * 100).toFixed(1)}pts |
| match + partial | ${summary.baseline.mop_rate} (${bMOP}) | **${summary.memory.mop_rate} (${mMOP})** | ${(((mMOP - bMOP) / (N || 1)) * 100).toFixed(1)}pts |
| escalate (declined) | ${summary.baseline.escalate_rate} (${bEsc}) | ${summary.memory.escalate_rate} (${mEsc}) | ${(((mEsc - bEsc) / (N || 1)) * 100).toFixed(1)}pts |

**Pairwise:** ${T} strictly better on **${wins}** decisions, strictly worse on **${regress}**, tied on ${ties} → **net +${wins - regress}**.
**McNemar (strict match):** gains c=${c}, regressions b=${b}.

## Example wins (baseline escalated/missed → memory matched)
${winEx.map(fmtEx).join('\n\n') || '_(none)_'}

## Regressions (memory worse — for honesty)
${regEx.map(fmtEx).join('\n\n') || '_(none)_'}

## Caveats
- Single-operator corpus; judge is itself an LLM (temp ${args.temp}); historical items had no supervision doc (context-only floor).
- ${args.exclude.length ? 'Excludes this task’s own coordinator/self sessions (their meta-instructions are not real agent→operator asks).' : 'No sessions excluded.'}

## Reproduce
\`\`\`
node bin/supervisor-eval.mjs --pairs --limit ${args.limit} --category ${cats.join(',')} \\
  --model ${args.model} --judge ${args.judge} --temp ${args.temp}${args.exclude.length ? ' \\\n  --exclude ' + args.exclude.join(',') : ''}
\`\`\`
`;

  const outMd = join(ROOT, args.outmd);
  mkdirSync(dirname(outMd), { recursive: true });
  writeFileSync(outMd, md);
  const outDir = join(ROOT, 'data', 'eval');
  mkdirSync(outDir, { recursive: true });
  const outJson = join(outDir, `pairs-${Date.now()}.json`);
  writeFileSync(outJson, JSON.stringify({ summary, pairs: valid.map((p) => ({ id: p.row.id, project: p.row.project, base: p.base, mem: p.mem, operator: tail(p.row.response, 300) })) }, null, 2));
  console.log(`\nwrote ${outMd}\nwrote ${outJson}`);
}

async function runSingle(db, msgsStmt) {
  const treat = { memoryMod: args.memory ? await import('../src/agents/decision_memory.js') : null, liveMod: args.live ? await import('../src/agents/live_context.js') : null, calibrate: args.calibrate };
  const { cats, rows } = loadRows(db);
  console.log(`\nReplay-eval: ${rows.length} decisions [${cats.join(',')}]  answer=${args.model}  judge=${args.judge}  memory=${args.memory ? 'ON' : 'off'} live=${args.live ? 'ON' : 'off'}\n`);
  const results = await pool(rows, args.concurrency, async (row) => ({ id: row.id, category: row.category, ...(await runArm(db, msgsStmt, treat, row)), operator: tail(row.response, 220) }));
  const answered = results.filter((r) => r.action === 'answer');
  const scored = answered.filter((r) => r.verdict !== 'offtopic');
  const m = scored.filter((r) => r.verdict === 'match').length;
  const p = scored.filter((r) => r.verdict === 'partial').length;
  console.log('── Results ──');
  console.log(`evaluated ${results.length}  escalated ${results.filter((r) => r.action === 'escalate').length}  errors ${results.filter((r) => r.action === 'error').length}  offtopic ${answered.length - scored.length}  scored ${scored.length}`);
  console.log(`MATCH ${pct(m, scored.length)} (${m}/${scored.length})  match-or-partial ${pct(m + p, scored.length)}`);
  const outDir = join(ROOT, 'data', 'eval');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `single-${args.memory ? 'memory' : 'baseline'}-${Date.now()}.json`), JSON.stringify(results, null, 2));
}

async function main() {
  applyCatalog(JSON.parse(readFileSync(LIVE_CATALOG, 'utf8')).providers, {});
  const db = new DatabaseSync(LIVE_DB, { readOnly: true });
  const msgsStmt = db.prepare(`SELECT direction dir, source src, text, ts FROM messages WHERE session_id=? AND ts<=? ORDER BY ts DESC LIMIT 20`);
  if (args.pairs) await runPairs(db, msgsStmt);
  else await runSingle(db, msgsStmt);
}

main().catch((e) => {
  console.error('eval failed:', e);
  process.exit(1);
});
