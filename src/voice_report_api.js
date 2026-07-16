// Voice reports — the route + sqlite script cache around the pure core (voice_report.js).
// Scripts are cached in sqlite (deploys restart the server constantly; a Map re-pays LLM tokens
// per restart). The fail-open sanitized text is NEVER cached — a retry should re-attempt polish.
import { createHash } from 'node:crypto';
import { route, json, readJson } from './server.js';
import { db, getSession } from './store.js';
import { buildScript, splitParts, PROMPT_VERSION, MAX_INPUT, REPORT_CHAIN } from './voice_report.js';

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

const cacheKey = (text, level) =>
  createHash('sha256').update(String(text).trim()).digest('hex').slice(0, 32) + '|' + level + '|' + PROMPT_VERSION;

// Optional TTS hints (only when the operator opted into the qwen CustomVoice styling via env) —
// default deployments return nothing and the client speaks with the standard Kokoro voice.
function ttsHints() {
  const engine = process.env.AIOS_TTS_REPORT_ENGINE || '';
  const voice = process.env.AIOS_TTS_REPORT_VOICE || '';
  const instruct = process.env.AIOS_TTS_REPORT_INSTRUCT || '';
  if (!engine && !voice && !instruct) return null;
  const hints = {};
  if (engine) hints.engine = engine;
  if (voice) hints.voice = voice;
  if (instruct) hints.instruct = instruct.slice(0, 300);
  return hints;
}

route('POST', '/api/session/:id/voice-report', async (req, res, { id: sid }) => {
  const b = await readJson(req).catch(() => ({}));
  if (!getSession(sid)) return json(res, 404, { error: 'unknown session' }); // keep LLM spend scoped to real sessions
  const text = String(b.text || '').slice(0, MAX_INPUT);
  if (!text.trim()) return json(res, 400, { error: 'text required' });
  const level = b.level === 'brief' ? 'brief' : 'full'; // honored: buildScript(level) → targetFor gives brief a ~40-80 word / 30s digest; cache key includes level
  const key = cacheKey(text, level);
  const respond = (script, model, source, polished, cached) => {
    const parts = splitParts(script);
    const out = { ok: true, script, parts, words: script.split(/\s+/).length, model, polished, cached, source };
    const hints = ttsHints();
    if (hints) out.tts = hints;
    json(res, 200, out);
  };
  const hit = _get.get(key);
  if (hit) return respond(hit.script, hit.model, hit.source, hit.source !== 'sanitized', true);
  const save = (r) => {
    try { _put.run(key, sid, r.script, r.model, r.source, Date.now()); _prune.run(); } catch {}
  };
  const r = await buildScript(text, level, { onLate: save }); // a late polish still lands in the cache
  if (r.source !== 'sanitized') save(r);
  respond(r.script, r.model, r.source, r.polished, false);
});

console.log('[aios] voice-report ready (chain=' + REPORT_CHAIN.map((e) => e.model).join(',') + ')');
