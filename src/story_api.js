// Story view API (design handoff, phase 1): GET /api/session/:id/story returns the session's log
// re-parsed as plain-language story events (src/story.js — the handoff's verified drop-in parser).
// Locates the session's NATIVE transcript (not the tmux pipe log): codex rollout JSONL by cwd match,
// claude project JSONL by cwd-slug + session time window. Cached by file mtime — a 200MB rollout is
// only re-parsed when it actually grew.
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { route, json } from './server.js';
import { getSession, getProject } from './store.js';
import { parseSessionLog } from './story.js';

const cache = new Map(); // key -> { file, mtimeMs, events, meta }

// Instant load: transcripts run to 80–200 MB, and reading+parsing the whole thing on every open is
// the slowness. Most users only need the recent conversation, so by default we read just the TAIL
// and keep the last few OPERATOR rounds (a round = one operator message → everything until the next;
// supervisor '[Supervisor] …' messages are shown but do NOT count as round boundaries). ?full=1
// reads the whole file; ?rounds=N tunes the window.
const DEFAULT_ROUNDS = 3;
const FULL_PARSE_UNDER = 1_200_000; // small transcripts: parse whole (already instant)
const TAIL_START_BYTES = 3_000_000;
const TAIL_CAP_BYTES = 32_000_000; // never scan more than this for the recent view
const SUPERVISOR_RX = /^\s*\[supervisor\]/i;

function isOperatorYou(e) {
  return e.kind === 'you' && !SUPERVISOR_RX.test(e.body || e.title || '');
}
// Keep events from the Nth-from-last operator message onward. Returns { events, trimmed }.
function trimToRecentRounds(events, rounds) {
  if (!rounds) return { events, trimmed: false };
  const opIdx = [];
  for (let i = 0; i < events.length; i++) if (isOperatorYou(events[i])) opIdx.push(i);
  if (opIdx.length <= rounds) return { events, trimmed: false };
  return { events: events.slice(opIdx[opIdx.length - rounds]), trimmed: true };
}
// Read the last `bytes` of a file, dropping the partial first line so parseSessionLog sees whole lines.
async function readTailBytes(file, bytes, size) {
  const fh = await open(file, 'r');
  try {
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let s = buf.toString('utf8');
    if (start > 0) { const nl = s.indexOf('\n'); if (nl >= 0) s = s.slice(nl + 1); }
    return s;
  } finally { await fh.close(); }
}

async function readHead(file, bytes = 4096) {
  const fh = await (await import('node:fs/promises')).open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

// codex: newest rollout whose session_meta cwd matches the project dir and whose file lifetime
// overlaps the session (started_at .. ended_at|now). Same walk as sessions.js findCodexSession.
async function findCodexLog(cwd, s) {
  const base = join(homedir(), '.codex', 'sessions');
  const files = [];
  async function walk(dir, depth) {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  }
  await walk(base, 0);
  files.sort().reverse();
  for (const f of files.slice(0, 120)) {
    try {
      const st = await stat(f);
      if (s?.started_at && st.mtimeMs < s.started_at - 120e3) continue; // ended before this session began
      const head = await readHead(f);
      const cm = head.match(/"cwd":\s*"([^"]+)"/);
      if (cm && cm[1] === cwd) return f;
    } catch {}
  }
  return null;
}

// claude: ~/.claude/projects/<slugged-cwd>/<uuid>.jsonl — pick the transcript whose mtime overlaps
// the session window; largest wins on ties (resumed conversations keep appending to one file).
function claudeSlug(cwd) { return String(cwd || '').replace(/[/.]/g, '-'); }
async function findClaudeLog(cwd, s) {
  const dir = join(homedir(), '.claude', 'projects', claudeSlug(cwd));
  let ents;
  try { ents = await readdir(dir); } catch { return null; }
  const cands = [];
  for (const name of ents) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (s?.started_at && st.mtimeMs < s.started_at - 120e3) continue;
      cands.push({ p, size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  }
  cands.sort((a, b) => b.size - a.size);
  return cands[0]?.p || null;
}

// Screenshot thumbnails: claude transcripts embed image tool-results as base64. Attach the LAST
// few as data-URLs to the nearest following check/edit/work event (payload-bounded: 4 shots max).
function attachShots(text, events) {
  try {
    const shots = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"image"')) continue;
      try {
        const j = JSON.parse(line);
        const ts = Date.parse(j.timestamp || 0) || 0;
        // Images live in several shapes: toolUseResult.content[], message.content[], and — for tool
        // results — DOUBLY nested at message.content[i].content[j] (a tool_result block's content).
        // Walk shallowly through content arrays and collect any base64 image node.
        const roots = [j?.toolUseResult?.content, j?.message?.content].filter(Array.isArray);
        const collect = (arr, depth) => {
          for (const it of arr) {
            if (it?.type === 'image' && it.source?.type === 'base64' && it.source.data && it.source.data.length < 900_000) {
              shots.push({ ts, url: `data:${it.source.media_type || 'image/png'};base64,${it.source.data}` });
            } else if (depth < 2 && Array.isArray(it?.content)) collect(it.content, depth + 1);
          }
        };
        for (const r of roots) collect(r, 0);
      } catch {}
    }
    for (const sh of shots.slice(-4)) {
      const ev = events.find((e) => !e.shot && ['check', 'edit', 'work'].includes(e.kind) && Math.abs((e.ts || 0) - sh.ts) < 180e3)
        || events.find((e) => !e.shot && e.kind === 'check');
      if (ev) ev.shot = sh.url;
    }
  } catch {}
}

export async function storyFor(sid, { rounds = DEFAULT_ROUNDS, full = false } = {}) {
  const s = getSession(sid);
  if (!s) return { error: 'no such session' };
  const project = s.project_id ? getProject(s.project_id) : null;
  const cwd = project?.path || null;
  const file = s.tool === 'codex' ? await findCodexLog(cwd, s) : await findClaudeLog(cwd, s);
  if (!file) return { events: [], meta: { file: null, note: 'no native transcript found for this session yet' } };
  const st = await stat(file);
  const key = `${sid}|${full ? 'full' : 'r' + rounds}`;
  const hit = cache.get(key);
  if (hit && hit.file === file && hit.mtimeMs === st.mtimeMs) return { events: hit.events, meta: hit.meta };

  let events, trimmed = false, scannedWhole = true;
  if (full || st.size <= FULL_PARSE_UNDER) {
    const text = await readFile(file, 'utf8');
    events = parseSessionLog(text);
    attachShots(text, events);
    if (!full) ({ events, trimmed } = trimToRecentRounds(events, rounds));
  } else {
    // read a growing tail until it holds `rounds` operator messages (or we hit the cap / file start)
    let bytes = TAIL_START_BYTES;
    for (;;) {
      const readWhole = bytes >= st.size;
      const text = readWhole ? await readFile(file, 'utf8') : await readTailBytes(file, bytes, st.size);
      const parsed = parseSessionLog(text);
      attachShots(text, parsed);
      const opCount = parsed.filter(isOperatorYou).length;
      if (opCount >= rounds || readWhole || bytes >= TAIL_CAP_BYTES) {
        ({ events, trimmed } = trimToRecentRounds(parsed, rounds));
        scannedWhole = readWhole;
        if (!readWhole) trimmed = true; // there is definitely older history we didn't read
        break;
      }
      bytes *= 2;
    }
  }
  const meta = { file, mtimeMs: st.mtimeMs, count: events.length, trimmed, full: full || scannedWhole, rounds };
  cache.set(key, { file, mtimeMs: st.mtimeMs, events, meta });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return { events, meta };
}

route('GET', '/api/session/:id/story', async (req, res, { id: sid }, url) => {
  try {
    const full = url?.searchParams?.get('full') === '1';
    const rounds = Math.max(1, Math.min(20, Number(url?.searchParams?.get('rounds')) || DEFAULT_ROUNDS));
    const r = await storyFor(sid, { rounds, full });
    if (r.error) return json(res, 404, { error: r.error });
    // Live session status (NOT baked into storyFor's cached meta — status changes far more often than
    // the transcript) so the story view can show a calming "working" animation while the agent runs.
    const s = getSession(sid);
    json(res, 200, { ok: true, ...r, status: s?.status || null });
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});
