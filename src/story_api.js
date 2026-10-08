// Story view API (design handoff, phase 1): GET /api/session/:id/story returns the session's log
// re-parsed as plain-language story events (src/story.js — the handoff's verified drop-in parser).
// Locates the session's NATIVE transcript (not the tmux pipe log): codex rollout JSONL by cwd match,
// claude project JSONL by cwd-slug + session time window. Cached by file mtime — a 200MB rollout is
// only re-parsed when it actually grew. Parsing/large-file reads run in a bounded worker pool.
import { stat, open } from 'node:fs/promises';
import { route, json } from './server.js';
import { getSession, getProject, db, messagesFor, otherClaudeTranscripts } from './store.js';
import { findClaudeLog } from './claude_transcripts.js';
import { readStoryPage } from './story_reader.js';
import { snapshot } from './sessions.js';
import { pickRolloutByUuid, codexRolloutFiles } from './codex_rollouts.js';
import { bindCodexLaunchTranscript } from './codex_transcript_binding.js';
import { spineFromMessages } from './story_spine.js';
import { stripAnsi } from './util.js';
import { terminalQuestionPrompt } from './detect_classify.js';
import { refreshCodexQuestions, overlayCodexQuestions } from './codex_questions.js';
import { claudeTerminalFrame } from './claude_lifecycle.js';
import { createStoryUpdates } from './story_updates.js';
import { bus } from './bus.js';

// Pull the CLI's OWN live status line out of the pane tail so the story shows the real agent status
// instead of a generic "working…". Claude renders "✢ Roosting… (1m 57s · ↓ 6.8k tokens)"; codex renders
// "Working (10s · esc to interrupt) · 5 background terminals running". Returns {verb, detail, bg} or null.
function cleanDetail(d) {
  return String(d || '')
    .replace(/\besc(ape)?\s+to\s+interrupt\b/gi, '')
    .replace(/·\s*·/g, '·')
    .replace(/^[\s·|]+|[\s·|]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}
export function extractLiveStatus(snap) {
  const frame = claudeTerminalFrame(snap);
  const lines = stripAnsi(frame ? `${frame.processing ? frame.recent : ''}\n${frame.footer}` : String(snap || ''))
    .split('\n').map((l) => l.trim()).filter(Boolean).slice(-16);
  let verb = null, detail = null, bg = frame?.count > 0 ? frame.background : null;
  for (const l of lines.reverse()) {
    if (!verb) {
      // claude: a Capitalized gerund + a parenthetical carrying an elapsed timer and/or a token count
      let m = l.match(/([A-Z][a-z]{2,}…)\s*\(([^)]*(?:\d+\s*s|token)[^)]*)\)/);
      // codex/claude: "Working (10s · esc to interrupt)" and friends
      if (!m) m = l.match(/\b(Working|Thinking|Running|Generating|Reading|Editing|Applying|Planning|Compacting|Summarizing)\b[^(]{0,3}\((\s*\d+\s*s[^)]*)\)/i);
      if (m) { verb = /…$/.test(m[1]) ? m[1] : m[1] + '…'; detail = cleanDetail(m[2]); }
    }
    if (!bg) {
      const b = l.match(/(\d+)\s+background\s+terminals?\s+running/i);
      if (b) bg = `${b[1]} bg ${b[1] === '1' ? 'terminal' : 'terminals'}`;
    }
    if (verb && bg) break;
  }
  if (!verb && !bg) return null;
  return { verb: verb || 'Working…', detail: detail || '', bg };
}

// #132 guaranteed story: when no native CLI transcript can be located, reconstruct the story from AIOS's
// OWN captured data. The REAL message text lives in the `messages` table (messagesFor), attributed by
// `source` via story_spine.messageToEvent — so the operator's actual words show (not char-count
// placeholders), detect terminal-snapshot noise is dropped, and agent/supervisor injections are labeled
// instead of masquerading as operator bubbles. Session lifecycle markers come from the events table.
const _lifecycleEvents = db.prepare(
  `SELECT ts, type FROM events WHERE session_id = ? AND type IN ('launch','resume','exit') ORDER BY ts ASC LIMIT 50`,
);
const _freshQueuedLaunch = db.prepare("SELECT 1 FROM events WHERE session_id = ? AND type = 'launch-queued' LIMIT 1");
function fallbackStory(sid) {
  const life = _lifecycleEvents.all(sid).map((r) => ({
    ts: r.ts,
    kind: 'sys',
    text: r.type === 'launch' ? 'Session launched.' : r.type === 'resume' ? 'Session resumed.' : 'Session exited.',
  }));
  const msgs = spineFromMessages(messagesFor(sid, 400));
  const events = [...life, ...msgs].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return events;
}

const cache = new Map(); // key -> { file, mtimeMs, events, meta }
const inFlight = new Map();
const rolloutPaths = new Map();
let rolloutInventory = null;
let inventoryAt = 0;
let inventoryFlight = null;
async function rolloutFiles(force = false) {
  if (!force && rolloutInventory && Date.now() - inventoryAt < 30_000) return rolloutInventory;
  if (!inventoryFlight) inventoryFlight = codexRolloutFiles().then(files => {
    rolloutInventory = files.sort().reverse(); inventoryAt = Date.now(); return rolloutInventory;
  }).finally(() => { inventoryFlight = null; });
  return inventoryFlight;
}

// Instant load: transcripts run to 80–200 MB, and reading+parsing the whole thing on every open is
// the slowness. Most users only need the recent conversation, so by default we read just the TAIL
// and keep the last few OPERATOR rounds (a round = one operator message → everything until the next;
// supervisor '[Supervisor] …' messages are shown but do NOT count as round boundaries). ?full=1
// reads the whole file; ?rounds=N tunes the window.
const DEFAULT_ROUNDS = 1; // instant first paint: one COMPLETED round (request → report; ?rounds=N for more)
// Round semantics + trimming live in story.js (pure, testable): a round = an operator request whose
// turn reached a completed report; in-flight requests ride along without counting.
async function readHead(file, bytes = 4096) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

// codex: locate this session's rollout. PREFER the UUID captured at launch (store.codex_uuid) — codex
// names rollouts rollout-<ISO>-<uuid>.jsonl, so the UUID is the trailing filename component and matches
// regardless of the rollout's recorded cwd (the operator's cwd-mismatch case, e.g. a sandboxed workspace
// whose cwd ≠ the AIOS project path). FALL BACK to the newest rollout whose session_meta cwd matches the
// project dir and whose lifetime overlaps the session (started_at .. ended_at|now); then the clean
// fallback story upstream. Same walk as sessions.js findCodexSession.
async function findCodexLog(cwd, s) {
  const bound = s?.codex_uuid && rolloutPaths.get(s.codex_uuid);
  if (bound) {
    try { await stat(bound); return bound; } catch { rolloutPaths.delete(s.codex_uuid); }
  }
  let files = await rolloutFiles();
  // 1) captured UUID — authoritative, cwd-independent. The UUID is the full trailing filename component.
  if (s?.codex_uuid) {
    let hit = pickRolloutByUuid(files, s.codex_uuid);
    if (!hit) { files = await rolloutFiles(true); hit = pickRolloutByUuid(files, s.codex_uuid); }
    if (hit) { rolloutPaths.set(s.codex_uuid, hit); return hit; }
    return null; // an authoritative but missing UUID must never fall through to a sibling
  }
  // A fresh queued launch has no safe cwd fallback: another Codex session in the same project can be
  // newer and would disclose/merge that conversation before this launch captures its UUID. Show the
  // session's own AIOS message spine until the authoritative rollout identity arrives. Pre-queue legacy
  // rows retain cwd lookup for backward compatibility.
  if (s?.id && _freshQueuedLaunch.get(s.id)) {
    let recovered = await bindCodexLaunchTranscript(s.id, { files });
    // A file can appear just after the previous Story request. Refresh the shared inventory at
    // most once per second for unresolved launches, rather than hiding it behind a 30s cache miss.
    if (!recovered && Date.now() - inventoryAt >= 1000) {
      recovered = await bindCodexLaunchTranscript(s.id, { files: await rolloutFiles(true) });
    }
    return recovered;
  }
  // 2) cwd match (legacy path — sessions without a captured UUID, or whose workspace path lines up).
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

// claude transcript location lives in claude_transcripts.js (hook-bound path first, heuristic after —
// see that module for the multi-session-per-cwd story-bleed this replaced).

async function storySource(sid) {
  const s = getSession(sid);
  if (!s) return null;
  const project = s.project_id ? getProject(s.project_id) : null;
  const cwd = s.tool === 'claude' ? s.worktree_path || project?.path || null : project?.path || null;
  const file = s.tool === 'codex'
    ? await findCodexLog(cwd, s)
    : await findClaudeLog(cwd, s, { claimed: otherClaudeTranscripts(sid) });
  return { s, file };
}

export async function storyFor(sid, { rounds = DEFAULT_ROUNDS, full = false, cursor = null } = {}) {
  const source = await storySource(sid);
  if (!source) return { error: 'no such session' };
  const { file } = source;
  if (!file) {
    const events = fallbackStory(sid);
    return { events, meta: { file: null, source: 'fallback', count: events.length, note: events.length ? 'reconstructed from AIOS’s own message log (native CLI transcript not found)' : 'no messages recorded for this session yet' } };
  }
  const st = await stat(file);
  const key = `${sid}|${full ? 'full' : 'r' + rounds}|${cursor || ''}`;
  const hit = cache.get(key);
  if (hit && hit.file === file && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) return { events: hit.events, meta: hit.meta };
  const flightKey = `${key}|${file}|${st.ino}|${st.size}|${st.mtimeMs}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);
  const flight = readStoryPage({ file, rounds, full, cursor }).then(result => {
    const { events } = result;
    const meta = { ...result.meta, file, mtimeMs: st.mtimeMs, source: 'transcript' };
    cache.set(key, { file, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, events, meta });
    if (cache.size > 120) cache.delete(cache.keys().next().value);
    return { events, meta };
  }).finally(() => { inFlight.delete(flightKey); });
  inFlight.set(flightKey, flight);
  return flight;
}

const storyUpdates = createStoryUpdates({ bus, resolve: async sid => {
  const source = await storySource(sid);
  if (!source) return null;
  const { s, file } = source;
  return { file, state: [s.status, s.question, s.summary, file ? null : s.revision] };
} });
route('GET', '/api/session/:id/story/updates', (req, res, { id: sid }) => {
  if (!getSession(sid)) return json(res, 404, { error: 'no such session' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders?.();
  const done = storyUpdates.subscribe(sid, res);
  req.on('close', done);
  res.on('error', done);
});

route('GET', '/api/session/:id/story', async (req, res, { id: sid }, url) => {
  try {
    const full = url?.searchParams?.get('full') === '1';
    const rounds = Math.max(1, Math.min(20, Number(url?.searchParams?.get('rounds')) || DEFAULT_ROUNDS));
    const cursor = url?.searchParams?.get('cursor') || null;
    const r = await storyFor(sid, { rounds, full, cursor });
    if (r.error) return json(res, 404, { error: r.error });
    // Live session status (NOT baked into storyFor's cached meta — status changes far more often than
    // the transcript) so the story view can show a calming "working" animation while the agent runs.
    const s = getSession(sid);
    if (!cursor && s?.tool === 'codex') {
      await refreshCodexQuestions(s, { file: r.meta?.source === 'transcript' ? r.meta.file : null });
      r.events = overlayCodexQuestions(getSession(sid), r.events);
    }
    // Live CLI status line (only while working; one cheap capture-pane, off the cache since it changes
    // every second). Fail-open — a missing status just falls back to the generic working animation.
    let liveStatus = null;
    if (!cursor && s?.status === 'working') {
      try { liveStatus = extractLiveStatus(await snapshot(sid, 16)); } catch {}
    }
    // Native transcript parsers expose structured AskUserQuestion calls, but ordinary terminal gates
    // (including Claude's initial workspace-trust screen) never enter that transcript. Project the
    // durable waiting question into Story whenever no unanswered transcript ask already represents it.
    // This field is deliberately outside the cached story: it vanishes as soon as the reply resumes.
    let pendingQuestion = null;
    const hasTranscriptAsk = r.events.some((event) => event.kind === 'ask' && !event.answered);
    if (!cursor && s?.status === 'waiting' && !hasTranscriptAsk) {
      let terminal = null;
      try { terminal = terminalQuestionPrompt(await snapshot(sid, 32)); } catch {}
      // Waiting also means a completed report, an interruption or an idle composer. s.question
      // is a heuristic terminal summary, NOT evidence of an actionable question. Only a live
      // prompt (or the structured transcript asks above) may get answer controls in Story.
      if (terminal?.question) pendingQuestion = {
        ts: s.last_activity || Date.now(),
        body: terminal.question,
        options: terminal?.options?.map((option) => ({ label: option.label })) || [],
      };
    }
    json(res, 200, { ok: true, ...r, status: s?.status || null, liveStatus, pendingQuestion });
  } catch (e) {
    json(res, e.code === 'STORY_CURSOR_INVALID' ? 409 : 500, { error: String(e.message || e).slice(0, 300), code: e.code });
  }
});
