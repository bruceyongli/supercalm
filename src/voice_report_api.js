// Voice reports — the route + sqlite script cache around the pure core (voice_report.js).
// Scripts are cached in sqlite (deploys restart the server constantly; a Map re-pays LLM tokens
// per restart). The fail-open sanitized text is NEVER cached — a retry should re-attempt polish.
import { createHash } from 'node:crypto';
import { route, json, readJson } from './server.js';
import { db, getSession } from './store.js';
import { buildScript, reportFocusText, splitParts, PROMPT_VERSION, MAX_INPUT, REPORT_CHAIN } from './voice_report.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS voice_scripts (
    key        TEXT PRIMARY KEY,
    session_id TEXT,
    script     TEXT NOT NULL,
    model      TEXT,
    source     TEXT,
    created_at INTEGER
  )
`);
const _get = db.prepare('SELECT script, model, source FROM voice_scripts WHERE key = ?');
const _put = db.prepare('INSERT OR REPLACE INTO voice_scripts (key, session_id, script, model, source, created_at) VALUES (?,?,?,?,?,?)');
const _prune = db.prepare('DELETE FROM voice_scripts WHERE key NOT IN (SELECT key FROM voice_scripts ORDER BY created_at DESC LIMIT 500)');
const _reportPrompts = db.prepare(`
  SELECT ts, text
  FROM messages
  WHERE session_id = ?
    AND direction = 'in'
    AND ts <= ?
    AND source IN ('text','text+attachments','task','voice','operator','operator-correction','phone','phone+attachments')
  ORDER BY ts DESC
  LIMIT 4
`);

const cacheKey = (sid, text, level, focus) =>
  createHash('sha256').update(`${sid}\n${String(text).trim()}\n${focus}`).digest('hex').slice(0, 32) + '|' + level + '|' + PROMPT_VERSION;

// A guided rewrite can take longer than the old 12-second first-tap budget. Do not start reading a
// 12k-character fallback and silently replace it with a 4-part summary on the next tap. Keep one
// generation job per report and let the client poll in a visible "tailoring" state until its ONE
// stable script is ready.
const PREPARE_WAIT_MS = Number(process.env.AIOS_VOICE_REPORT_PREPARE_WAIT_MS || 6500);
const GENERATION_DEADLINE_MS = Number(process.env.AIOS_VOICE_REPORT_GENERATION_DEADLINE_MS || 60000);
const JOB_RESULT_TTL_MS = 2 * 60_000;
const generationJobs = new Map(); // key -> Promise<{script,model,source,polished}>
const pending = Symbol('voice-report-pending');
const waitBudget = () => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(pending), PREPARE_WAIT_MS);
  timer.unref?.();
});

// Report-specific delivery hints for TTS engines that support speaking instructions. An explicit
// operator env override wins; Kokoro safely ignores the hint.
function ttsHints(level) {
  const engine = process.env.AIOS_TTS_REPORT_ENGINE || '';
  const voice = process.env.AIOS_TTS_REPORT_VOICE || '';
  const explicitInstruct = process.env.AIOS_TTS_REPORT_INSTRUCT || '';
  const instruct = explicitInstruct || (level === 'brief'
    ? 'Speak briskly and warmly. Emphasize the outcome and owner action. Use short natural pauses.'
    : level === 'verbatim'
      ? 'Read steadily and clearly with natural pauses. Keep technical names precise.'
      : 'Sound engaged and conversational, like a trusted engineer briefing one person. Emphasize spoken signposts and key conclusions, with natural attention-reset pauses.');
  if (!engine && !voice && !instruct) return null;
  const hints = {};
  if (engine) hints.engine = engine;
  if (voice) hints.voice = voice;
  if (instruct) hints.instruct = instruct.slice(0, 300);
  return hints;
}

route('POST', '/api/session/:id/voice-report', async (req, res, { id: sid }) => {
  const b = await readJson(req).catch(() => ({}));
  const session = getSession(sid);
  if (!session) return json(res, 404, { error: 'unknown session' }); // keep LLM spend scoped to real sessions
  const text = String(b.text || '').slice(0, MAX_INPUT);
  if (!text.trim()) return json(res, 400, { error: 'text required' });
  const level = b.level === 'brief' ? 'brief' : b.level === 'verbatim' ? 'verbatim' : 'full';
  const reportTs = Number(b.ts) || Date.now();
  const prompts = _reportPrompts.all(sid, reportTs).reverse();
  const focus = reportFocusText({ title: session.title || '', prompts });
  const key = cacheKey(sid, text, level, focus);
  const respond = (script, model, source, polished, cached) => {
    const parts = splitParts(script);
    const mode = level === 'brief' ? 'quick' : level === 'verbatim' ? 'read-all' : 'guided';
    const out = { ok: true, status: 'ready', mode, script, parts, words: script.split(/\s+/).length, model, polished, cached, source };
    const hints = ttsHints(level);
    if (hints) out.tts = hints;
    json(res, 200, out);
  };
  // Read-all is immediate, exact, and never cached: there is no model work to amortize.
  if (level === 'verbatim') {
    const r = await buildScript(text, level, { focus });
    return respond(r.script, r.model, r.source, r.polished, false);
  }
  const hit = _get.get(key);
  if (hit) return respond(hit.script, hit.model, hit.source, hit.source !== 'sanitized', true);
  const save = (r) => {
    try { _put.run(key, sid, r.script, r.model, r.source, Date.now()); _prune.run(); } catch {}
  };
  let job = generationJobs.get(key);
  if (!job) {
    job = buildScript(text, level, { deadlineMs: GENERATION_DEADLINE_MS, focus })
      .catch(async () => {
        const fallback = await buildScript(text, 'verbatim', { focus });
        return { ...fallback, source: 'sanitized' };
      })
      .then((result) => {
        if (result.source !== 'sanitized') save(result);
        return result;
      });
    generationJobs.set(key, job);
    job.finally(() => {
      const timer = setTimeout(() => {
        if (generationJobs.get(key) === job) generationJobs.delete(key);
      }, JOB_RESULT_TTL_MS);
      timer.unref?.();
    });
  }
  const r = await Promise.race([job, waitBudget()]);
  if (r === pending) {
    return json(res, 202, { ok: true, status: 'preparing', mode: level === 'brief' ? 'quick' : 'guided', retryAfterMs: 700 });
  }
  respond(r.script, r.model, r.source, r.polished, false);
});

console.log('[aios] voice-report ready (chain=' + REPORT_CHAIN.map((e) => e.model).join(',') + ')');
