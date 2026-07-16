// Deterministic "session space map": a task → subtask → tool-call hierarchy parsed straight from the
// agent's own transcript, sized by real tokens/$/time. NO LLM, NO manual action — it auto-rebuilds as
// the session grows (cheap mtime-gated sweep). The same structure powers both the "Solar" (sized
// hierarchy) and "Flow" (request spine) views. The atomic costed unit is one assistant TURN (it carries
// message.usage); turns cluster into subtasks by category; clusters group under the user requests
// (systems). Cost via the shared priceUsage(); transcript shapes mirror usage_collect.js parseClaude/Codex.
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { db, getSession, getProject, listSessions } from './store.js';
import { now } from './util.js';
import { priceUsage } from './usage_pricing.js';
import { bus } from './bus.js';
import { applyLabels, labelSettled, labelReady } from './session_labels.js';

const SPACE_VERSION = 3; // v3: per-request agent response text + cleaned request labels (for LLM labeling)
const CLAUDE_DIR = process.env.AIOS_USAGE_CLAUDE_DIR || join(homedir(), '.claude', 'projects');
const CODEX_DIR = process.env.AIOS_USAGE_CODEX_DIR || join(homedir(), '.codex', 'sessions');
const MAX_FILE_BYTES = Number(process.env.AIOS_SPACE_MAX_BYTES || 32 * 1024 * 1024);
const MAX_NODES = Number(process.env.AIOS_SPACE_MAX_NODES || 320); // cap emitted turn nodes (roll-ups keep full totals)
const SWEEP_MS = Number(process.env.AIOS_SPACE_SWEEP_MS || 8000);
const ERROR_RX = /\b(error|fatal|traceback|exception|command not found|no such file|permission denied|failed|cannot|panic)\b|exit code [1-9]|\bENOENT\b|\bE[A-Z]{3,}\b/i;

db.exec(`
  CREATE TABLE IF NOT EXISTS session_space (
    session_id   TEXT PRIMARY KEY,
    version      INTEGER NOT NULL,
    tool         TEXT,
    built_at     INTEGER NOT NULL,
    source_file  TEXT,
    source_mtime INTEGER,
    space_json   TEXT
  );
`);
const _get = db.prepare('SELECT * FROM session_space WHERE session_id = ?');
const _upsert = db.prepare(`
  INSERT INTO session_space (session_id, version, tool, built_at, source_file, source_mtime, space_json)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET
    version=excluded.version, tool=excluded.tool, built_at=excluded.built_at,
    source_file=excluded.source_file, source_mtime=excluded.source_mtime, space_json=excluded.space_json
`);

export function getSessionSpace(sid) {
  const row = _get.get(sid);
  if (!row) return null;
  let space = null;
  try {
    space = row.space_json ? JSON.parse(row.space_json) : null;
  } catch {}
  const labelTs = space ? applyLabels(space, sid) : 0; // overlay cached cheap-LLM labels; returns latest label ts
  // fold the label ts into built_at so the frontend re-renders when labels arrive after the structural build
  return { session_id: row.session_id, version: row.version, tool: row.tool, built_at: Math.max(row.built_at || 0, labelTs || 0), source_file: row.source_file, space };
}

function storeSpace(sid, { tool, file, mtime, space }) {
  _upsert.run(sid, SPACE_VERSION, tool || null, now(), file || null, Math.round(mtime || 0), space ? JSON.stringify(space) : null);
  return getSessionSpace(sid);
}

// ---- categories + labels ---------------------------------------------------
const CAT_BY_TOOL = {
  Read: 'explore', NotebookRead: 'explore', Grep: 'explore', Glob: 'explore', LS: 'explore',
  WebFetch: 'research', WebSearch: 'research',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Bash: 'exec', BashOutput: 'exec', KillBash: 'exec', KillShell: 'exec',
  Task: 'subagent', Agent: 'subagent',
  AskUserQuestion: 'decision', ExitPlanMode: 'decision', EnterPlanMode: 'decision',
  TaskCreate: 'plan', TaskUpdate: 'plan', TaskList: 'plan', TaskGet: 'plan', TodoWrite: 'plan',
};
const CLUSTER_LABEL = {
  explore: 'Explored', edit: 'Edited', exec: 'Ran', research: 'Researched', plan: 'Planned',
  decision: 'Decision', subagent: 'Subagent', reason: 'Reasoned', respond: 'Responded', mcp: 'Browser', other: 'Worked',
};

function toolCategory(name) {
  if (!name) return 'other';
  if (name.startsWith('mcp__')) return 'mcp';
  return CAT_BY_TOOL[name] || 'other';
}

function b(p) {
  return basename(String(p || '')) || String(p || '');
}
function toolLabel(name, input = {}) {
  switch (name) {
    case 'Read': return 'Read ' + b(input.file_path);
    case 'NotebookRead': return 'Read ' + b(input.notebook_path);
    case 'Edit': case 'MultiEdit': return 'Edit ' + b(input.file_path);
    case 'Write': return 'Write ' + b(input.file_path);
    case 'NotebookEdit': return 'Edit ' + b(input.notebook_path);
    case 'Bash': return 'Bash: ' + String(input.description || input.command || '').replace(/\s+/g, ' ').slice(0, 52);
    case 'Grep': return 'Grep ' + String(input.pattern || '').slice(0, 36);
    case 'Glob': return 'Glob ' + String(input.pattern || '').slice(0, 36);
    case 'Agent': case 'Task': return 'Subagent: ' + String(input.description || input.subagent_type || 'task').slice(0, 44);
    case 'WebSearch': return 'Search ' + String(input.query || '').slice(0, 36);
    case 'WebFetch': { try { return 'Fetch ' + new URL(input.url).hostname; } catch { return 'Fetch'; } }
    case 'AskUserQuestion': return 'Asked: ' + String(input.questions?.[0]?.header || input.questions?.[0]?.question || 'question').slice(0, 44);
    case 'ExitPlanMode': return 'Proposed a plan';
    case 'EnterPlanMode': return 'Entered plan mode';
    case 'TaskCreate': return 'Todo+ ' + String(input.subject || '').slice(0, 36);
    case 'TaskUpdate': return 'Todo update';
    default: return name?.startsWith('mcp__') ? name.replace(/^mcp__/, '').replace(/__/g, ' ').slice(0, 40) : String(name || 'tool');
  }
}

// ---- generic helpers -------------------------------------------------------
function tsMs(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : fallback;
}
function contentArray(msg) {
  if (!msg) return [];
  if (typeof msg.content === 'string') return [{ type: 'text', text: msg.content }];
  return Array.isArray(msg.content) ? msg.content : [];
}
function contentText(msg) {
  return contentArray(msg).filter((c) => c.type === 'text').map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
}
// strip attachment placeholders / interrupt markers so the raw request label isn't junk like "[Image #9]…"
function cleanReq(s) {
  return String(s || '')
    .replace(/\[Image #\d+\]/gi, '')
    .replace(/\[Request interrupted[^\]]*\]/gi, '')
    .replace(/<\/?[a-z_]+>/gi, ' ') // codex wraps context in <tags>
    .replace(/\s+/g, ' ')
    .trim();
}
function hasToolResult(msg) {
  return contentArray(msg).some((c) => c.type === 'tool_result');
}

let _nid = 0;
function nid(p) {
  return `${p}${++_nid}`;
}

// roll a child's metrics into a parent accumulator
function addMetrics(acc, m) {
  acc.tokens += m.tokens || 0;
  acc.usd += m.usd || 0;
  acc.calls += m.calls || 0;
}

// price one assistant turn's usage -> usd
function turnUsd(usage, model) {
  if (!usage) return 0;
  const r = priceUsage({
    model,
    provider: 'claude',
    tool: 'claude',
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cached_input_tokens: (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
    output_tokens: usage.output_tokens,
    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
  });
  return r.estimated_cost_usd || 0;
}
function turnTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.output_tokens || 0);
}

// ---- CLAUDE transcript -> tree --------------------------------------------
function buildClaudeSpace(text, session) {
  // line records with byte offsets (for click-to-transcript)
  const recs = [];
  let off = 0;
  for (const line of text.split('\n')) {
    const len = Buffer.byteLength(line) + 1; // include the '\n'
    const start = off;
    off += len;
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    recs.push({ o, start, end: off });
  }
  if (!recs.length) return null;

  // tool_use id -> result text (the result is echoed in the FOLLOWING user turn)
  const resultText = new Map();
  for (const { o } of recs) {
    if (o.type !== 'user') continue;
    for (const c of contentArray(o.message)) {
      if (c.type === 'tool_result') {
        const t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : '';
        resultText.set(c.tool_use_id, { text: String(t || '').slice(0, 4000), isError: !!c.is_error });
      }
    }
  }

  // Claude streams one logical assistant turn as SEVERAL jsonl lines (thinking / text / tool_use), and
  // every line repeats the SAME message.usage. Merge consecutive lines sharing message.id into one turn
  // so tokens/$ are counted exactly once (usage_collect dedupes the same way, by message.id).
  const events = [];
  let curT = null;
  const seenMsg = new Set();
  const flushT = () => { if (curT) { events.push(curT); curT = null; } };
  for (const rec of recs) {
    const o = rec.o;
    if (o.type === 'user' && !o.isSidechain && !hasToolResult(o.message)) {
      const txt = contentText(o.message);
      if (txt && !/^\[Request interrupted/i.test(txt)) {
        flushT();
        events.push({ kind: 'prompt', o, rec });
        continue;
      }
    }
    if (o.type === 'assistant' && o.message) {
      const id = o.message.id || `anon-${rec.start}`;
      if (curT && curT.msgId === id) {
        curT.blocks.push(...contentArray(o.message));
        curT.end = rec.end;
        continue;
      }
      flushT();
      curT = {
        kind: 'turn', msgId: id, dup: seenMsg.has(id),
        usage: o.message.usage, model: o.message.model,
        blocks: [...contentArray(o.message)], ts: tsMs(o.timestamp),
        isSidechain: !!o.isSidechain, start: rec.start, end: rec.end,
      };
      seenMsg.add(id);
      continue;
    }
    flushT(); // tool_result / system / other line closes the open turn
  }
  flushT();

  const systems = [];
  let sys = null;
  let cluster = null;
  let lastAgent = null; // most recent main-line subagent turn node (sidechain turns attach here)
  let nodeCount = 0;
  const totals = { tokens: 0, usd: 0, calls: 0, requests: 0, problems: 0 };

  const startSystem = (label, detail, ts, src) => {
    cluster = null;
    lastAgent = null;
    sys = {
      id: nid('sys'), kind: 'system', category: 'ask',
      label: cleanReq(label).slice(0, 90) || 'Request',
      detail: cleanReq(detail).slice(0, 700),
      agentText: '', // the agent's own response prose this request — strongest signal for the LLM labeler
      ts, end_ts: ts,
      tokens: 0, usd: 0, calls: 0, problems: 0,
      outcomes: [], children: [],
      source: { start: src.start, end: src.end },
    };
    systems.push(sys);
    totals.requests++;
  };

  for (const ev of events) {
    if (ev.kind === 'prompt') {
      const txt = contentText(ev.o.message);
      startSystem(txt, txt, tsMs(ev.o.timestamp), ev.rec);
      continue;
    }
    if (!sys) startSystem(session.title || 'Session start', '', ev.ts, { start: ev.start, end: ev.end });

    const usage = ev.dup ? null : ev.usage; // a repeated message.id is already counted -> 0
    const tk = turnTokens(usage);
    const usd = turnUsd(usage, ev.model);
    const toolUses = ev.blocks.filter((c) => c.type === 'tool_use');
    const hasThinking = ev.blocks.some((c) => c.type === 'thinking');
    const hasText = ev.blocks.some((c) => c.type === 'text');

    // sidechain (subagent-internal) turns roll up into the spawning Agent node
    if (ev.isSidechain) {
      if (lastAgent) {
        lastAgent.tokens += tk;
        lastAgent.usd += usd;
        lastAgent.sub_calls = (lastAgent.sub_calls || 0) + (toolUses.length || 1);
      }
      sys.tokens += tk; sys.usd += usd;
      totals.tokens += tk; totals.usd += usd;
      continue;
    }

    // accumulate the agent's response prose for this request (capped) — best signal of what it did
    if (hasText && sys.agentText.length < 1600) {
      const atxt = ev.blocks.filter((c) => c.type === 'text').map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
      if (atxt) sys.agentText = ((sys.agentText ? sys.agentText + ' / ' : '') + atxt).slice(0, 1600);
    }

    // category for this turn = its (first) tool, else reasoning/response
    const primary = toolUses[0];
    const cat = primary ? toolCategory(primary.name) : hasText ? 'respond' : hasThinking ? 'reason' : 'other';
    const label = primary ? toolLabel(primary.name, primary.input || {}) : hasText ? 'Responded' : 'Reasoned';

    let problem = false;
    for (const t of toolUses) {
      const r = resultText.get(t.id);
      if (r && r.isError) problem = true; // Claude's explicit tool-error flag (text-scanning was far too noisy)
    }

    // start/extend a cluster (consecutive same-category turns merge; decisions & subagents stand alone)
    const standalone = cat === 'subagent' || cat === 'decision';
    if (!cluster || cluster.category !== cat || standalone || cluster.standalone) {
      cluster = {
        id: nid('cl'), kind: 'cluster', category: cat, standalone,
        label: CLUSTER_LABEL[cat] || 'Worked',
        ts: ev.ts, tokens: 0, usd: 0, calls: 0, count: 0, problems: 0,
        children: [],
      };
      sys.children.push(cluster);
    }

    const turnFile = primary ? b(primary.input?.file_path || primary.input?.notebook_path || '') : '';
    const turn = {
      id: nid('t'), kind: 'turn', category: cat, label,
      ts: ev.ts, tokens: tk, usd, calls: toolUses.length || 1,
      evidence: cat === 'edit' || cat === 'exec' ? 'verified' : 'claimed',
      problem, file: turnFile,
      source: { start: ev.start, end: ev.end },
    };
    if (cat === 'subagent') { turn.sub_calls = 0; lastAgent = turn; }
    cluster.children.push(turn);
    nodeCount++;

    if (cat === 'edit' && primary) {
      const f = b(primary.input?.file_path || primary.input?.notebook_path);
      if (f && !sys.outcomes.includes(f)) sys.outcomes.push(f);
    }

    cluster.count++;
    cluster.calls += turn.calls;
    cluster.tokens += tk;
    cluster.usd += usd;
    if (problem) { cluster.problems++; sys.problems++; totals.problems++; }
    sys.tokens += tk;
    sys.usd += usd;
    sys.calls += turn.calls;
    sys.end_ts = Math.max(sys.end_ts, ev.ts);
    totals.tokens += tk;
    totals.usd += usd;
    totals.calls += turn.calls;
  }

  if (!systems.length) return null;

  // elapsed per system (wall-clock incl. waits) = next system start (or session last activity) - start
  const lastActivity = Number(session.last_activity || session.ended_at || now());
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i];
    const end = i + 1 < systems.length ? systems[i + 1].ts : Math.max(s.end_ts, lastActivity);
    s.elapsed_ms = Math.max(0, end - s.ts);
    // finalize cluster labels with counts + cluster elapsed
    for (const cl of s.children) {
      if (cl.count > 1 && !cl.standalone) cl.label = `${CLUSTER_LABEL[cl.category] || 'Worked'} ×${cl.count}`;
      else if (cl.children[0]) cl.label = cl.children[0].label;
      cl.elapsed_ms = cl.children.length ? Math.max(0, (cl.children[cl.children.length - 1].ts) - cl.children[0].ts) : 0;
      // prune individual turn nodes if we're over the node budget (keep the cluster + its rolled-up size)
    }
  }

  pruneNodes(systems, nodeCount);

  const active = systems[systems.length - 1];
  const state = session.status === 'exited' ? 'done' : session.status === 'waiting' ? 'waiting' : 'working';
  return {
    version: SPACE_VERSION,
    tool: 'claude',
    built_at: now(),
    headline: session.title ? String(session.title).split('\n')[0].slice(0, 220) : 'Session',
    state,
    goal: systems[0]?.detail || systems[0]?.label || '',
    active_id: active?.id || null,
    totals: { tokens: totals.tokens, usd: round(totals.usd), calls: totals.calls, requests: totals.requests, problems: totals.problems },
    systems: systems.map(cleanSystem),
  };
}

function round(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

// keep the json bounded: if we emitted more than MAX_NODES turn-nodes, drop the smallest turns inside
// each cluster (the cluster keeps its full rolled-up tokens/usd, so sizing stays correct).
function pruneNodes(systems, nodeCount) {
  if (nodeCount <= MAX_NODES) return;
  let budget = MAX_NODES;
  const clusters = [];
  for (const s of systems) for (const cl of s.children) clusters.push(cl);
  clusters.sort((a, b) => b.tokens - a.tokens);
  for (const cl of clusters) {
    if (budget <= 0) { cl.hidden_children = cl.children.length; cl.children = []; continue; }
    if (cl.children.length > budget) {
      cl.children.sort((a, b) => b.tokens - a.tokens);
      cl.hidden_children = cl.children.length - budget;
      cl.children = cl.children.slice(0, budget);
    }
    budget -= cl.children.length;
  }
}

function cleanSystem(s) {
  return {
    id: s.id, kind: 'system', category: 'ask', label: s.label, detail: s.detail, text: s.agentText || '',
    ts: s.ts, elapsed_ms: s.elapsed_ms, tokens: s.tokens, usd: round(s.usd), calls: s.calls,
    problems: s.problems, outcomes: s.outcomes.slice(0, 8),
    source: s.source,
    children: s.children.map((cl) => ({
      id: cl.id, kind: 'cluster', category: cl.category, label: cl.label,
      ts: cl.ts, elapsed_ms: cl.elapsed_ms || 0, tokens: cl.tokens, usd: round(cl.usd),
      calls: cl.calls, count: cl.count, problems: cl.problems, hidden_children: cl.hidden_children || 0,
      children: cl.children.map((t) => ({
        id: t.id, kind: 'turn', category: t.category, label: t.label, ts: t.ts,
        elapsed_ms: 0, tokens: t.tokens, usd: round(t.usd), calls: t.calls,
        evidence: t.evidence, problem: t.problem, sub_calls: t.sub_calls || 0, file: t.file || '', source: t.source,
      })),
    })),
  };
}

// ---- transcript file location ---------------------------------------------
function encCwd(p) {
  return String(p || '').replace(/[/.]/g, '-');
}
async function listJsonl(dir) {
  let ents = [];
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
  }
  return out;
}

// first jsonl line's timestamp (when this claude conversation began). Cached — a file's first line is fixed.
const _firstTsCache = new Map();
async function firstLineTs(file) {
  if (_firstTsCache.has(file)) return _firstTsCache.get(file);
  let v = 0;
  try {
    const fh = await open(file, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    await fh.close();
    const first = buf.slice(0, bytesRead).toString('utf8').split('\n')[0];
    const o = JSON.parse(first);
    v = tsMs(o.timestamp || o.payload?.timestamp, 0);
  } catch {}
  _firstTsCache.set(file, v);
  return v;
}

// first real user prompt of a transcript (to disambiguate concurrent sessions sharing one cwd). Cached.
const _fpCache = new Map();
async function firstUserPrompt(file) {
  if (_fpCache.has(file)) return _fpCache.get(file);
  let v = '';
  try {
    const fh = await open(file, 'r');
    const buf = Buffer.alloc(131072);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    for (const line of buf.slice(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'user' && !o.isSidechain && !hasToolResult(o.message)) {
        const t = contentText(o.message);
        if (t && !/^\[Request interrupted/i.test(t)) { v = t; break; }
      }
    }
  } catch {}
  _fpCache.set(file, v);
  return v;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// claude: many Supercalm sessions share one project cwd dir AND can run concurrently, so temporal overlap
// alone is ambiguous. Match each *.jsonl's first user prompt against the session title (Supercalm seeds the
// first prompt from the task); fall back to best [firstLineTs, mtime]↔[started_at, last_activity] overlap.
async function findClaudeFile(session, project) {
  if (!project?.path) return null;
  const dir = join(CLAUDE_DIR, encCwd(project.path));
  const files = await listJsonl(dir);
  if (!files.length) return null;
  const sStart = Number(session.started_at || 0);
  const sEnd = Number(session.ended_at || 0) || Number(session.last_activity || 0) || now();
  const anchor = norm(session.title).slice(0, 40);
  let best = null;
  for (const f of files) {
    const st = await stat(f).catch(() => null);
    if (!st) continue;
    const first = (await firstLineTs(f)) || (st.mtimeMs - 60_000);
    const overlap = Math.min(st.mtimeMs, sEnd) - Math.max(first, sStart); // ms the windows overlap
    let match = 0;
    if (anchor.length >= 12) {
      const fp = norm(await firstUserPrompt(f)).slice(0, 60);
      const a = anchor.slice(0, 24);
      if (fp && (fp.startsWith(a) || fp.includes(a) || anchor.startsWith(fp.slice(0, 24)))) match = 1;
    }
    const score = match * 1e15 + overlap; // a title match dominates; overlap is the tiebreak
    if (!best || score > best.score) best = { file: f, mtime: st.mtimeMs, overlap, match, score };
  }
  return best && (best.match || best.overlap > -2 * 60_000) ? best : null;
}

// codex: newest rollout-*.jsonl whose session_meta cwd matches (mirrors findCodexSession in sessions.js)
async function findCodexFile(session, project) {
  if (!project?.path) return null;
  const files = [];
  const walk = async (dir, depth) => {
    let ents = [];
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  await walk(CODEX_DIR, 0);
  files.sort().reverse();
  const startWin = Number(session.started_at || 0) - 10 * 60_000;
  for (const f of files.slice(0, 120)) {
    const st = await stat(f).catch(() => null);
    if (!st || st.mtimeMs < startWin) continue;
    const head = await readFile(f, 'utf8').then((t) => t.slice(0, 4000)).catch(() => '');
    const cm = head.match(/"cwd":\s*"([^"]+)"/);
    if (cm && cm[1] === project.path) return { file: f, mtime: st.mtimeMs };
  }
  return null;
}

async function locate(session) {
  const project = session.project_id ? getProject(session.project_id) : null;
  if (session.tool === 'claude') return { ...(await findClaudeFile(session, project)), project };
  if (session.tool === 'codex') return { ...(await findCodexFile(session, project)), project };
  return { file: null, project };
}

// ---- build + persist -------------------------------------------------------
export async function buildSessionSpace(session, located = null) {
  const loc = located || (await locate(session));
  if (!loc?.file) return storeSpace(session.id, { tool: session.tool, file: null, mtime: 0, space: null });
  let text = '';
  try {
    const st = await stat(loc.file);
    if (st.size > MAX_FILE_BYTES) {
      const buf = await readFile(loc.file);
      text = buf.slice(buf.length - MAX_FILE_BYTES).toString('utf8');
    } else {
      text = await readFile(loc.file, 'utf8');
    }
  } catch {
    return getSessionSpace(session.id);
  }
  _nid = 0;
  let space = null;
  if (session.tool === 'claude') space = buildClaudeSpace(text, session);
  else if (session.tool === 'codex') space = buildCodexSpace(text, session);
  const mt = (await stat(loc.file).catch(() => null))?.mtimeMs || now();
  const stored = storeSpace(session.id, { tool: session.tool, file: loc.file, mtime: mt, space });
  // the structure (re)built -> there may be new/changed requests to label; let the labeler re-evaluate,
  // and kick an immediate pass so labels start appearing the moment a session is opened or grows.
  if (space && labelReady()) {
    labelDone.delete(session.id);
    labelSettled(session, space).then((done) => { if (done) labelDone.add(session.id); }).catch((e) => console.error('[aios] labelSettled:', e?.message || e));
  }
  return stored;
}

// ---- CODEX transcript -> tree (basic: turns + function calls, token_count events) -----------------
function buildCodexSpace(text, session) {
  const recs = [];
  let off = 0;
  for (const line of text.split('\n')) {
    const len = Buffer.byteLength(line) + 1;
    const start = off;
    off += len;
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    recs.push({ o, start, end: off });
  }
  if (!recs.length) return null;
  let model = null;
  const systems = [];
  let sys = null;
  let cluster = null;
  let pendingTokens = 0;
  const totals = { tokens: 0, usd: 0, calls: 0, requests: 0, problems: 0 };

  const startSystem = (label, ts, rec) => {
    cluster = null;
    sys = { id: nid('sys'), kind: 'system', category: 'ask', label: cleanReq(label).slice(0, 90), detail: cleanReq(label).slice(0, 700), agentText: '', ts, end_ts: ts, tokens: 0, usd: 0, calls: 0, problems: 0, outcomes: [], children: [], source: { start: rec.start, end: rec.end } };
    systems.push(sys);
    totals.requests++;
  };
  const priceCodexTurn = (last) => {
    if (!last) return 0;
    const r = priceUsage({
      model, provider: 'codex', tool: 'codex',
      input_tokens: last.input_tokens, output_tokens: last.output_tokens,
      cached_input_tokens: last.cached_input_tokens, cache_read_input_tokens: last.cached_input_tokens,
      total_tokens: last.total_tokens,
    });
    return r.estimated_cost_usd || 0;
  };

  for (const rec of recs) {
    const o = rec.o;
    const p = o.payload || {};
    if (o.type === 'session_meta' || o.type === 'turn_context') {
      model = p.model || model;
      continue;
    }
    const ts = tsMs(o.timestamp);
    if (o.type === 'response_item' && p.type === 'message') {
      const txt = Array.isArray(p.content) ? p.content.map((c) => c.text || '').join(' ').replace(/\s+/g, ' ').trim() : '';
      // real user request only: codex wraps internal context in <tags>/[brackets] and templated prompts
      if (p.role === 'user' && txt && !/^\s*[<[]/.test(txt) && !/^(environment_context|user_instructions|goal_context)/i.test(txt)) {
        startSystem(txt, ts, rec);
      }
      continue;
    }
    if (!sys) startSystem(session.title || 'Session', ts, rec);
    if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call')) {
      const name = p.name || (p.type === 'local_shell_call' ? 'Bash' : 'tool');
      const cat = name === 'shell' || p.type === 'local_shell_call' ? 'exec' : toolCategory(name);
      if (!cluster || cluster.category !== cat) {
        cluster = { id: nid('cl'), kind: 'cluster', category: cat, label: CLUSTER_LABEL[cat] || 'Worked', ts, tokens: 0, usd: 0, calls: 0, count: 0, problems: 0, children: [] };
        sys.children.push(cluster);
      }
      const turn = { id: nid('t'), kind: 'turn', category: cat, label: codexCallLabel(name, p), ts, tokens: 0, usd: 0, calls: 1, evidence: cat === 'exec' || cat === 'edit' ? 'verified' : 'claimed', problem: false, source: { start: rec.start, end: rec.end } };
      cluster.children.push(turn);
      cluster.count++; cluster.calls++;
      sys.calls++; sys.end_ts = Math.max(sys.end_ts, ts);
      totals.calls++;
      continue;
    }
    if (o.type === 'event_msg' && p.type === 'token_count') {
      const last = p.info?.last_token_usage;
      const toks = last ? Number(last.total_tokens || (Number(last.input_tokens || 0) + Number(last.output_tokens || 0))) : 0;
      if (toks && sys) {
        const usd = priceCodexTurn(last);
        // attribute to the latest cluster/turn in the active system
        const cl = sys.children[sys.children.length - 1];
        if (cl) {
          cl.tokens += toks; cl.usd += usd;
          const t = cl.children[cl.children.length - 1];
          if (t) { t.tokens += toks; t.usd += usd; }
        }
        sys.tokens += toks; sys.usd += usd;
        totals.tokens += toks; totals.usd += usd;
      }
    }
  }
  if (!systems.length) return null;
  const lastActivity = Number(session.last_activity || session.ended_at || now());
  let nodeCount = 0;
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i];
    s.elapsed_ms = Math.max(0, (i + 1 < systems.length ? systems[i + 1].ts : Math.max(s.end_ts, lastActivity)) - s.ts);
    for (const cl of s.children) {
      nodeCount += cl.children.length;
      if (cl.count > 1) cl.label = `${CLUSTER_LABEL[cl.category] || 'Worked'} ×${cl.count}`;
      else if (cl.children[0]) cl.label = cl.children[0].label;
      cl.elapsed_ms = cl.children.length ? Math.max(0, cl.children[cl.children.length - 1].ts - cl.children[0].ts) : 0;
    }
  }
  pruneNodes(systems, nodeCount);
  const active = systems[systems.length - 1];
  const state = session.status === 'exited' ? 'done' : session.status === 'waiting' ? 'waiting' : 'working';
  return {
    version: SPACE_VERSION, tool: 'codex', built_at: now(),
    headline: session.title ? String(session.title).split('\n')[0].slice(0, 220) : 'Session',
    state, goal: systems[0]?.detail || systems[0]?.label || '', active_id: active?.id || null,
    totals: { tokens: totals.tokens, usd: round(totals.usd), calls: totals.calls, requests: totals.requests, problems: totals.problems },
    systems: systems.map(cleanSystem),
  };
}
function codexCallLabel(name, p) {
  let input = {};
  try {
    input = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || {};
  } catch {}
  if (name === 'shell' || p.type === 'local_shell_call') {
    const cmd = Array.isArray(input.command) ? input.command.join(' ') : input.command || '';
    return 'Bash: ' + String(cmd).replace(/\s+/g, ' ').slice(0, 52);
  }
  return toolLabel(name, input);
}

// ---- click-to-transcript: return the raw slice for a node ------------------
export async function sourceSliceFor(sid, nodeId) {
  const row = _get.get(sid);
  if (!row || !row.source_file) return null;
  let space = null;
  try {
    space = JSON.parse(row.space_json);
  } catch {
    return null;
  }
  let found = null;
  const walk = (n) => {
    if (found) return;
    if (n.id === nodeId) { found = n; return; }
    for (const c of n.children || []) walk(c);
  };
  for (const s of space.systems || []) walk(s);
  if (!found?.source) return null;
  try {
    const buf = await readFile(row.source_file);
    const slice = buf.slice(found.source.start, Math.min(buf.length, found.source.end)).toString('utf8');
    return { node: nodeId, file: row.source_file, text: slice.slice(0, 20000) };
  } catch {
    return null;
  }
}

// ---- auto-build sweep (cheap, mtime-gated; the deterministic build is no-LLM) ---------------------
let sweeping = false;
const labelDone = new Set(); // sessions whose settled requests are fully labeled (gates the supplemental
// label pass so we don't re-read/re-check forever); cleared by buildSessionSpace when the structure changes.
async function maybeRebuild(session) {
  const loc = await locate(session);
  if (!loc?.file) return;
  const st = await stat(loc.file).catch(() => null);
  if (!st) return;
  const row = _get.get(session.id);
  if (row && row.version === SPACE_VERSION && row.source_file === loc.file && Number(row.source_mtime) >= Math.floor(st.mtimeMs)) return;
  await buildSessionSpace(session, loc);
}
async function sweepOnce() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const s of listSessions()) {
      if (s.tool !== 'claude' && s.tool !== 'codex') continue;
      const built = _get.get(s.id);
      if (!(s.status === 'exited' && built)) await maybeRebuild(s).catch(() => {}); // exited+built is structurally stable
      // Proactively label only LIVE sessions (the ones the user is likely watching): keep labeling their
      // settled requests across sweeps until done (one pass labels only MAX_PER_PASS). Exited/old sessions
      // are labeled lazily, on open (kickLabels from the /space route) — no point spending tokens naming
      // dozens of finished sessions nobody may reopen. labelDone gates fully-labeled sessions to ~a Map hit.
      if (labelReady() && s.status !== 'exited' && !labelDone.has(s.id)) {
        const cur = getSessionSpace(s.id);
        if (cur?.space) {
          const done = await labelSettled(s, cur.space).catch(() => false);
          if (done) labelDone.add(s.id);
        } else labelDone.add(s.id); // nothing built to label
      }
    }
  } finally {
    sweeping = false;
  }
}

let started = false;
export function startSpaceBuilder() {
  if (started) return;
  started = true;
  let debounce = null;
  bus.on('changed', () => {
    if (debounce) return;
    debounce = setTimeout(() => { debounce = null; sweepOnce(); }, 1500);
  });
  setInterval(() => sweepOnce().catch(() => {}), SWEEP_MS);
  setTimeout(() => sweepOnce().catch(() => {}), 2500);
  console.log('[aios] session-space builder active');
}

// ensure a fresh build for on-demand reads (route helper)
export async function ensureSessionSpace(session) {
  await maybeRebuild(session).catch(() => {});
  return getSessionSpace(session.id);
}

// On-demand labeling for the session being VIEWED (any status, incl. exited/old). The sweep only labels
// live sessions, so this is how an opened finished session gets named — fire-and-forget, cheap when cached
// (labelSettled self-skips already-labeled requests). The panel re-fetches /space as labels land.
export function kickLabels(session) {
  if (!session || !labelReady() || labelDone.has(session.id)) return;
  const cur = getSessionSpace(session.id);
  if (!cur?.space) return;
  labelSettled(session, cur.space).then((done) => { if (done) labelDone.add(session.id); }).catch(() => {});
}
