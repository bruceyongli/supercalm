import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline';
import { LOG_DIR } from './config.js';
import * as store from './store.js';
import { now, stripAnsi } from './util.js';
import { agyStatuslineLogPath } from './agy_statusline.js';
import { deleteCursors, getCursor, latestAgyStatusline, recordLimitEvent, recordUsage, setCursor } from './usage_store.js';

const CLAUDE_PROJECTS_DIR = process.env.AIOS_USAGE_CLAUDE_DIR || join(homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = process.env.AIOS_USAGE_CODEX_DIR || join(homedir(), '.codex', 'sessions');
const ANTIGRAVITY_USAGE = process.env.AIOS_USAGE_AGY_FILE || join(homedir(), '.antigravity-proxy', 'usage.jsonl');
const ANTIGRAVITY_CLI_LOG_DIR = process.env.AIOS_USAGE_AGY_CLI_LOG_DIR || join(homedir(), '.gemini', 'antigravity-cli', 'log');
const ANTIGRAVITY_STATUSLINE_LOG = agyStatuslineLogPath();
const TERMINAL_TAIL_BYTES = Number(process.env.AIOS_USAGE_TERMINAL_TAIL || 4 * 1024 * 1024);
const JSONL_MAX_FILES = Number(process.env.AIOS_USAGE_JSONL_MAX_FILES || 350);
const OVERLAP = 4096;

const codexMeta = new Map(); // file -> { id, cwd, model }

function hash(s) {
  return createHash('sha1').update(String(s)).digest('hex');
}

function num(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function ts(v, fallback = now()) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 10_000_000_000 ? v * 1000 : v;
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : fallback;
}

function projectFor(cwd, fallback = null) {
  const p = String(cwd || '').trim();
  const projects = store.listProjects();
  let best = null;
  for (const pr of projects) {
    if (!p) continue;
    if (p === pr.path || p.startsWith(pr.path + '/')) {
      if (!best || pr.path.length > best.path.length) best = pr;
    }
  }
  if (best) return { project_id: best.id, project: best.name };
  const name = p ? basename(p) || p : fallback;
  return { project_id: null, project: name || null };
}

function sessionForToolCwdTime(tool, cwd, eventTs) {
  const project = projectFor(cwd);
  let best = null;
  for (const s of store.listSessions()) {
    if (s.tool !== tool) continue;
    const start = Number(s.started_at || 0) - 5 * 60_000;
    const end = Number(s.ended_at || 0) || Number(s.last_activity || 0) + 5 * 60_000;
    if (eventTs < start || eventTs > end) continue;
    const sp = s.project_id ? store.getProject(s.project_id) : null;
    const sameProject = project.project_id && s.project_id === project.project_id;
    const samePath = sp?.path && cwd && (cwd === sp.path || cwd.startsWith(sp.path + '/'));
    if (!sameProject && !samePath) continue;
    if (!best || Number(s.started_at || 0) > Number(best.started_at || 0)) best = s;
  }
  return best;
}

async function walk(dir, pred, out = []) {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, pred, out);
    else if (e.isFile() && pred(p)) out.push(p);
  }
  return out;
}

async function pendingFiles(paths, prefix, maxFiles = JSONL_MAX_FILES) {
  const pending = [];
  for (const path of paths) {
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    const key = `${prefix}:${path}`;
    const cur = getCursor(key);
    if (cur && Number(cur.offset) >= st.size) continue;
    pending.push({ path, size: st.size, mtime: st.mtimeMs, key, offset: Math.max(0, Number(cur?.offset) || 0) });
  }
  pending.sort((a, b) => b.mtime - a.mtime);
  return pending.slice(0, maxFiles);
}

async function scanJsonlFile(item, parseLine, counts) {
  const { path, key, size, offset } = item;
  let skippedPartial = offset > 0;
  try {
    const rl = readline.createInterface({
      input: createReadStream(path, { start: offset }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (skippedPartial) {
        skippedPartial = false;
        continue;
      }
      if (!line) continue;
      try {
        if (parseLine(line, path)) counts.recorded++;
      } catch {
        counts.errors++;
      }
    }
    setCursor(key, path, size);
    counts.files++;
  } catch {
    counts.errors++;
  }
}

function parseClaudeLine(line, file) {
  const o = JSON.parse(line);
  const usage = o?.message?.usage;
  if (!usage) return false;
  const key = o.requestId || o.message?.id || o.uuid || hash(file + '\0' + line);
  const cwd = o.cwd || null;
  const project = projectFor(cwd);
  return recordUsage({
    source_id: `claude-jsonl:${key}`,
    source: 'claude-jsonl',
    event_type: 'usage',
    ts: ts(o.timestamp),
    external_session_id: o.sessionId || null,
    request_id: o.requestId || o.message?.id || null,
    tool: 'claude',
    provider: 'claude',
    model: o.message?.model || null,
    cwd,
    ...project,
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cached_input_tokens: num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    output_tokens: usage.output_tokens,
    total_tokens: num(usage.input_tokens) + num(usage.output_tokens),
    raw: {
      file,
      uuid: o.uuid || null,
      version: o.version || null,
      attributionAgent: o.attributionAgent || null,
      entrypoint: o.entrypoint || null,
      service_tier: usage.service_tier || null,
      speed: usage.speed || null,
    },
  });
}

function parseCodexLine(line, file) {
  const o = JSON.parse(line);
  if (o.type === 'session_meta') {
    const prev = codexMeta.get(file) || {};
    codexMeta.set(file, {
      ...prev,
      id: o.payload?.id || o.payload?.session_id || prev.id || null,
      cwd: o.payload?.cwd || prev.cwd || null,
      model: o.payload?.model || prev.model || null,
    });
    return false;
  }
  if (o.type === 'turn_context') {
    const prev = codexMeta.get(file) || {};
    codexMeta.set(file, {
      ...prev,
      cwd: o.payload?.cwd || prev.cwd || null,
      model: o.payload?.model || prev.model || null,
    });
    return false;
  }
  if (o.type !== 'event_msg' || o.payload?.type !== 'token_count') return false;
  const last = o.payload?.info?.last_token_usage;
  if (!last) return false;
  const meta = codexMeta.get(file) || {};
  const cwd = meta.cwd || o.payload?.cwd || null;
  const project = projectFor(cwd);
  return recordUsage({
    source_id: `codex-jsonl:${hash(file + '\0' + line)}`,
    source: 'codex-jsonl',
    event_type: 'usage',
    ts: ts(o.timestamp),
    external_session_id: meta.id || null,
    tool: 'codex',
    provider: 'codex',
    model: meta.model || null,
    cwd,
    ...project,
    input_tokens: last.input_tokens,
    cached_input_tokens: last.cached_input_tokens,
    cache_read_input_tokens: last.cached_input_tokens,
    output_tokens: last.output_tokens,
    reasoning_tokens: last.reasoning_output_tokens,
    total_tokens: last.total_tokens,
    raw: {
      file,
      model_context_window: o.payload?.info?.model_context_window || null,
      rate_limits: o.payload?.rate_limits || null,
    },
  });
}

async function hydrateCodexMeta(file) {
  const current = codexMeta.get(file) || {};
  if (current.id && current.cwd && current.model) return current;
  const meta = { ...current };
  try {
    const rl = readline.createInterface({
      input: createReadStream(file, { start: 0 }),
      crlfDelay: Infinity,
    });
    let lines = 0;
    for await (const line of rl) {
      if (++lines > 250) break;
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'session_meta') {
        meta.id = o.payload?.id || o.payload?.session_id || meta.id || null;
        meta.cwd = o.payload?.cwd || meta.cwd || null;
        meta.model = o.payload?.model || meta.model || null;
      } else if (o.type === 'turn_context') {
        meta.cwd = o.payload?.cwd || meta.cwd || null;
        meta.model = o.payload?.model || meta.model || null;
      }
      if (meta.id && meta.cwd && meta.model) break;
    }
  } catch {
    return current;
  }
  codexMeta.set(file, meta);
  return meta;
}

function parseAntigravityLine(line, file) {
  const o = JSON.parse(line);
  if (!o || !o.model || (o.pt == null && o.ct == null)) return false;
  const input = num(o.pt);
  const output = num(o.ct);
  return recordUsage({
    source_id: `antigravity-jsonl:${hash(file + '\0' + line)}`,
    source: 'antigravity-jsonl',
    event_type: 'usage',
    ts: ts(o.t),
    tool: 'agy',
    provider: 'antigravity',
    model: o.model,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    raw: { file },
  });
}

function antigravityCliTs(line, file, fallback = now()) {
  const m = String(line || '').match(/^[IWEF](\d{4})\s+(\d\d):(\d\d):(\d\d)\.(\d+)/);
  const d = String(basename(file || '')).match(/^cli-(\d{4})(\d{2})(\d{2})_/);
  if (!m || !d) return fallback;
  const ms = Math.round(Number('0.' + m[5]) * 1000);
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(m[2]), Number(m[3]), Number(m[4]), ms).getTime();
}

const AGY_LABEL_TO_MODEL = new Map([
  ['Gemini 3.1 Pro (High)', 'gemini-pro-agent'],
  ['Gemini 3.1 Pro (Low)', 'gemini-3.1-pro-low'],
  ['Gemini 3.5 Flash (High)', 'gemini-3-flash-agent'],
  ['Gemini 3.5 Flash (Medium)', 'gemini-3.5-flash-low'],
  ['Gemini 3.5 Flash (Low)', 'gemini-3.5-flash-extra-low'],
  ['Gemini 3.1 Flash Lite', 'gemini-3.1-flash-lite'],
]);

function agyModelId(labelOrId) {
  const raw = String(labelOrId || '').trim();
  if (!raw) return null;
  return AGY_LABEL_TO_MODEL.get(raw) || raw;
}

function parseAntigravityCliLine(line, file, state, counts) {
  const cwd = line.match(/workspaceDirs=\[([^\]\s]+)/)?.[1];
  if (cwd) state.cwd = cwd;
  const modelId = line.match(/Model ID ([a-zA-Z0-9._-]+) /)?.[1];
  if (modelId) state.model = modelId;
  const label = line.match(/Propagating selected model override to backend: label="([^"]+)"/)?.[1];
  if (label) {
    state.modelLabel = label;
    state.model = agyModelId(label) || state.model || label;
  }

  const trace = line.match(/Trace:\s*(0x[0-9a-f]+)/i)?.[1];
  const isGeneration = /URL:\s+https?:\/\/[^ ]+\/v1internal:streamGenerateContent/.test(line);
  const isQuota = /Individual quota reached|RESOURCE_EXHAUSTED \(code 429\)|QUOTA_EXHAUSTED/.test(line);
  if (!isGeneration && !isQuota) return false;

  const eventTs = antigravityCliTs(line, file);
  const session = sessionForToolCwdTime('agy', state.cwd, eventTs);
  const project = session?.project_id ? store.getProject(session.project_id) : projectFor(state.cwd);
  const model = state.model || '(unknown)';
  const quotaReset = line.match(/Resets in\s+\S+/i)?.[0] || line.match(/quotaResetTimeStamp[=:"'\s]+([^"',\s]+)/i)?.[1] || '';
  const quotaSig = hash([file, Math.floor(eventTs / 1000), model, quotaReset].join('\0'));
  const sourceBase = isGeneration ? `antigravity-cli-call:${file}:${trace || hash(line)}` : `antigravity-cli-limit:${file}:${quotaSig}`;
  const msg = isGeneration
    ? `Antigravity CLI generation call${state.modelLabel ? ` (${state.modelLabel})` : ''}`
    : cleanAntigravityQuotaMessage(line);

  const ok = isGeneration
    ? recordUsage({
        source_id: sourceBase,
        source: 'antigravity-cli-log',
        event_type: 'agent-call',
        ts: eventTs,
        session_id: session?.id || null,
        tool: 'agy',
        provider: 'antigravity',
        model,
        project_id: project?.id || project?.project_id || null,
        project: project?.name || project?.project || null,
        cwd: state.cwd || null,
        message: msg,
        raw: { file, trace: trace || null, modelLabel: state.modelLabel || null },
      })
    : recordLimitEvent({
        source_id: sourceBase,
        source: 'antigravity-cli-log',
        ts: eventTs,
        session_id: session?.id || null,
        tool: 'agy',
        provider: 'antigravity',
        model,
        project_id: project?.id || project?.project_id || null,
        project: project?.name || project?.project || null,
        cwd: state.cwd || null,
        message: msg,
        raw: { file, trace: trace || null, modelLabel: state.modelLabel || null },
      });
  if (ok) counts.recorded++;
  return ok;
}

function cleanAntigravityQuotaMessage(line) {
  const msg = String(line || '')
    .replace(/^[IWEF]\d{4}\s+\S+\s+\d+\s+\S+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const resource = msg.match(/RESOURCE_EXHAUSTED \(code 429\):\s*Individual quota reached\.[^:]*?Resets in\s+\S+/i);
  if (resource) return resource[0].replace(/[.:]+$/, '');
  const individual = msg.match(/Individual quota reached\.[^\n]{0,260}/i);
  if (individual) return individual[0].replace(/[.:]+$/, '');
  const exhausted = msg.match(/QUOTA_EXHAUSTED[^\n]{0,260}/i);
  if (exhausted) return exhausted[0].replace(/[.:]+$/, '');
  return msg.slice(0, 500);
}

async function scanAntigravityCliLogFile(item, counts) {
  const { path, key, size } = item;
  const state = {};
  const cur = getCursor(key);
  if (cur?.meta) {
    try {
      Object.assign(state, JSON.parse(cur.meta));
    } catch {}
  }
  try {
    const rl = readline.createInterface({
      input: createReadStream(path, { start: 0 }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) parseAntigravityCliLine(line, path, state, counts);
    setCursor(key, path, size, { cwd: state.cwd || null, model: state.model || null, modelLabel: state.modelLabel || null });
    counts.files++;
  } catch {
    counts.errors++;
  }
}

function parseAntigravityStatuslineLine(line) {
  const o = JSON.parse(line);
  return recordAgyStatuslinePayload(o?.payload || o, { ts: o?.ts, session_id: o?.session_id || null });
}

function statuslineTs(v) {
  const t = ts(v);
  return t < 10_000_000_000 ? t * 1000 : t;
}

export function recordAgyStatuslinePayload(payload, meta = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const eventTs = statuslineTs(meta.ts || now());
  const cwd = payload.cwd || payload.workspace?.current_dir || null;
  const hintedSession = meta.session_id ? store.getSession(meta.session_id) : null;
  const session = hintedSession || sessionForToolCwdTime('agy', cwd, eventTs);
  const project = session?.project_id ? store.getProject(session.project_id) : projectFor(cwd);
  const ctx = payload.context_window || {};
  const cur = ctx.current_usage || {};
  const input = num(cur.input_tokens);
  const cacheCreation = num(cur.cache_creation_input_tokens);
  const cacheRead = num(cur.cache_read_input_tokens);
  const output = num(cur.output_tokens);
  const modelLabel = payload.model?.display_name || payload.model?.id || null;
  const model = agyModelId(modelLabel);
  const plan = payload.plan_tier || null;
  const used = Number(ctx.used_percentage);
  const usedText = Number.isFinite(used) ? `${used.toFixed(1)}% context` : 'context snapshot';
  const msg = [plan, modelLabel, usedText, payload.agent_state].filter(Boolean).join(' / ');
  const sourceKey = session?.id || payload.conversation_id || hash(JSON.stringify([cwd, model, payload.product]));
  return recordUsage({
    source_id: `antigravity-statusline:${sourceKey}`,
    source: 'antigravity-statusline',
    event_type: 'snapshot',
    ts: eventTs,
    session_id: session?.id || meta.session_id || null,
    external_session_id: payload.conversation_id || null,
    tool: 'agy',
    provider: 'antigravity',
    model,
    project_id: project?.id || project?.project_id || null,
    project: project?.name || project?.project || null,
    cwd,
    input_tokens: input,
    cached_input_tokens: cacheCreation + cacheRead,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    total_tokens: num(ctx.total_input_tokens) + num(ctx.total_output_tokens),
    message: msg,
    raw: {
      product: payload.product || null,
      version: payload.version || null,
      conversation_id: payload.conversation_id || null,
      plan_tier: plan,
      email: payload.email || null,
      model: payload.model || null,
      context_window: ctx,
      agent_state: payload.agent_state || null,
      workspace: payload.workspace || null,
      vcs: payload.vcs || null,
    },
  });
}

async function readRange(path, start, end) {
  const fh = await open(path, 'r');
  try {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf;
  } finally {
    await fh.close();
  }
}

function parseTerminalText(text, session, counts) {
  const plain = stripAnsi(text).replace(/\r/g, '\n');
  const usageRx = /Token usage:\s*total=([\d,]+)\s+input=([\d,]+)(?:\s*\(\+\s*([\d,]+)\s+cached\))?\s+output=([\d,]+)(?:\s*\(reasoning\s+([\d,]+)\))?/gi;
  const project = session.project_id ? store.getProject(session.project_id) : null;
  for (const m of plain.matchAll(usageRx)) {
    const total = num(m[1]);
    const input = num(m[2]);
    const cached = num(m[3]);
    const output = num(m[4]);
    const reasoning = num(m[5]);
    if (recordUsage({
      source_id: `terminal-summary:${session.id}:${hash(m[0])}`,
      source: 'terminal-summary',
      event_type: 'summary',
      ts: session.ended_at || session.last_activity || now(),
      session_id: session.id,
      tool: session.tool,
      provider: session.tool,
      model: session.model,
      project_id: project?.id || null,
      project: project?.name || null,
      cwd: project?.path || null,
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      reasoning_tokens: reasoning,
      total_tokens: total || input + output,
      message: m[0],
    })) counts.recorded++;
  }
  const limitRx = /(You've hit your usage limit\.[^\n]{0,260}|Approaching rate limits[^\n]{0,260}|(?:usage|rate) limit (?:reached|exceeded)[^\n]{0,260})/gi;
  for (const m of plain.matchAll(limitRx)) {
    const msg = m[1].replace(/\s+/g, ' ').slice(0, 300);
    const before = plain.slice(Math.max(0, m.index - 180), m.index);
    if (looksLikeLimitCodeSnippet(msg, before)) continue;
    if (recordLimitEvent({
      source_id: `terminal-limit:${session.id}:${hash(msg)}`,
      source: 'terminal-summary',
      ts: session.last_activity || now(),
      session_id: session.id,
      tool: session.tool,
      provider: session.tool,
      model: session.model,
      project_id: project?.id || null,
      project: project?.name || null,
      cwd: project?.path || null,
      message: msg,
    })) counts.recorded++;
  }
}

function looksLikeLimitCodeSnippet(msg, before = '') {
  const text = `${before} ${msg}`;
  return /terminal-summary\|limit\||antigravity-cli-log\|limit\||sqlite3 .*usage_events|usage limit check failed|usage limit reached'\)|limitRx|recordLimitEvent|source_id|e\.message|\)\);|\/status|\[\^\\?n\]|\.test\(line\)|message LIKE/i.test(String(text || ''));
}

async function scanTerminalLogs(counts) {
  for (const s of store.listSessions()) {
    const path = join(LOG_DIR, s.id + '.log');
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    const key = `terminal:${path}`;
    const cur = getCursor(key);
    let offset = cur ? Number(cur.offset) || 0 : Math.max(0, st.size - TERMINAL_TAIL_BYTES);
    if (st.size < offset) offset = 0;
    if (st.size <= offset) continue;
    const start = Math.max(0, offset - OVERLAP);
    try {
      const text = (await readRange(path, start, st.size)).toString('utf8');
      parseTerminalText(text, s, counts);
      setCursor(key, path, st.size);
      counts.files++;
    } catch {
      counts.errors++;
    }
  }
}

async function scanClaudeJsonl(counts, maxFiles = JSONL_MAX_FILES) {
  const files = await walk(CLAUDE_PROJECTS_DIR, (p) => p.endsWith('.jsonl'));
  for (const item of await pendingFiles(files, 'claude-jsonl', maxFiles)) {
    await scanJsonlFile(item, parseClaudeLine, counts);
  }
}

async function scanCodexJsonl(counts, maxFiles = JSONL_MAX_FILES) {
  const files = await walk(CODEX_SESSIONS_DIR, (p) => p.endsWith('.jsonl'));
  for (const item of await pendingFiles(files, 'codex-jsonl', maxFiles)) {
    if (item.offset > 0) await hydrateCodexMeta(item.path);
    await scanJsonlFile(item, parseCodexLine, counts);
  }
}

async function scanAntigravityUsage(counts) {
  let st;
  try {
    st = await stat(ANTIGRAVITY_USAGE);
  } catch {
    return;
  }
  const key = `antigravity-jsonl:${ANTIGRAVITY_USAGE}`;
  const item = { path: ANTIGRAVITY_USAGE, key, size: st.size, offset: Math.max(0, Number(getCursor(key)?.offset) || 0) };
  if (item.offset >= item.size) return;
  await scanJsonlFile(item, parseAntigravityLine, counts);
}

async function scanAntigravityStatusline(counts) {
  let st;
  try {
    st = await stat(ANTIGRAVITY_STATUSLINE_LOG);
  } catch {
    return;
  }
  const key = `antigravity-statusline:${ANTIGRAVITY_STATUSLINE_LOG}`;
  const item = { path: ANTIGRAVITY_STATUSLINE_LOG, key, size: st.size, offset: Math.max(0, Number(getCursor(key)?.offset) || 0) };
  if (item.offset >= item.size) return;
  await scanJsonlFile(item, parseAntigravityStatuslineLine, counts);
}

async function scanAntigravityCliLogs(counts, maxFiles = JSONL_MAX_FILES) {
  const files = await walk(ANTIGRAVITY_CLI_LOG_DIR, (p) => /^cli-\d{8}_\d{6}\.log$/.test(basename(p)));
  for (const item of await pendingFiles(files, 'antigravity-cli-log', maxFiles)) {
    await scanAntigravityCliLogFile(item, counts);
  }
}

export async function scanUsageOnce({ maxFiles = JSONL_MAX_FILES } = {}) {
  const counts = { files: 0, recorded: 0, errors: 0 };
  await scanTerminalLogs(counts);
  await scanAntigravityStatusline(counts);
  await scanAntigravityCliLogs(counts, maxFiles);
  await scanAntigravityUsage(counts);
  await scanCodexJsonl(counts, maxFiles);
  await scanClaudeJsonl(counts, maxFiles);
  return counts;
}

export async function rescanUsage({ resetCursors = false, maxFiles = JSONL_MAX_FILES } = {}) {
  if (resetCursors) {
    for (const p of ['terminal:', 'antigravity-statusline:', 'antigravity-cli-log:', 'antigravity-jsonl:', 'codex-jsonl:', 'claude-jsonl:']) deleteCursors(p);
  }
  return await scanUsageOnce({ maxFiles });
}

async function fetchJson(url, timeout = 2500) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return await r.json();
}

function secondsReset(sec) {
  return sec == null ? null : now() + Number(sec) * 1000;
}

async function buildSubscriptionStatus() {
  const out = {
    generatedAt: now(),
    routing: null,
    subscriptions: [],
    errors: [],
  };
  const settledFetch = (url, timeout) => fetchJson(url, timeout).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  // Start every independent fleet probe before awaiting any of them. These used to run serially, so
  // the Usage screen paid the sum of three proxy latencies instead of only the slowest one.
  const codexRequest = settledFetch('http://127.0.0.1:8788/admin/limits');
  const claudeRequest = settledFetch('http://127.0.0.1:8789/admin/limits');
  const overviewRequest = settledFetch('http://127.0.0.1:8791/admin/overview', 3500);

  try {
    const result = await codexRequest;
    if (result.error) throw result.error;
    const c = result.value;
    const u = c.usage || {};
    const rl = u.rate_limit || {};
    out.subscriptions.push({
      id: 'codex',
      label: 'Codex',
      ok: !!c.ok,
      plan: u.plan_type || null,
      account: u.email || u.account_id || null,
      windows: [
        rl.primary_window && { name: '5h', usedPercent: rl.primary_window.used_percent, remainingPercent: 100 - Number(rl.primary_window.used_percent || 0), resetAt: secondsReset(rl.primary_window.reset_after_seconds) },
        rl.secondary_window && { name: 'weekly', usedPercent: rl.secondary_window.used_percent, remainingPercent: 100 - Number(rl.secondary_window.used_percent || 0), resetAt: secondsReset(rl.secondary_window.reset_after_seconds) },
      ].filter(Boolean),
      credits: u.credits || null,
      raw: { cached: c.cached, additional_rate_limits: u.additional_rate_limits || [] },
    });
  } catch (e) {
    out.errors.push({ id: 'codex', error: String(e.message || e) });
  }

  try {
    const result = await claudeRequest;
    if (result.error) throw result.error;
    const c = result.value;
    const u = c.usage || {};
    const win = (name, o) => o && {
      name,
      usedPercent: o.utilization,
      remainingPercent: 100 - Number(o.utilization || 0),
      resetAt: Date.parse(o.resets_at) || null,
    };
    out.subscriptions.push({
      id: 'claude',
      label: 'Claude',
      ok: !!c.ok,
      windows: [
        win('5h', u.five_hour),
        win('weekly', u.seven_day),
        win('weekly-sonnet', u.seven_day_sonnet),
        win('weekly-opus', u.seven_day_opus),
      ].filter(Boolean),
      credits: u.extra_usage || null,
      raw: { cached: c.cached },
    });
  } catch (e) {
    out.errors.push({ id: 'claude', error: String(e.message || e) });
  }

  try {
    const result = await overviewRequest;
    if (result.error) throw result.error;
    const ov = result.value;
    out.routing = ov.routing || null;
    for (const p of ov.providers || []) {
      const id = p.id || p.proxy || p.name || p.label || `provider-${out.subscriptions.length}`;
      if ((id === 'codex' || id === 'claude') && out.subscriptions.some((s) => s.id === id)) continue;
      const live = p.quota?.live || null;
      const windows = [];
      for (const w of live?.windows || []) windows.push({ name: w.name, remainingPercent: w.remainingPercent, resetAt: w.resetsAt ? Date.parse(w.resetsAt) : secondsReset(w.resetInSeconds) });
      const label = id === 'antigravity' ? 'Antigravity Proxy' : p.label || p.headline || p.proxy || p.name || p.id || 'provider';
      out.subscriptions.push({
        id,
        label,
        ok: !!p.live?.up,
        plan: p.live?.tierName || p.live?.tier || live?.tierName || live?.tier || null,
        quotaKind: p.quota?.kind || null,
        quotaSource: p.quota?.source || null,
        windows,
        manualUsage: live?.percentLeft != null ? live : null,
        raw: { credential: p.credential || null, outbound: p.live?.outbound || null },
      });
    }
  } catch (e) {
    out.errors.push({ id: 'proxy-overview', error: String(e.message || e) });
  }

  const agy = latestAgyStatusline();
  if (agy?.raw_json) {
    const ctx = agy.raw_json.context_window || {};
    out.subscriptions.push({
      id: 'agy',
      label: 'Antigravity CLI',
      ok: true,
      plan: agy.raw_json.plan_tier || null,
      account: agy.raw_json.email || null,
      quotaKind: 'statusline',
      quotaSource: 'agy 1.0.6 statusline',
      windows: [],
      raw: {
        ts: agy.ts,
        model: agy.raw_json.model || null,
        agent_state: agy.raw_json.agent_state || null,
        context_window: {
          total_input_tokens: ctx.total_input_tokens || 0,
          total_output_tokens: ctx.total_output_tokens || 0,
          context_window_size: ctx.context_window_size || 0,
          used_percentage: ctx.used_percentage || 0,
          remaining_percentage: ctx.remaining_percentage || 0,
        },
      },
    });
  }

  return out;
}

const SUBSCRIPTION_CACHE_MS = Math.max(1000, Number(process.env.AIOS_SUBSCRIPTION_CACHE_MS || 30000));
let subscriptionCache = null;
let subscriptionFlight = null;
export async function subscriptionStatus() {
  if (subscriptionCache && now() - subscriptionCache.at < SUBSCRIPTION_CACHE_MS) return subscriptionCache.value;
  if (subscriptionFlight) return subscriptionFlight;
  subscriptionFlight = buildSubscriptionStatus()
    .then((value) => {
      subscriptionCache = { at: now(), value };
      return value;
    })
    .finally(() => { subscriptionFlight = null; });
  return subscriptionFlight;
}

export function startUsageCollector() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await scanUsageOnce();
      if (r.recorded) console.log(`[aios] usage scan: ${r.recorded} new event(s), ${r.files} file(s)`);
    } catch (e) {
      console.error('[aios] usage scan failed:', e.message);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 1500);
  setInterval(run, Number(process.env.AIOS_USAGE_SCAN_MS || 60000));
}

export function recordAnthropicShimUsage({ requestBody, responseHeaders, usage, status, path }) {
  if (!usage) return false;
  let body = {};
  try {
    body = requestBody ? JSON.parse(Buffer.isBuffer(requestBody) ? requestBody.toString('utf8') : String(requestBody)) : {};
  } catch {}
  const requestId =
    responseHeaders?.get?.('request-id') ||
    responseHeaders?.get?.('anthropic-request-id') ||
    responseHeaders?.get?.('x-request-id') ||
    null;
  const sourceKey = requestId || randomUUID();
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  return recordUsage({
    source_id: `aios-claude-shim:${sourceKey}`,
    source: 'aios-claude-shim',
    event_type: 'usage',
    ts: now(),
    request_id: requestId,
    tool: 'claude',
    provider: 'claude',
    model: body.model || null,
    input_tokens: input,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cached_input_tokens: num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    output_tokens: output,
    total_tokens: input + output,
    raw: { status, path },
  });
}

export function mergeAnthropicUsage(prev, next) {
  if (!next || typeof next !== 'object') return prev;
  const out = { ...(prev || {}) };
  for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    if (next[k] != null) out[k] = Math.max(num(out[k]), num(next[k]));
  }
  return out;
}
