// Story view API (design handoff, phase 1): GET /api/session/:id/story returns the session's log
// re-parsed as plain-language story events (src/story.js — the handoff's verified drop-in parser).
// Locates the session's NATIVE transcript (not the tmux pipe log): codex rollout JSONL by cwd match,
// claude project JSONL by cwd-slug + session time window. Cached by file mtime — a 200MB rollout is
// only re-parsed when it actually grew.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { route, json } from './server.js';
import { getSession, getProject } from './store.js';
import { parseSessionLog } from './story.js';

const cache = new Map(); // sid -> { file, mtimeMs, events, meta }

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
        const items = Array.isArray(j?.toolUseResult?.content) ? j.toolUseResult.content
          : Array.isArray(j?.message?.content) ? j.message.content : [];
        for (const it of items) {
          const src = it?.type === 'image' ? it.source : null;
          if (src?.type === 'base64' && src.data && src.data.length < 900_000) {
            shots.push({ ts: Date.parse(j.timestamp || 0) || 0, url: `data:${src.media_type || 'image/png'};base64,${src.data}` });
          }
        }
      } catch {}
    }
    for (const sh of shots.slice(-4)) {
      const ev = events.find((e) => !e.shot && ['check', 'edit', 'work'].includes(e.kind) && Math.abs((e.ts || 0) - sh.ts) < 180e3)
        || events.find((e) => !e.shot && e.kind === 'check');
      if (ev) ev.shot = sh.url;
    }
  } catch {}
}

export async function storyFor(sid) {
  const s = getSession(sid);
  if (!s) return { error: 'no such session' };
  const project = s.project_id ? getProject(s.project_id) : null;
  const cwd = project?.path || null;
  const file = s.tool === 'codex' ? await findCodexLog(cwd, s) : await findClaudeLog(cwd, s);
  if (!file) return { events: [], meta: { file: null, note: 'no native transcript found for this session yet' } };
  const st = await stat(file);
  const hit = cache.get(sid);
  if (hit && hit.file === file && hit.mtimeMs === st.mtimeMs) return { events: hit.events, meta: hit.meta };
  const text = await readFile(file, 'utf8');
  const events = parseSessionLog(text);
  attachShots(text, events); // the drop-in parser stays verbatim; thumbnails enrich here
  const meta = { file, mtimeMs: st.mtimeMs, count: events.length };
  cache.set(sid, { file, mtimeMs: st.mtimeMs, events, meta });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return { events, meta };
}

route('GET', '/api/session/:id/story', async (req, res, { id: sid }) => {
  try {
    const r = await storyFor(sid);
    if (r.error) return json(res, 404, { error: r.error });
    json(res, 200, { ok: true, ...r });
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});
