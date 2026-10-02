// Deterministic "session space map": a task → subtask → tool-call hierarchy parsed straight from the
// agent's own transcript, sized by real tokens/$/time. NO LLM, NO manual action — it auto-rebuilds as
// the session grows (cheap mtime-gated sweep). The same structure powers both the "Solar" (sized
// hierarchy) and "Flow" (request spine) views. The atomic costed unit is one assistant TURN (it carries
// message.usage); turns cluster into subtasks by category; clusters group under the user requests
// (systems). Cost via the shared priceUsage(); transcript shapes mirror usage_collect.js parseClaude/Codex.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, stat, open } from 'node:fs/promises';
import { db, getProject, listSessions } from './store.js';
import { now } from './util.js';
import { SPACE_VERSION, tsMs, contentText, hasToolResult } from './session_space_parser.js';
import { readSpace, readTranscriptRange } from './session_space_reader.js';
import { codexRolloutFiles, pickRolloutByUuid } from './codex_rollouts.js';
import { bus } from './bus.js';
import { applyLabels, labelSettled, labelReady } from './session_labels.js';

const CLAUDE_DIR = process.env.AIOS_USAGE_CLAUDE_DIR || join(homedir(), '.claude', 'projects');
const CODEX_DIR = process.env.AIOS_USAGE_CODEX_DIR || join(homedir(), '.codex', 'sessions');
const MAX_FILE_BYTES = Number(process.env.AIOS_SPACE_MAX_BYTES || 32 * 1024 * 1024);
const SWEEP_MS = Number(process.env.AIOS_SPACE_SWEEP_MS || 8000);

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
const _getMeta = db.prepare('SELECT version, source_file, source_mtime FROM session_space WHERE session_id = ?');
const _upsert = db.prepare(`
  INSERT INTO session_space (session_id, version, tool, built_at, source_file, source_mtime, space_json)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET
    version=excluded.version, tool=excluded.tool, built_at=excluded.built_at,
    source_file=excluded.source_file, source_mtime=excluded.source_mtime, space_json=excluded.space_json
`);

export function getSessionSpace(sid) {
  const row = _get.get(sid);
  if (!row || row.version !== SPACE_VERSION) return null;
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
  if (session.claude_transcript) {
    const st = await stat(session.claude_transcript).catch(() => null);
    return st ? { file: session.claude_transcript, mtime: st.mtimeMs } : null;
  }
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

// Captured conversation identity wins over cwd (sessions commonly use their own worktrees).
const codexPaths = new Map();
let codexInventory = null, codexInventoryAt = 0, inventoryFlight = null;
async function rolloutInventory() {
  if (codexInventory && now() - codexInventoryAt < 30_000) return codexInventory;
  if (!inventoryFlight) inventoryFlight = codexRolloutFiles(CODEX_DIR).then(files => {
    codexInventory = files.sort().reverse();
    codexInventoryAt = now();
    return codexInventory;
  }).finally(() => { inventoryFlight = null; });
  return inventoryFlight;
}
async function findCodexFile(session, project) {
  if (session.codex_uuid) {
    let file = codexPaths.get(session.codex_uuid);
    if (!file) file = pickRolloutByUuid(await rolloutInventory(), session.codex_uuid);
    if (file) {
      const st = await stat(file).catch(() => null);
      if (st) { codexPaths.set(session.codex_uuid, file); return { file, mtime: st.mtimeMs }; }
      codexPaths.delete(session.codex_uuid);
    }
    return null; // Never attribute a sibling conversation to an explicitly bound session.
  }
  if (!project?.path) return null;
  const files = await rolloutInventory();
  const startWin = Number(session.started_at || 0) - 10 * 60_000;
  for (const f of files.slice(0, 120)) {
    const st = await stat(f).catch(() => null);
    if (!st || st.mtimeMs < startWin) continue;
    const head = await readTranscriptRange(f).then(buffer => buffer.toString('utf8')).catch(() => '');
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
  let space, mt;
  try {
    ({ space, mtime: mt } = await readSpace({ file: loc.file, session, maxBytes: MAX_FILE_BYTES }));
  } catch {
    return getSessionSpace(session.id);
  }
  const stored = storeSpace(session.id, { tool: session.tool, file: loc.file, mtime: mt, space });
  // the structure (re)built -> there may be new/changed requests to label; let the labeler re-evaluate,
  // and kick an immediate pass so labels start appearing the moment a session is opened or grows.
  if (space && labelReady()) {
    labelDone.delete(session.id);
    labelSettled(session, space).then((done) => { if (done) labelDone.add(session.id); }).catch((e) => console.error('[aios] labelSettled:', e?.message || e));
  }
  return stored;
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
    const length = Math.max(0, Math.min(80_000, found.source.end - found.source.start));
    const slice = (await readTranscriptRange(row.source_file, found.source.start, length)).toString('utf8');
    return { node: nodeId, file: row.source_file, text: slice.slice(0, 20000) };
  } catch {
    return null;
  }
}

// ---- auto-build sweep (cheap, mtime-gated; the deterministic build is no-LLM) ---------------------
let sweeping = false;
const labelDone = new Set(); // sessions whose settled requests are fully labeled (gates the supplemental
// label pass so we don't re-read/re-check forever); cleared by buildSessionSpace when the structure changes.
const rebuilds = new Map();
async function maybeRebuild(session) {
  if (rebuilds.has(session.id)) return rebuilds.get(session.id);
  const flight = rebuildIfChanged(session).finally(() => rebuilds.delete(session.id));
  rebuilds.set(session.id, flight);
  return flight;
}
async function rebuildIfChanged(session) {
  const loc = await locate(session);
  if (!loc?.file) {
    // Retired sessions with no transcript should not rescan the inventory on every background sweep.
    if (session.status === 'exited' && !_getMeta.get(session.id)) {
      storeSpace(session.id, { tool: session.tool, file: null, mtime: 0, space: null });
    }
    return;
  }
  const st = await stat(loc.file).catch(() => null);
  if (!st) return;
  const row = _getMeta.get(session.id);
  if (row && row.version === SPACE_VERSION && row.source_file === loc.file && Number(row.source_mtime) >= Math.floor(st.mtimeMs)) return;
  await buildSessionSpace(session, loc);
}
async function sweepOnce() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const s of listSessions()) {
      if (s.tool !== 'claude' && s.tool !== 'codex') continue;
      const built = _getMeta.get(s.id);
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
    debounce = setTimeout(() => { debounce = null; sweepOnce().catch(() => {}); }, 1500);
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
