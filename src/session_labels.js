// Cheap, cached, hierarchical LLM labeler for the session graph. The deterministic builder (session_space.js)
// gives accurate STRUCTURE (requests → subtasks → tool calls, cost, files); this adds MEANING on top:
//   - per request: {label, result, status, relation} — what it was about, how it ended, and how it relates
//     to the previous request (new / follow-up / rework after a problem / scope-change / aside)
//   - session: {headline, goal} — what the session ACTUALLY became, not the opening line
// It runs "on settle" (a request is labeled once it's complete — the next request arrived, or the session is
// idle/waiting), capped per pass, cached by request-text hash + a work signature so settled requests are
// never re-labeled. Falls back to the deterministic labels when absent. Reuses the summarizer's cheap model.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { db } from './store.js';
import { applyMigrations, ensureColumn } from './migrations.js';
import { now } from './util.js';
import { fleetKey, routeForModel } from './model_catalog.js';
import { priceUsage } from './usage_pricing.js';

// Default labeling model: a CHEAP, non-Claude model so labeling never competes with the user's Claude
// coding sessions for rate limits. The actual model is usually set per-instance in the config (label_meta),
// e.g. the local spark qwen — this is only the fallback when nothing is configured. Override with AIOS_LABEL_MODEL.
const MODEL_DEFAULT = process.env.AIOS_LABEL_MODEL || 'gemini-3.1-flash-lite';
// Pin a port only if explicitly overridden; otherwise resolve the proxy PORT from the chosen model so a
// non-claude model (gemini@8791, kimi@8790, spark-qwen@8792, …) reaches its own proxy instead of 404-ing.
const PORT_OVERRIDE = process.env.AIOS_LABEL_PORT ? Number(process.env.AIOS_LABEL_PORT) : null;
const MAX_PER_PASS = Number(process.env.AIOS_LABEL_MAX_PER_PASS || 4); // spread bursts across sweeps

db.exec(`
  CREATE TABLE IF NOT EXISTS session_labels (
    session_id TEXT NOT NULL,
    ref        TEXT NOT NULL,
    sig        TEXT,
    label      TEXT,
    result     TEXT,
    status     TEXT,
    relation   TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, ref)
  );
`);
// semantic grouping added later: feature (sub-component bucket) + task (the recurring task, shared across
// the rounds it took) — additive columns so existing installs migrate in place.
applyMigrations(db, [{
  id: '0101_session_labels_semantic_grouping',
  description: 'Add semantic feature and task grouping to session labels',
  up(conn) {
    ensureColumn(conn, 'session_labels', 'feature', 'TEXT');
    ensureColumn(conn, 'session_labels', 'task', 'TEXT');
  },
}]);
// global on/off + running usage meter (labeling spans ALL sessions, so the switch + cost are global).
// Default ON — it's cheap (haiku, cached, ~0 steady-state) — but the user can turn it off to stop spend.
db.exec(`
  CREATE TABLE IF NOT EXISTS label_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    usd REAL NOT NULL DEFAULT 0,
    updated_at INTEGER
  );
`);
// user-configurable knobs added later (model override, extra prompt, default view) — additive ALTERs so
// existing installs migrate in place.
applyMigrations(db, [{
  id: '0102_session_label_preferences',
  description: 'Add configurable model, prompt, and default view to session labeling',
  up(conn) {
    ensureColumn(conn, 'label_meta', 'model', 'TEXT');
    ensureColumn(conn, 'label_meta', 'prompt_extra', 'TEXT');
    ensureColumn(conn, 'label_meta', 'default_view', 'TEXT');
  },
}]);
db.prepare('INSERT OR IGNORE INTO label_meta (id, enabled) VALUES (1, 1)').run();
const _meta = db.prepare('SELECT * FROM label_meta WHERE id = 1');
const _setEnabled = db.prepare('UPDATE label_meta SET enabled = ?, updated_at = ? WHERE id = 1');
const _setModel = db.prepare('UPDATE label_meta SET model = ?, updated_at = ? WHERE id = 1');
const _setPrompt = db.prepare('UPDATE label_meta SET prompt_extra = ?, updated_at = ? WHERE id = 1');
const _setView = db.prepare('UPDATE label_meta SET default_view = ?, updated_at = ? WHERE id = 1');
const _addUsage = db.prepare('UPDATE label_meta SET calls = calls + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, usd = usd + ?, updated_at = ? WHERE id = 1');

const cfg = () => _meta.get() || {};
function currentModel() { const m = cfg().model; return (m && m.trim()) || MODEL_DEFAULT; }
function promptExtra() { return (cfg().prompt_extra || '').trim(); }

export function labelingEnabled() { return !!cfg().enabled; }
// full graph-agent config: the on/off + usage meter PLUS the configurable model / extra prompt / default view
export function labelConfig() {
  const m = cfg();
  return {
    enabled: !!m.enabled,
    model: m.model || '', model_default: MODEL_DEFAULT, model_active: currentModel(),
    prompt_extra: m.prompt_extra || '', default_view: m.default_view || '',
    calls: m.calls || 0, input_tokens: m.input_tokens || 0, output_tokens: m.output_tokens || 0,
    tokens: (m.input_tokens || 0) + (m.output_tokens || 0), usd: Math.round((m.usd || 0) * 1e6) / 1e6,
  };
}
export const labelStats = labelConfig; // back-compat alias (the /space payload + toggle route)
export function setLabeling(on) { _setEnabled.run(on ? 1 : 0, now()); return labelConfig(); }
export function setLabelConfig(p = {}) {
  if (typeof p.enabled === 'boolean') _setEnabled.run(p.enabled ? 1 : 0, now());
  if (typeof p.model === 'string') _setModel.run(p.model.trim().slice(0, 80) || null, now());
  if (typeof p.prompt_extra === 'string') _setPrompt.run(p.prompt_extra.slice(0, 1400) || null, now());
  if (typeof p.default_view === 'string' && ['3d', '2d', 'tree'].includes(p.default_view)) _setView.run(p.default_view, now());
  return labelConfig();
}
function recordUsage(env) {
  const u = env?.usage;
  if (!u) return;
  const cached = u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0;
  const input = u.prompt_tokens || u.input_tokens || 0;
  const output = u.completion_tokens || u.output_tokens || 0;
  // price the non-cached input at full rate + the cached portion at the cheaper cache-read rate
  const pr = priceUsage({ model: currentModel(), input_tokens: Math.max(0, input - cached), output_tokens: output, cache_read_input_tokens: cached });
  _addUsage.run(input, output, pr.estimated_cost_usd || 0, now());
}

const _allFor = db.prepare('SELECT * FROM session_labels WHERE session_id = ?');
const _upsert = db.prepare(`
  INSERT INTO session_labels (session_id, ref, sig, label, result, status, relation, feature, task, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(session_id, ref) DO UPDATE SET
    sig=excluded.sig, label=excluded.label, result=excluded.result, status=excluded.status,
    relation=excluded.relation, feature=excluded.feature, task=excluded.task, updated_at=excluded.updated_at
`);

function hash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const reqKey = (sys) => 'r' + hash(sys.detail || sys.label || sys.id);
// `g1:` = labeling schema version (bump to force a one-time re-label, e.g. when adding feature/task fields)
const workSig = (sys) => `g1:${sys.calls || 0}:${(sys.outcomes || []).length}:${sys.problems || 0}`;

// compact "what it did" from the deterministic clusters/turns — keeps the prompt tiny
function workSummary(sys) {
  const byCat = {};
  for (const c of sys.children || []) byCat[c.category] = (byCat[c.category] || 0) + (c.calls || c.count || 1);
  const parts = Object.entries(byCat).map(([k, v]) => `${k}×${v}`);
  const files = (sys.outcomes || []).slice(0, 8).join(', ');
  return `${parts.join(', ') || 'no tools'}${files ? `; files changed: ${files}` : ''}${sys.problems ? `; ${sys.problems} errors hit` : ''}`;
}

// Be a polite background citizen so labeling can NEVER pile load onto a busy/overloaded API:
//  - serialize ALL label model calls to concurrency 1 (many sessions fire labelSettled concurrently);
//  - on an overload / rate-limit signal, TRIP A BREAKER — stand the whole labeler down for a cooldown and
//    do NOT retry. Hammering 3× during a 429/529 is exactly the wrong move (it amplifies the overload).
//    Only a transient network blip gets one retry. labeling is non-urgent, so trickle + yield is correct.
const OVERLOAD_RX = /overloaded|rate.?limit|too many requests|quota|\b(429|529|503)\b/i;
const NETBLIP_RX = /fetch failed|timeout|timed out|ECONNREFUSED|ECONNRESET|socket hang up|EAI_AGAIN|\b(500|502|504)\b/i;
const BADMODEL_RX = /not[_ ]?found|unknown model|no such model|invalid model|\b404\b/i; // misconfigured model -> stand down, don't spam
// access revoked (fleet de-escalated the model / upstream 403, e.g. "Antigravity loadCodeAssist failed
// (403)") — same stand-down as a bad model: retrying every sweep produced thousands of log lines
const DENIED_RX = /\b403\b|forbidden|permission[_ ]denied|access denied/i;
const PAUSE_MS = Number(process.env.AIOS_LABEL_PAUSE_MS || 240000); // stand down 4 min after an overload
let pausedUntil = 0;
function tripBreaker(msg) {
  pausedUntil = now() + PAUSE_MS;
  console.error(`[aios] labeler paused ${Math.round(PAUSE_MS / 1000)}s — API overloaded: ${String(msg).slice(0, 120)}`);
}
// gate the whole labeler: enabled by the user AND not currently standing down after an overload
export function labelReady() { return labelingEnabled() && now() >= pausedUntil; }

let _gate = Promise.resolve(); // global mutex: at most ONE label model call in flight across all sessions
function serialize(fn) {
  const run = _gate.then(fn, fn);
  _gate = run.then(() => {}, () => {}); // swallow so the chain keeps going regardless of outcome
  return run;
}
function httpChat(body, key, port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: `Bearer ${key}` }, timeout: 30000 },
      (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve(Buffer.concat(ch).toString('utf8'))); }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('label timeout')));
    req.write(body);
    req.end();
  });
}
async function chatJson(messages, maxTokens = 320) {
  const key = await fleetKey();
  const route = routeForModel(currentModel()); // resolve the chosen model -> its own proxy port + upstream id
  const port = PORT_OVERRIDE || route.port || 8789;
  const body = Buffer.from(JSON.stringify({ model: route.model || currentModel(), temperature: 0, max_tokens: maxTokens, messages }));
  for (let i = 0; ; i++) {
    try {
      const raw = await serialize(() => httpChat(body, key, port)); // concurrency 1 process-wide
      const env = JSON.parse(raw);
      recordUsage(env); // meter tokens/$ spent on labeling (shown to the user; the switch can turn it off)
      if (env.error) throw new Error(env.error.message || JSON.stringify(env.error));
      let txt = (env.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const m = txt.match(/\{[\s\S]*\}/);
      return JSON.parse(m ? m[0] : txt);
    } catch (e) {
      const msg = String(e?.message || e);
      if (BADMODEL_RX.test(msg)) { tripBreaker(`model "${currentModel()}" not available: ${msg.slice(0, 80)}`); throw e; } // misconfig -> stand down
      if (DENIED_RX.test(msg)) { tripBreaker(`model "${currentModel()}" access denied (403) — pick another AIOS_LABEL_MODEL or restore fleet access`); throw e; } // access change -> stand down
      if (OVERLOAD_RX.test(msg)) { tripBreaker(msg); throw e; } // overloaded -> stand down, do NOT add load
      if (i < 1 && NETBLIP_RX.test(msg)) { await sleep(600); continue; } // one retry for a transient blip
      throw e;
    }
  }
}

const REQ_SYS = `You categorize ONE request inside a coding-agent session for a feature-grouped review tree. Return STRICT JSON: {"feature","task","label","result","status","relation"}.
- feature: the broad sub-component/area this request works on (2-4 words, e.g. "3D graph", "2D graph", "Flow view", "Labeling", "Layout & UI"). REUSE an EXACT feature name from the taxonomy provided when this request belongs to it; only create a new feature when none fit. Keep features BROAD — just a handful per session.
- task: the specific recurring task within the feature (3-6 words, e.g. "Dim 3D nodes"). Work that took MULTIPLE rounds MUST share ONE task name — REUSE the exact task name from the taxonomy when this request continues, fixes, or reworks it. A rework/follow-up keeps the SAME task name as the round it fixes.
- label: <= 6 words naming what THIS specific request did.
- result: <= 14 words on the outcome — what was delivered, or why it stalled.
- status: one of done | partial | blocked | abandoned.
- relation (to the PREVIOUS request): one of new | follow-up | rework | scope-change | aside.
Reuse taxonomy feature/task names VERBATIM so multi-round work merges into one task. Be concrete; never invent. JSON only.`;

const SESSION_SYS = `You summarize a whole coding session from its ordered list of request labels/results. Return STRICT JSON {"headline","goal"}.
- headline: <= 8 words capturing what the session ACTUALLY became across all requests (NOT just the first request).
- goal: one plain sentence — the real overall objective, accounting for scope changes and the main thread of work.
Be faithful to the list; don't invent. JSON only.`;

const STATUSES = ['done', 'partial', 'blocked', 'abandoned'];
const RELATIONS = ['new', 'follow-up', 'rework', 'scope-change', 'aside'];
// fold the user's optional extra instructions (config popover) into the system prompt, without letting it
// override the strict-JSON contract the parser depends on.
const withExtra = (base) => (promptExtra() ? `${base}\n\nAdditional instructions from the operator (honor these, but ALWAYS keep the exact JSON shape above):\n${promptExtra()}` : base);

async function labelRequest(sys, prevLabel, taxonomy) {
  const user = `EXISTING FEATURES & TASKS in this session (REUSE the exact name when this request fits one):
${taxonomy || '(none yet — you create the first feature/task)'}
PREVIOUS REQUEST: ${prevLabel || '(none — first request)'}
THIS REQUEST: ${(sys.detail || sys.label || '').slice(0, 700)}
AGENT RESPONSE (excerpt): ${(sys.text || '').slice(0, 900) || '(none captured)'}
WHAT IT DID: ${workSummary(sys)}
Return JSON only.`;
  const j = await chatJson([{ role: 'system', content: withExtra(REQ_SYS) }, { role: 'user', content: user }], 340);
  const label = String(j.label || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  return {
    feature: String(j.feature || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'General',
    task: String(j.task || '').replace(/\s+/g, ' ').trim().slice(0, 70) || label || 'Task',
    label,
    result: String(j.result || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    status: STATUSES.includes(j.status) ? j.status : 'done',
    relation: RELATIONS.includes(j.relation) ? j.relation : 'new',
  };
}

async function labelSession(labeled) {
  const list = labeled.map((x, i) => `${i + 1}. [${x.relation}/${x.status}] ${x.label} — ${x.result}`).join('\n');
  const j = await chatJson([{ role: 'system', content: withExtra(SESSION_SYS) }, { role: 'user', content: 'REQUESTS:\n' + list + '\nReturn JSON only.' }], 200);
  return { headline: String(j.headline || '').replace(/\s+/g, ' ').trim().slice(0, 90), goal: String(j.goal || '').replace(/\s+/g, ' ').trim().slice(0, 300) };
}

// ---- public: read cache + overlay onto a built space --------------------------------------------------
export function getLabels(sessionId) {
  const byRef = new Map();
  for (const row of _allFor.all(sessionId)) byRef.set(row.ref, row);
  return byRef;
}
// Overlay cached labels onto a built space. Returns the latest label `updated_at` seen, so the caller can
// fold it into `built_at` — labels land asynchronously AFTER a build, and the frontend re-renders only when
// built_at changes, so without this newly-arrived labels would sit invisible until the next structural rebuild.
export function applyLabels(space, sessionId) {
  if (!space) return 0;
  const byRef = getLabels(sessionId);
  let maxTs = 0;
  for (const sys of space.systems || []) {
    const row = byRef.get(reqKey(sys));
    if (row && row.label) {
      sys.llm = { label: row.label, result: row.result, status: row.status, relation: row.relation, feature: row.feature || null, task: row.task || null };
      if (row.updated_at > maxTs) maxTs = row.updated_at;
    }
  }
  const ss = byRef.get('session');
  if (ss) {
    space.llm_headline = ss.label || null;
    space.llm_goal = ss.result || null;
    if (ss.updated_at > maxTs) maxTs = ss.updated_at;
  }
  return maxTs;
}

// ---- on-settle labeling pass (called from the builder + sweep; cheap-model, capped, cached) -----------
// Labels up to MAX_PER_PASS settled requests per call (spreads bursts), then refreshes the session summary.
// Returns TRUE when the session is FULLY labeled (every settled request + the summary are current) so the
// caller can stop re-invoking; FALSE when work remains (more requests to label, or a model hiccup).
const inflight = new Set();
export async function labelSettled(session, space) {
  if (!session || !space) return true; // nothing we can do -> treat as done (don't churn)
  if (!labelReady()) return false; // disabled, or standing down after an API overload -> try again later
  if (inflight.has(session.id)) return false; // a pass is already running -> not done yet
  const systems = space.systems || [];
  if (!systems.length) return true;
  inflight.add(session.id);
  try {
    const byRef = getLabels(session.id);
    const settledMax = session.status === 'waiting' || session.status === 'exited' ? systems.length : systems.length - 1; // last request only once the session settles
    // running feature->tasks taxonomy from already-labeled requests, so new requests REUSE names (rounds merge)
    const tax = new Map();
    for (const r of byRef.values()) { if (r.feature) { if (!tax.has(r.feature)) tax.set(r.feature, new Set()); if (r.task) tax.get(r.feature).add(r.task); } }
    const taxStr = () => [...tax.entries()].map(([f, ts]) => `- ${f}: ${[...ts].join(' · ') || '(none yet)'}`).join('\n') || null;
    let calls = 0;
    let changed = false;
    for (let i = 0; i < settledMax && calls < MAX_PER_PASS; i++) {
      const sys = systems[i];
      const ref = reqKey(sys);
      const sig = workSig(sys);
      const row = byRef.get(ref);
      if (row && row.sig === sig) continue; // already labeled at this amount of work
      try {
        // best available summary of the previous request (its LLM label if cached, else the raw first-line)
        const prevLabel = i > 0 ? (byRef.get(reqKey(systems[i - 1]))?.label || systems[i - 1].label || null) : null;
        const lab = await labelRequest(sys, prevLabel, taxStr());
        if (lab.label) {
          _upsert.run(session.id, ref, sig, lab.label, lab.result, lab.status, lab.relation, lab.feature, lab.task, now());
          byRef.set(ref, { ref, sig, ...lab });
          if (lab.feature) { if (!tax.has(lab.feature)) tax.set(lab.feature, new Set()); if (lab.task) tax.get(lab.feature).add(lab.task); } // grow taxonomy
          calls++;
          changed = true;
        }
      } catch (e) {
        console.error('[aios] label request failed:', e.message);
        return false; // model trouble -> not done; try next sweep
      }
    }
    // refresh the session headline/goal when the set of request labels changed
    const labeled = systems.map((s) => byRef.get(reqKey(s))).filter((r) => r && r.label);
    let summaryCurrent = true;
    if (labeled.length) {
      const sig = hash(labeled.map((r) => r.ref + r.label).join('|'));
      const ss = byRef.get('session');
      if (changed || !ss || ss.sig !== sig) {
        try {
          const s = await labelSession(labeled);
          if (s.headline) {
            _upsert.run(session.id, 'session', sig, s.headline, s.goal, 'done', 'new', null, null, now());
            byRef.set('session', { ref: 'session', sig, label: s.headline, result: s.goal });
          } else summaryCurrent = false;
        } catch (e) {
          console.error('[aios] label session failed:', e.message);
          summaryCurrent = false;
        }
      }
    }
    // fully labeled? every settled request carries a current-sig label and the summary is up to date
    let pending = 0;
    for (let i = 0; i < settledMax; i++) { const r = byRef.get(reqKey(systems[i])); if (!r || r.sig !== workSig(systems[i])) pending++; }
    return pending === 0 && summaryCurrent;
  } finally {
    inflight.delete(session.id);
  }
}
