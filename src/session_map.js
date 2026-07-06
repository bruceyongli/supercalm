import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LOG_DIR } from './config.js';
import { db, eventsFor, getProject, messagesFor } from './store.js';
import { now, stripAnsi } from './util.js';
import { usageForSession } from './usage_store.js';
import { fleetKey } from './model_catalog.js';

const MAP_VERSION = 3; // v3 = request-spine + per-request cost + blocker/active for semantic-zoom map; v1/v2 still render
const DEFAULT_GENERATE = process.env.AIOS_MAP_GENERATE_TARGET || 'antigravity:gemini-pro-agent';
const DEFAULT_UPDATE = process.env.AIOS_MAP_UPDATE_TARGET || 'spark:qwen36-a3b-nvfp4-marlin';

db.exec(`
  CREATE TABLE IF NOT EXISTS session_maps (
    session_id    TEXT PRIMARY KEY,
    version       INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'ready',
    mode          TEXT,
    target        TEXT,
    model         TEXT,
    port          INTEGER,
    generated_at  INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    map_json      TEXT,
    error         TEXT,
    raw           TEXT
  );
`);

const _getMap = db.prepare('SELECT * FROM session_maps WHERE session_id = ?');
const _upsertMap = db.prepare(`
  INSERT INTO session_maps (
    session_id, version, status, mode, target, model, port, generated_at, updated_at, map_json, error, raw
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET
    version=excluded.version,
    status=excluded.status,
    mode=excluded.mode,
    target=excluded.target,
    model=excluded.model,
    port=excluded.port,
    generated_at=COALESCE(session_maps.generated_at, excluded.generated_at),
    updated_at=excluded.updated_at,
    map_json=excluded.map_json,
    error=excluded.error,
    raw=excluded.raw
`);

// `context` = the model's total window (input+output share it). Conservative lower bounds; the prompt
// budgeter in generateSessionMap reserves output then slices input to fit, so smaller windows (the
// local Spark model is only 8k) no longer overflow.
export const MAP_TARGETS = {
  generate: [
    { id: 'antigravity:gemini-pro-agent', label: 'Best: Gemini Pro via Antigravity', port: 8791, model: 'gemini-pro-agent', proxy: 'antigravity', maxTokens: 7000, context: 128000 },
    { id: 'codex:gpt-5.5', label: 'Best: GPT-5.5 via Codex', port: 8788, model: 'gpt-5.5', proxy: 'codex', maxTokens: 7000, context: 128000 },
    { id: 'claude:claude-opus-4-8', label: 'Best: Claude Opus 4.8', port: 8789, model: 'claude-opus-4-8', proxy: 'claude', maxTokens: 7000, context: 180000 },
    { id: 'aliyun:qwen3.7-max', label: 'Best Chinese: Qwen Max', port: 8790, model: 'qwen3.7-max', proxy: 'aliyun', maxTokens: 7000, context: 32000 },
  ],
  update: [
    { id: 'spark:qwen36-a3b-nvfp4-marlin', label: 'Cheap/local: Spark Qwen', port: 8792, model: 'qwen36-a3b-nvfp4-marlin', proxy: 'spark', maxTokens: 4500, context: 8192 },
    { id: 'antigravity:gemini-3.1-flash-lite', label: 'Cheap: Gemini Flash Lite', port: 8791, model: 'gemini-3.1-flash-lite', proxy: 'antigravity', maxTokens: 5000, context: 128000 },
    { id: 'codex:gpt-5.4-mini', label: 'Cheap: GPT-5.4 mini', port: 8788, model: 'gpt-5.4-mini', proxy: 'codex', maxTokens: 5000, context: 128000 },
    { id: 'claude:claude-haiku-4-5', label: 'Cheap: Claude Haiku', port: 8789, model: 'claude-haiku-4-5', proxy: 'claude', maxTokens: 5000, context: 180000 },
    { id: 'aliyun:qwen3.6-flash', label: 'Cheap: Qwen Flash', port: 8790, model: 'qwen3.6-flash', proxy: 'aliyun', maxTokens: 5000, context: 32000 },
  ],
};

const SYS = `You are Supercalm Session Cartographer. Map ONE autonomous coding-agent session as a CAUSAL GRAPH that a human supervisor can triage in seconds — a story of cause and effect, NOT a list of categories.

The human's questions, in priority order — build the map to answer these:
1. Do I need to act right now? (is it blocked or waiting on me, or just working?)
2. What decision needs me, and what's the context to decide?
3. What actually changed, and can I trust it — VERIFIED by a diff/test/command vs only CLAIMED by the agent?
4. Is it still on track to the goal, or drifting?
5. What's at risk?

THE STRUCTURE — a request-centric story. The USER's own requests are the BACKBONE (a chronological spine), because the user recognizes their own asks best. Every request branches into its natural flow: the request → the discussion/exploration it triggered → the decision reached → what was DELIVERED, or what unexpected/new factor BLOCKED or stopped it. Build the map so that reading just the spine top-to-bottom tells the whole story; the per-request detail is the zoom-in.

Return STRICT JSON only (no markdown), this exact shape:
{
  "headline": "<= 8 word title",
  "state": "working|waiting|blocked|done|unknown",
  "goal": "the user's overall ask, plain language, one sentence",
  "on_track": "on_track|drifting|unknown",
  "trust": "one line: what is VERIFIED (diff/tests/commits/output) vs only CLAIMED by the agent",
  "needs_you": null,
  "blocker": null,
  "active_node_id": "<id of the request/node that is happening NOW ('you are here'), or null>",
  "nodes": [
    { "id": "n1",
      "role": "ask|action|outcome|problem|decision",
      "label": "<= 8 words",
      "state": "done|active|blocked|open|resolved|pending|unknown",
      "evidence": "verified|claimed|none",
      "needs_human": false,
      "detail": "1-2 sentences: what it is and WHY it happened",
      "result": "(ask nodes ONLY) <= 10 words: what this request ultimately produced — 'delivered X' or 'blocked by Y'",
      "cost": { "elapsed": "human duration or null", "tokens": 0, "usd": 0 } }
  ],
  "edges": [ { "from": "n1", "to": "n2", "rel": "led_to|produced|raised|blocks|resolves|threatens" } ]
}

needs_you: if the agent is waiting on the operator, { "node_id": "<decision id>", "summary": "what input is needed", "why": "what is blocked until they answer" }, else null.
blocker: if work is STOPPED by an unexpected or newly-discovered factor (not a normal pending decision), { "node_id": "<problem id>", "summary": "what unexpected thing stopped it", "why": "what it blocks" }, else null.

Node roles: ask = a user request (the spine); action = something the agent did; outcome = something that changed (file/test/commit/deploy); problem = an error, risk, or blocker; decision = a fork or open question.
Edge relations connect cause to effect: an action PRODUCED an outcome; an action or problem RAISED a decision; a decision or problem BLOCKS work; a problem THREATENS an outcome; a decision RESOLVES a problem; one step LED_TO the next.

Rules:
- The spine: each 'ask' is a real user request, in time order, chained ask->ask with led_to. Give every ask a self-contained 'label' + 'result' so the zoomed-out spine alone reads as the story. Estimate each ask's 'cost' from the timestamped usage samples + message times (conservative; tokens/usd may be 0 if unknown).
- Per request, branch: ask -(led_to/raised)-> the discussion/decision -(produced)-> the outcome, OR -(blocks/threatens)-> the problem that stopped it. Causality over taxonomy — never bucket by type.
- 'decision' is needs_human=true + state=open ONLY if the agent is currently waiting on the operator; the agent's own past choices are state=resolved history.
- Outcomes: evidence="verified" ONLY when a diff/test/command output proves it; otherwise "claimed". Trust the diff over the agent's prose.
- Make problems that stopped work prominent and connected to the request they blocked. Be selective: ~22 nodes; merge trivia. Be faithful — never invent verified outcomes.`;

function parseMapRow(row) {
  if (!row) return null;
  let map = null;
  try {
    map = row.map_json ? JSON.parse(row.map_json) : null;
  } catch {}
  return {
    session_id: row.session_id,
    version: row.version,
    status: row.status,
    mode: row.mode || null,
    target: row.target || null,
    model: row.model || null,
    port: row.port || null,
    generated_at: row.generated_at,
    updated_at: row.updated_at,
    error: row.error || null,
    map,
  };
}

export function getSessionMap(session_id) {
  return parseMapRow(_getMap.get(session_id));
}

function storeMap(session_id, patch) {
  const t = now();
  _upsertMap.run(
    session_id,
    MAP_VERSION,
    patch.status || 'ready',
    patch.mode || null,
    patch.target || null,
    patch.model || null,
    patch.port || null,
    patch.generated_at || t,
    t,
    patch.map ? JSON.stringify(patch.map) : null,
    patch.error || null,
    patch.raw || null
  );
  return getSessionMap(session_id);
}

function cleanText(s, max = 20000) {
  return stripAnsi(String(s || ''))
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[│╭╮╰╯─━┃▌▐]/g, ' ').replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .slice(-max);
}

async function terminalTail(session_id, fallback = '') {
  const file = join(LOG_DIR, session_id + '.log');
  try {
    const text = await readFile(file, 'utf8');
    return cleanText(text, 32000);
  } catch {
    return cleanText(fallback, 16000);
  }
}

function normalizeEvents(rows = []) {
  return rows.slice().reverse().map((r) => {
    let payload = null;
    try {
      payload = r.payload ? JSON.parse(r.payload) : null;
    } catch {
      payload = r.payload || null;
    }
    return { ts: r.ts, type: r.type, payload };
  });
}

function trimUsage(usage) {
  if (!usage) return null;
  return {
    window: usage.window,
    association: usage.association,
    totals: usage.totals,
    byModel: (usage.byModel || []).slice(0, 8),
    bySource: (usage.bySource || []).slice(0, 8),
    recent: (usage.recent || []).slice(0, 40).map((r) => ({
      ts: r.ts,
      source: r.source,
      model: r.model,
      total_tokens: r.total_tokens,
      cached_input_tokens: r.cached_input_tokens,
      token_traffic_tokens: r.token_traffic_tokens,
      estimated_cost_usd: r.estimated_cost_usd,
      message: r.message,
    })),
  };
}

async function sessionContext(session, snapshotText = '') {
  const project = session.project_id ? getProject(session.project_id) : null;
  const previous = getSessionMap(session.id);
  return {
    generated_at: new Date().toISOString(),
    session: {
      id: session.id,
      title: session.title,
      tool: session.tool,
      model: session.model,
      status: session.status,
      autonomy: session.autonomy,
      effort: session.effort,
      started_at: session.started_at,
      last_activity: session.last_activity,
      ended_at: session.ended_at,
    },
    project,
    messages: messagesFor(session.id, 80),
    events: normalizeEvents(eventsFor(session.id, 120)),
    usage: trimUsage(usageForSession(session)),
    terminal_tail: await terminalTail(session.id, snapshotText),
    previous_map: previous?.map || null,
  };
}

function targetFor(mode, targetId) {
  // Honor an explicitly chosen target from EITHER list — the UI offers the 'generate' models but sends
  // mode='update' on regenerate, which previously fell back to the small Spark model and ignored the
  // user's pick (and overflowed its 8k window).
  if (targetId) {
    const chosen = [...MAP_TARGETS.generate, ...MAP_TARGETS.update].find((t) => t.id === targetId);
    if (chosen) return chosen;
  }
  const key = mode === 'update' ? 'update' : 'generate';
  const fallback = key === 'update' ? DEFAULT_UPDATE : DEFAULT_GENERATE;
  return MAP_TARGETS[key].find((t) => t.id === fallback) || MAP_TARGETS[key][0];
}

function chat(target, messages) {
  return new Promise((resolve, reject) => {
    // The proxy fleet gates /v1/* behind PROXY_API_KEY — a keyless call is 401 (see CLAUDE.md).
    fleetKey().then((key) => {
      const body = {
        model: target.model,
        temperature: 0.2,
        messages,
      };
      if (target.proxy !== 'codex') body.max_tokens = target.maxTokens || 6000;
      else body.reasoning_effort = 'low';
      if (target.proxy !== 'claude') body.response_format = { type: 'json_object' };
      if (target.proxy === 'aliyun') body.enable_search = false;
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: target.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${key}` },
          timeout: Number(process.env.AIOS_MAP_TIMEOUT_MS || 90000),
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('session map generation timeout')));
      req.write(data);
      req.end();
    }, reject);
  });
}

function parseJsonObject(s) {
  const text = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('model did not return a JSON object');
  return JSON.parse(m[0]);
}

const NODE_ROLES = ['ask', 'action', 'outcome', 'problem', 'decision'];
const NODE_STATES = ['done', 'active', 'blocked', 'open', 'resolved', 'pending', 'unknown'];
const NODE_EVIDENCE = ['verified', 'claimed', 'none'];
const EDGE_RELS = ['led_to', 'produced', 'raised', 'blocks', 'resolves', 'threatens'];
const SESSION_STATES = ['working', 'waiting', 'blocked', 'done', 'unknown'];

function normalizeMap(m, session) {
  const ids = new Set();
  const nodes = (Array.isArray(m.nodes) ? m.nodes : []).slice(0, 30).map((n, i) => {
    const id = String(n.id || `n${i}`).slice(0, 40);
    ids.add(id);
    const role = NODE_ROLES.includes(n.role) ? n.role : 'action';
    const cost =
      n.cost && typeof n.cost === 'object'
        ? { elapsed: n.cost.elapsed ? String(n.cost.elapsed).slice(0, 30) : null, tokens: Number(n.cost.tokens) || 0, usd: Number(n.cost.usd) || 0 }
        : null;
    return {
      id,
      role,
      label: String(n.label || 'node').slice(0, 110),
      state: NODE_STATES.includes(n.state) ? n.state : 'unknown',
      evidence: NODE_EVIDENCE.includes(n.evidence) ? n.evidence : 'none',
      needs_human: !!n.needs_human,
      detail: String(n.detail || '').slice(0, 1400),
      result: role === 'ask' ? String(n.result || '').slice(0, 120) : '',
      cost: cost && (cost.elapsed || cost.tokens || cost.usd) ? cost : null,
    };
  });
  const seenEdge = new Set();
  const edges = (Array.isArray(m.edges) ? m.edges : [])
    .slice(0, 90)
    .map((e) => ({ from: String(e.from), to: String(e.to), rel: EDGE_RELS.includes(e.rel) ? e.rel : 'led_to' }))
    .filter((e) => {
      const k = `${e.from}>${e.to}:${e.rel}`;
      if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to) || seenEdge.has(k)) return false;
      seenEdge.add(k);
      return true;
    });
  const parseRef = (o) => {
    if (!o || typeof o !== 'object') return null;
    const node_id = ids.has(String(o.node_id)) ? String(o.node_id) : null;
    const summary = String(o.summary || '').slice(0, 400);
    const why = String(o.why || '').slice(0, 400);
    return summary || node_id ? { node_id, summary, why } : null;
  };
  const needs_you = parseRef(m.needs_you);
  const blocker = parseRef(m.blocker);
  const active_node_id = ids.has(String(m.active_node_id)) ? String(m.active_node_id) : null;
  return {
    version: 3,
    headline: String(m.headline || session.title || 'Session map').slice(0, 180),
    state: SESSION_STATES.includes(m.state) ? m.state : String(session.status || 'unknown'),
    goal: String(m.goal || '').slice(0, 600),
    on_track: ['on_track', 'drifting', 'unknown'].includes(m.on_track) ? m.on_track : 'unknown',
    trust: String(m.trust || '').slice(0, 500),
    needs_you,
    blocker,
    active_node_id,
    nodes,
    edges,
  };
}

export async function generateSessionMap(session, { snapshot = '', mode = 'generate', targetId = null } = {}) {
  const target = targetFor(mode, targetId);
  const ctx = await sessionContext(session, snapshot);
  // Fit the prompt to the model's window: reserve output, then slice the context JSON so input+output
  // stay under `context` (some models are only 8k). ~2.8 chars/token (conservative -> overestimates input).
  const ctxWindow = target.context || 128000;
  const maxOut = Math.max(512, Math.min(target.maxTokens || 4000, Math.floor(ctxWindow * 0.4)));
  const ctxCharBudget = Math.max(2000, Math.floor((ctxWindow - maxOut - 1200) * 2.8));
  const prompt = [
    { role: 'system', content: SYS },
    {
      role: 'user',
      content:
        'Build or update the session map from this JSON context. Remember: return JSON only.\n\nCONTEXT_JSON:\n' +
        JSON.stringify(ctx).slice(0, Math.min(90000, ctxCharBudget)),
    },
  ];
  try {
    // Retry transient proxy/upstream blips so one hiccup doesn't stick the map at status:error until a
    // manual regenerate: the fleet refuses connections (ECONNREFUSED) during a proxy restart and the
    // proxy surfaces "fetch failed"/5xx when the upstream model API is briefly unreachable. Only
    // transport/availability errors retry; a malformed-JSON or normalize error still fails once. Mirrors
    // the summarize.js retry.
    let content = '';
    for (let i = 0; ; i++) {
      try {
        const raw = await chat({ ...target, maxTokens: maxOut }, prompt);
        const env = JSON.parse(raw);
        if (env.error) throw new Error(env.error.message || JSON.stringify(env.error));
        content = env.choices?.[0]?.message?.content || '';
        break;
      } catch (e) {
        if (i < 2 && /fetch failed|timeout|timed out|ECONNREFUSED|ECONNRESET|socket hang up|EAI_AGAIN|network|unavailable|overloaded|rate.?limit|\b(429|500|502|503|504)\b/i.test(String(e?.message || e))) {
          await sleep(500 * (i + 1));
          continue;
        }
        throw e;
      }
    }
    const map = normalizeMap(parseJsonObject(content), session);
    return storeMap(session.id, { status: 'ready', mode, target: target.id, model: target.model, port: target.port, map, raw: content });
  } catch (e) {
    return storeMap(session.id, { status: 'error', mode, target: target.id, model: target.model, port: target.port, error: String(e.message || e) });
  }
}

export function sessionMapOptions() {
  return { defaults: { generate: DEFAULT_GENERATE, update: DEFAULT_UPDATE }, targets: MAP_TARGETS };
}
