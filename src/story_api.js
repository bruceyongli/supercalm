// Story view API (design handoff, phase 1): GET /api/session/:id/story returns the session's log
// re-parsed as plain-language story events (src/story.js — the handoff's verified drop-in parser).
// Locates the session's exact NATIVE transcript (not the tmux pipe log or a same-project guess).
// Cached by file mtime — a 200MB rollout is
// only re-parsed when it actually grew. Parsing/large-file reads run in a bounded worker pool.
import { stat } from 'node:fs/promises';
import { route, json, send } from './server.js';
import { getSession, getProject, db, messagesFor, otherClaudeTranscripts } from './store.js';
import { findClaudeLog } from './claude_transcripts.js';
import { readStoryPage, readStoryImage } from './story_reader.js';
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
import { providerIssue } from './provider_status.js';
import { getLatestAttentionReport } from './attention_store.js';
import { createBoundedCache } from './bounded_cache.js';

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

const cache = createBoundedCache(); // local RAM only; at most 16 MiB of parsed report payloads
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
// An exact native UUID wins regardless of cwd. Missing bindings can be recovered only with launch
// evidence (request, launch time, cwd and exclusive ownership), never a newest/largest-file guess.
async function findCodexLog(s) {
  // Legacy unbound rows lack the queued-launch contract. Do not repeatedly crawl native storage
  // for them, and never fill that evidence gap with a same-cwd conversation.
  if (!s?.codex_uuid && (!s?.id || !_freshQueuedLaunch.get(s.id))) return null;
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
  if (s?.id) {
    let recovered = await bindCodexLaunchTranscript(s.id, { files });
    // A file can appear just after the previous Story request. Refresh the shared inventory at
    // most once per second for unresolved launches, rather than hiding it behind a 30s cache miss.
    if (!recovered && Date.now() - inventoryAt >= 1000) {
      recovered = await bindCodexLaunchTranscript(s.id, { files: await rolloutFiles(true) });
    }
    return recovered;
  }
  return null;
}

const nativeIdentity = s => `${s?.tool}|${s?.codex_uuid || ''}|${s?.claude_transcript || ''}`;

async function storySource(sid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = getSession(sid);
    if (!s) return null;
    const project = s.project_id ? getProject(s.project_id) : null;
    const cwd = s.worktree_path || project?.path || null;
    const file = s.tool === 'codex'
      ? await findCodexLog(s)
      : await findClaudeLog(cwd, s, { claimed: otherClaudeTranscripts(sid), allowHeuristic: false });
    // Binding/recovery can finish during a filesystem read. Resolve again with the new identity.
    if (nativeIdentity(s) === nativeIdentity(getSession(sid))) return { s, file };
  }
  const s = getSession(sid);
  return s ? { s, file: null } : null;
}

function ownStory(sid) {
  const events = fallbackStory(sid);
  return { sessionId: sid, events, meta: { file: null, source: 'fallback', count: events.length,
    note: events.length ? 'reconstructed from AIOS’s own message log (native CLI transcript not found)' : 'no messages recorded for this session yet' } };
}

export async function storyFor(sid, { rounds = DEFAULT_ROUNDS, full = false, cursor = null } = {}) {
  const source = await storySource(sid);
  if (!source) return { error: 'no such session' };
  const { file } = source;
  if (!file) return ownStory(sid);
  const st = await stat(file);
  const key = `${sid}|${full ? 'full' : 'r' + rounds}|${cursor || ''}`;
  const hit = cache.get(key);
  if (nativeIdentity(source.s) !== nativeIdentity(getSession(sid))) return ownStory(sid);
  if (hit && hit.file === file && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size && hit.ino === st.ino && hit.dev === st.dev) return { sessionId: sid, events: hit.events, meta: hit.meta };
  const flightKey = `${key}|${file}|${st.dev}|${st.ino}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);
  const flight = readStoryPage({ file, rounds, full, cursor }).then(result => {
    if (nativeIdentity(source.s) !== nativeIdentity(getSession(sid))) return ownStory(sid);
    const { events } = result;
    const meta = { ...result.meta, file, mtimeMs: st.mtimeMs, source: 'transcript' };
    cache.set(key, { file, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino, dev: st.dev, events, meta });
    return { sessionId: sid, events, meta };
  }).finally(() => { inFlight.delete(flightKey); });
  inFlight.set(flightKey, flight);
  return flight;
}

const storyUpdates = createStoryUpdates({ bus, resolve: async sid => {
  const source = await storySource(sid);
  if (!source) return null;
  const { s, file } = source;
  return { file, state: [s.status, s.question, s.summary, s.provider_issue, file ? null : s.revision] };
} });
route('GET', '/api/session/:id/story/image', async (req, res, { id: sid }, url) => {
  try {
    const source = await storySource(sid);
    if (!source?.file) return json(res, 404, { error: 'Story image is no longer available.' });
    const image = await readStoryImage({ file: source.file, ref: url.searchParams.get('ref') });
    send(res, 200, Buffer.from(image.data), { 'content-type': image.mime,
      'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
  } catch (error) {
    json(res, ['STORY_IMAGE_MISSING', 'ENOENT'].includes(error.code) ? 404 : 503,
      { error: 'Story image is unavailable. Reload the recent conversation.' });
  }
});
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
    // Terminal-only model failures may never appear in the native transcript. Always project fresh
    // durable state separately from paged/cached history. A report id binds Continue to THIS episode.
    const current = getSession(sid);
    const issue = !cursor && ['working', 'waiting'].includes(current?.status) ? providerIssue(current.provider_issue) : null;
    const liveIssue = issue ? { ...issue, reportId: getLatestAttentionReport(sid)?.id || null } : null;
    json(res, 200, { ok: true, ...r, status: current?.status || null, liveStatus,
      pendingQuestion: liveIssue ? null : pendingQuestion, providerIssue: liveIssue });
  } catch (e) {
    json(res, e.code === 'STORY_CURSOR_INVALID' ? 409 : 500, { error: String(e.message || e).slice(0, 300), code: e.code });
  }
});
