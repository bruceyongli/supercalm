// Decision-memory retrieval (Stage 1 RAG): find the operator's most similar PAST answered decisions
// and format them as precedents for the supervisor's ANSWER prompt, so it decides like the operator
// has before. Pure + db-INJECTED — no store import, no writes (the live corpus is read-only). The same
// function serves the live supervisor (store db) and the offline eval (read-only live db).
//
// Retrieval is in-JS BM25 over a bounded recent window of answered decisions — zero new deps, no FTS
// index written to the live DB, and fast enough at this corpus size (hundreds of rows).

const STOP = new Set(
  'the a an and or but for nor so yet of to in on at by with from into over under as is are was were be been being it its this that these those you your we our they them he she his her i me my mine do does did done can could should would will shall may might must not no yes if then else than what which who whom whose when where why how all any both each few more most other some such only own same too very just also out up down off about'.split(
    ' '
  )
);

function tokenize(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || []).filter((t) => !STOP.has(t));
}
function oneLine(s, max) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function situationOf(r) {
  return r.ask || r.question || r.summary || '';
}

// Pull a bounded recent window of answered decisions (genuine asks only), optionally before a cutoff
// (eval: prevents temporal leakage) and excluding a target id.
function candidates(db, { beforeTs, excludeId, pool = 600 } = {}) {
  const where = [
    "response IS NOT NULL AND trim(response) <> '' AND status='answered'",
    "category IN ('decision','action')",
    "substr(trim(response),1,1) <> '/'",
  ];
  const params = [];
  if (beforeTs) {
    where.push('asked_at < ?');
    params.push(beforeTs);
  }
  if (excludeId != null) {
    where.push('id <> ?');
    params.push(excludeId);
  }
  params.push(pool);
  return db
    .prepare(
      `SELECT id, project_id, project, asked_at, category, summary, question, ask, response
       FROM decisions WHERE ${where.join(' AND ')} ORDER BY asked_at DESC LIMIT ?`
    )
    .all(...params);
}

// Rank candidates against the query with BM25 (+ same-project boost, recency tiebreak); return top k
// with a positive score. Empty when nothing is relevant -> caller injects no precedents.
export function retrievePrecedents({ db, queryText, projectId = null, beforeTs = null, excludeId = null, k = 3, pool = 600, minScore = 10, relFloor = 0.45 } = {}) {
  const qTerms = [...new Set(tokenize(queryText))];
  if (!db || !qTerms.length) return [];
  const rows = candidates(db, { beforeTs, excludeId, pool });
  if (!rows.length) return [];

  const docs = rows.map((r) => tokenize(situationOf(r)));
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => {
    const n = df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };
  const k1 = 1.5;
  const b = 0.75;

  const scored = rows.map((r, i) => {
    const d = docs[i];
    const dl = d.length || 1;
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t);
      if (!f) continue;
      score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    if (projectId && r.project_id === projectId) score *= 1.25; // operator's precedent in THIS project is most relevant
    return { r, score };
  });

  // Precedent-confidence threshold (safety belt): require a real relevance bar AND keep only precedents
  // close to the best match, so a lone weak/tangential precedent isn't injected when nothing fits
  // (which otherwise dilutes the answer). Below the bar -> return nothing -> memory == baseline.
  const ranked = scored.filter((x) => x.score > 0).sort((a, b2) => b2.score - a.score || b2.r.asked_at - a.r.asked_at);
  if (!ranked.length) return [];
  const bar = Math.max(minScore, relFloor * ranked[0].score);
  return ranked
    .filter((x) => x.score >= bar)
    .slice(0, k)
    .map((x) => ({ project: x.r.project, situation: situationOf(x.r), response: x.r.response, asked_at: x.r.asked_at, score: Number(x.score.toFixed(3)) }));
}

export function formatPrecedents(rows) {
  if (!rows || !rows.length) return '';
  const lines = rows.map((r) => `• [${r.project || '?'}] ${oneLine(r.situation, 180)}\n  → OPERATOR DECIDED: ${oneLine(r.response, 240)}`);
  return (
    'OPERATOR_PRECEDENTS — how the operator decided in similar past situations. Prefer a precedent when it clearly applies; it outranks generic best practice. If none fit, ignore them:\n' +
    lines.join('\n')
  );
}
