import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, open, writeFile, readdir, mkdir, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, basename, normalize, isAbsolute, sep, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { TMUX, TOOL_PATH, LOG_DIR, DATA_DIR, TOOLS, SELF_URL, DEFAULT_AUTONOMY, AUTONOMY_LEVELS } from './config.js';
import * as store from './store.js';
import { bus } from './bus.js';
import { id, slug, now, shquote, stripAnsi } from './util.js';
import { route, json, readJson } from './server.js';
import { markTyping } from './operator_presence.js';
import { CLAUDE_SURVEY_RX } from './detect_classify.js';
import { summarize } from './summarize.js';
import { resolveClaudeEnv } from './authmode.js';
import { assertAgyCliLoggedIn } from './auth/agy_cli.js';
import { ensureAgyStatuslineHook } from './agy_statusline.js';
import { cleanModelId, isNativeModel, modelDisplayLabel, modelSupportsFast, routeForModel, listProxyModels } from './model_catalog.js';
import { generateSessionMap, getSessionMap, sessionMapOptions } from './session_map.js';
import { getSessionSpace, ensureSessionSpace, sourceSliceFor, startSpaceBuilder, kickLabels } from './session_space.js';
import { labelStats, setLabeling, labelConfig, setLabelConfig } from './session_labels.js';
import { subscriptionStatus } from './usage_collect.js';
import { clearSessionLimit, getSessionLimit, markSessionLimitTriggered, setSessionLimit, usageForSession } from './usage_store.js';
import { buildAgentTimelinePayload } from './agui_session.js';
import { flagOn } from './flags.js';
import { claudeSettingsPath, codexNotifyArg } from './hookcfg.js';
import { getContext, setContext, generateContext, contextBlock } from './context_doc.js';
import { preflightSpec, composeTask, getPreflight } from './agents/preflight.js';
import { retrieveLessons, formatLessons, noteLessonReuse } from './lessons.js';
import { listWiki, readWiki, searchWiki, rebuildWiki } from './wiki.js';
import { rolloutUuidFromName, codexRolloutFiles } from './codex_rollouts.js';
import { wikiMcpToken } from './mcp.js';
import { helperEnabled, getHelpers, setHelpers } from './project_helpers.js';
import { chatJson } from './llm.js';
import { cleanSessionTitle, fallbackSessionTitle, titleContext } from './session_title.js';
import { gitOut } from './git.js';
import { isGitRepo, ensureWorktree } from './worktrees.js';

const exec = promisify(execFile);
// timeout/killSignal so a wedged tmux call can never stall the poll/tail loops.
const X = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 8000, killSignal: 'SIGKILL' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Agent TUIs (codex/claude/agy) absorb a trailing Enter sent immediately after the
// pasted text; a brief pause lets the composer register the text so Enter submits.
const SUBMIT_DELAY_MS = Number(process.env.AIOS_SUBMIT_DELAY || 320);
const AUTH_GRACE_MS = Number(process.env.AIOS_AUTH_GRACE || 120000); // post-relaunch window where replayed 401s are ignored
const POLL_MS = 1500;
const TAIL_MS = 250;
const TERMINAL_SNAPSHOT_LINES = Math.max(200, Math.min(20000, Number(process.env.AIOS_TERMINAL_SNAPSHOT_LINES || 6000)));
const TERMINAL_LOG_MAX_BYTES = Math.max(32 * 1024, Math.min(4 * 1024 * 1024, Number(process.env.AIOS_TERMINAL_LOG_MAX_BYTES || 512 * 1024)));
const LIMIT_CHECK_MS = Number(process.env.AIOS_USAGE_LIMIT_CHECK_MS || 15000);
const QUOTA_CACHE_MS = Number(process.env.AIOS_USAGE_QUOTA_CACHE_MS || 30000);
const ATTACHMENT_MAX_BYTES = Number(process.env.AIOS_ATTACHMENT_MAX_BYTES || 24 * 1024 * 1024);
const ASSET_PREVIEW_CHARS = Number(process.env.AIOS_ASSET_PREVIEW_CHARS || 360);
const ASSET_PREVIEW_READ_BYTES = Number(process.env.AIOS_ASSET_PREVIEW_READ_BYTES || 8192);
const TIMELINE_TERMINAL_LINES = 80;
const TIMELINE_TEXT_LIMIT = 12000;
const TIMELINE_DIFF_LIMIT = 360000;
const RESIZE_CLIENT_TTL_MS = Number(process.env.AIOS_RESIZE_CLIENT_TTL_MS || 15000);
const RESIZE_INTERACTIVE_MS = Number(process.env.AIOS_RESIZE_INTERACTIVE_MS || 30000);
const RESIZE_MAX_CLIENTS = Number(process.env.AIOS_RESIZE_MAX_CLIENTS || 24);
const SHELLS = new Set(['zsh', 'bash', 'sh', '-zsh', '-bash', 'fish', 'login']);
const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on']);

// in-memory registry of live sessions: id -> { id, tmux, logFile, offset, subscribers, lastHash, lastChange }
const reg = new Map();
const resizeClients = new Map();
// sid -> "COLSxROWS" last applied to the tmux window, so /resize skips redundant resize-window execs.
// Cleared in startPane() when a pane is (re)created, so a resumed/fresh pane always gets re-sized.
const resizeApplied = new Map();

const FORMAT_BY_MIME = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
  'image/svg+xml': 'SVG',
  'application/pdf': 'PDF',
  'application/json': 'JSON',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'text/markdown': 'MD',
  'audio/mpeg': 'MP3',
  'audio/ogg': 'OGG',
  'audio/opus': 'OPUS',
  'audio/wav': 'WAV',
  'video/mp4': 'MP4',
  'application/zip': 'ZIP',
};
const ATTACHMENT_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// Content types for the project-file viewer (GET /api/session/:id/file). Code/config files map to
// text/plain so the viewer's fetch().text() renders them and a direct open shows source (never executes).
const FILE_VIEW_CONTENT_TYPES = {
  ...ATTACHMENT_CONTENT_TYPES,
  '.svg': 'text/plain; charset=utf-8', // show SVG source, don't serve as executable image/svg+xml
};
const FILE_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.vue', '.svelte', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.sh', '.bash', '.zsh', '.fish', '.sql', '.csv', '.tsv', '.log', '.svg',
  '.gitignore', '.dockerignore', '.editorconfig', '.lock', '', // no-extension files (README, Makefile, Dockerfile)
]);
const FILE_IMAGE_RX = /^\.(png|jpe?g|gif|webp|avif|bmp|ico)$/;
const FILE_VIEW_MAX_BYTES = 2 * 1024 * 1024;
const FILE_LIST_MAX = 200;
const FILE_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'vendor', '.aios', 'coverage', '.venv', '__pycache__']);

// Root a session's files are confined to — its isolated worktree if it has one, else the project cwd
// (same resolution startPane() uses). Without the worktree_path fallback, an isolated session's file
// browser + diffs would show the WRONG tree (the shared main checkout, not what the agent is editing).
function projectFileRoot(s) {
  const project = s?.project_id ? store.getProject(s.project_id) : null;
  return normalize(s?.worktree_path || project?.path || process.env.HOME || '/');
}
// Resolve a caller-supplied (relative or absolute) path and confine it to root — returns null on escape.
function resolveInRoot(root, p) {
  const base = normalize(root);
  const target = normalize(isAbsolute(p) ? p : join(base, p));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

// A classifier (set by detect.js in Phase C) decides working/waiting + question.
let classifier = null;
export function setClassifier(fn) {
  classifier = fn;
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------
async function tmux(...args) {
  const { stdout } = await exec(TMUX, args, X);
  return stdout;
}
async function tmuxOk(...args) {
  try {
    await exec(TMUX, args, X);
    return true;
  } catch {
    return false;
  }
}

// Keep a persistent, hidden keepalive session so the tmux server stays up with
// DETACHED, IGNORED stdio. Critical: a tmux server with no sessions exits, so if we
// only `start-server`, the next `new-session` (run via execFile) would be the one to
// spawn the daemon — and that daemon inherits this process's stdout/stderr pipe and
// never closes it, so execFile never sees EOF and HANGS. Spawning the keepalive with
// stdio:'ignore' detaches the daemon from our pipes; later execFile calls just attach.
const KEEPALIVE = '_aios_keep';
function ensureServer() {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try {
      const p = spawn(TMUX, ['new-session', '-d', '-s', KEEPALIVE], { stdio: 'ignore', detached: true });
      p.on('error', fin); // already-running / duplicate session -> fine
      p.on('close', fin);
      p.unref();
    } catch {
      fin();
    }
    setTimeout(fin, 2000);
  });
}

export async function snapshot(sessionId, lines = 0) {
  const s = store.getSession(sessionId);
  if (!s) return '';
  const args = ['capture-pane', '-p', '-t', s.tmux];
  if (lines) args.push('-S', String(-lines));
  try {
    return await tmux(...args);
  } catch {
    return '';
  }
}

async function paneCmd(name) {
  try {
    return (await tmux('display-message', '-p', '-t', name, '#{pane_current_command}')).trim();
  } catch {
    return '';
  }
}

// Is the pane currently on the alternate screen? Full-screen TUIs (Claude Code) enter it once at
// startup and never leave, drawing their whole UI with absolute cursor positioning. tmux tracks this
// as #{alternate_on}; the browser xterm must be told to match, or those positioned redraws land on its
// main buffer at the wrong rows and the UI tears (see the /stream bootstrap).
async function paneAltOn(sessionId) {
  const s = store.getSession(sessionId);
  if (!s) return false;
  try {
    return (await tmux('display-message', '-p', '-t', s.tmux, '#{alternate_on}')).trim() === '1';
  } catch {
    return false;
  }
}

function boolParam(v) {
  return v === true || v === 1 || BOOL_TRUE.has(String(v).trim().toLowerCase());
}

function resizeClientId(req, v) {
  const cleaned = String(v || '').trim().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 96);
  return cleaned || `legacy:${req.socket.remoteAddress || 'unknown'}`;
}

function resizeClientPool(sid) {
  let clients = resizeClients.get(sid);
  if (!clients) {
    clients = new Map();
    resizeClients.set(sid, clients);
  }
  return clients;
}

function resizeCandidate(sid, t = now()) {
  const clients = resizeClients.get(sid);
  if (!clients) return null;
  for (const [clientId, c] of clients) {
    if (t - c.ts > RESIZE_CLIENT_TTL_MS && t > c.interactiveUntil) clients.delete(clientId);
  }
  const active = [...clients.values()].filter((c) => c.visible && !c.headless && t - c.ts <= RESIZE_CLIENT_TTL_MS);
  if (!active.length) return null;
  // The tmux window is ONE size shared by every viewer, so it must fit the NARROWEST active client.
  // Previously we picked the widest, which meant a wide desktop viewer (e.g. 354 cols) forced the pane
  // wide and every narrower viewer — a laptop/phone, or the same operator after switching devices while
  // the wide client's entry lingered (TTL) — received 354-col lines that xterm then wrapped ~3x into a
  // garbled sliver (Claude Code draws a full-width composer/rule at the pane width). Taking the min on
  // both axes mirrors tmux's own `window-size smallest`: no viewer is ever sent content wider/taller than
  // its own grid, so the agent TUI renders cleanly everywhere. Owner (freshest, interactive-first) is
  // reported for telemetry only; it no longer dictates the size.
  const cols = Math.min(...active.map((c) => c.cols));
  const rows = Math.min(...active.map((c) => c.rows));
  const owner = active.slice().sort((a, b) => (Number(b.interactiveUntil > t) - Number(a.interactiveUntil > t)) || b.ts - a.ts)[0];
  return { clientId: owner.clientId, cols, rows };
}

// Send literal text then Enter (the main "reply" path).
// Detect a Claude AskUserQuestion menu and return the digit of its "Type something"
// custom-answer option — so a free-text reply becomes a real answer instead of being
// typed onto the highlighted preset (which silently loses the user's words).
function askMenuTypeDigit(screen) {
  const t = stripAnsi(screen || '');
  if (!/Enter to select|to navigate/.test(t)) return null; // not an interactive selection menu
  const m = t.match(/(\d+)\.\s*Type something/i);
  return m ? m[1] : null;
}

export async function sendText(name, text) {
  // If a multiple-choice menu is showing, first select "Type something" so the reply
  // is captured as a custom answer (pressing the digit opens its text field).
  let screen = '';
  try {
    screen = await tmux('capture-pane', '-p', '-t', name);
  } catch {}
  // Claude's session-feedback survey ("How is Claude doing…? 1: Bad … 0: Dismiss") swallows
  // keystrokes ahead of the composer — replies typed under it sat unsubmitted for hours. If it's
  // showing in the live tail (bottom lines ONLY — survey wording quoted higher up in a transcript
  // must not trigger; an ambient detect-gate version of this typed 258 stray '0's into the session
  // that quoted it), dismiss it, then re-capture for the menu check below. A false match here
  // self-heals: the C-u below clears the input line before the real text is typed.
  if (CLAUDE_SURVEY_RX.test(stripAnsi(screen || '').split('\n').slice(-12).join('\n'))) {
    await exec(TMUX, ['send-keys', '-t', name, '0'], X);
    await sleep(250);
    try {
      screen = await tmux('capture-pane', '-p', '-t', name);
    } catch {}
  }
  const digit = askMenuTypeDigit(screen);
  if (digit) {
    await exec(TMUX, ['send-keys', '-t', name, digit], X);
    await sleep(300);
  } else {
    // Clear anything already sitting in the agent's input line (e.g. text left over from interactive
    // terminal typing) so this composed message isn't appended to it — that concatenation turned a
    // stray "/m" into a bogus "/m<msg>" slash command. Ctrl-U kills the line; it's a harmless no-op on
    // an empty input. (Skipped in the menu branch, where we just opened a fresh empty "Type something".)
    await exec(TMUX, ['send-keys', '-t', name, 'C-u'], X);
    await sleep(30);
  }
  await exec(TMUX, ['send-keys', '-t', name, '-l', '--', text], X);
  await sleep(SUBMIT_DELAY_MS);
  await exec(TMUX, ['send-keys', '-t', name, 'Enter'], X);
}

// Send a single named control key. Accepts friendly aliases.
const KEYMAP = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', tab: 'Tab',
  space: 'Space', backspace: 'BSpace', delete: 'DC', 'ctrl-c': 'C-c',
  'ctrl-d': 'C-d', 'ctrl-r': 'C-r', 'ctrl-z': 'C-z', 'ctrl-u': 'C-u',
};
export async function sendKey(name, key) {
  const k = KEYMAP[String(key).toLowerCase()] || key;
  await exec(TMUX, ['send-keys', '-t', name, k], X);
}

// Send raw bytes from the interactive terminal straight to the pane PTY. xterm's onData already
// produces exactly what a real terminal would send (printables, '\r' for Enter, 'ESC[A' for arrows,
// etc.), so send-keys -l replays it verbatim — no key remapping. No SUBMIT_DELAY here: this is live
// per-keystroke input to a raw-mode TUI (CLAUDE.md gotcha #8), not the programmatic paste+Enter that
// the delay in sendText() guards against.
export async function sendRaw(name, data) {
  await exec(TMUX, ['send-keys', '-t', name, '-l', '--', data], X);
}

// ---------------------------------------------------------------------------
// launch / discover / lifecycle
// ---------------------------------------------------------------------------
function register(s) {
  if (reg.has(s.id)) return reg.get(s.id);
  const entry = {
    id: s.id,
    tmux: s.tmux,
    logFile: join(LOG_DIR, s.id + '.log'),
    offset: 0,
    subscribers: new Set(),
    lastHash: null,
    lastChange: now(),
  };
  try {
    entry.offset = existsSync(entry.logFile) ? statSync(entry.logFile).size : 0;
  } catch {
    entry.offset = 0;
  }
  reg.set(s.id, entry);
  return entry;
}

// Read the first line of a file (bounded) without loading the whole thing.
async function readHead(path, max = 16384) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

// Capture the codex conversation UUID for a FRESH launch by DIFFING the rollout set: the one new file that
// appears after codex starts is this session's rollout, so we record its UUID (store.codex_uuid). This lets
// the story + resume find the real transcript by UUID even when the rollout's cwd differs from the AIOS
// project path (a sandboxed workspace) — the failure the operator hit. Fully fail-open + async: it never
// blocks or breaks the launch, and if it can't tell unambiguously (0 or >1 new files, e.g. concurrent codex
// launches) it leaves codex_uuid null and cwd-matching stays the fallback.
async function captureCodexUuid(sid, beforeSet) {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      const fresh = (await codexRolloutFiles()).filter((f) => !beforeSet.has(f));
      if (fresh.length === 1) {
        const uuid = rolloutUuidFromName(fresh[0]);
        if (uuid) { store.updateSession(sid, { codex_uuid: uuid }); store.addEvent(sid, 'codex-uuid', { uuid }); return; }
      }
      if (fresh.length > 1) return; // ambiguous — don't guess; cwd-fallback stays
    }
  } catch {}
}

// Find the codex rollout whose session_meta cwd matches the project dir, and return its conversation UUID
// — so `codex resume` continues THIS project's conversation, not just the globally most-recent one.
async function findCodexSession(cwd) {
  if (!cwd) return null;
  const files = await codexRolloutFiles();
  files.sort().reverse(); // filename begins with an ISO timestamp -> lexical sort == chronological
  for (const f of files.slice(0, 80)) {
    const head = await readHead(f).catch(() => '');
    const cm = head.match(/"cwd":\s*"([^"]+)"/);
    if (cm && cm[1] === cwd) {
      const im = head.match(/"id":\s*"([0-9a-fA-F-]{36})"/);
      if (im) return im[1];
    }
  }
  return null;
}

// Create a fresh tmux pane and start (or resume) the tool in it. Returns the tmux name.
async function startPane({ sid, project, tool, task, effort, autonomy, model, fastMode, resume, resumeId, orchestration, viaProxy, cwd }) {
  // `cwd`, when set, is the session's isolated git worktree — it wins over project.path so concurrent
  // sessions on one repo never share a working tree. project.path is NEVER mutated.
  const dir = cwd || project?.path || process.env.HOME;
  if (!existsSync(dir)) throw new Error('path does not exist on host: ' + dir);
  const isolated = !!cwd && cwd !== project?.path;
  const name = `aios-${slug(project?.name || 'adhoc')}-${tool}-${id().slice(0, 4)}`;
  const logFile = join(LOG_DIR, sid + '.log');
  if (!resume) await writeFile(logFile, ''); // resume keeps appending to the same record
  resizeApplied.delete(sid); // fresh/resumed pane: forget the old window size so the next /resize re-applies

  await tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', dir);
  await tmux('set-option', '-t', name, 'history-limit', '200000').catch(() => {});
  await tmux('pipe-pane', '-t', name, `cat >> "${logFile}"`);

  const argvOpts = { effort, autonomy, model, fastMode, resume, resumeId, orchestration, viaProxy };
  // Launch-path features — ALL flag-gated (default OFF) + precondition-checked. When a flag is off or a
  // precondition fails, the corresponding opt stays undefined and the launch line is byte-identical to
  // before. This is the "default-inert" boundary that keeps the live fleet safe.
  try {
    if (tool === 'claude' && flagOn('claudeHooks')) {
      const sp = claudeSettingsPath({ guardrails: flagOn('gitGuardrails') });
      if (sp) argvOpts.settingsPath = sp;
    }
    if (tool === 'codex' && flagOn('codexNotify')) {
      const na = codexNotifyArg();
      if (na) argvOpts.notifyArg = na;
    }
    if (helperEnabled(project?.id, 'contextInject')) {
      const block = contextBlock(project.id);
      if (block) argvOpts.appendPrompt = block;
    }
    if (helperEnabled(project?.id, 'wiki')) {
      // Wire the read-only wiki MCP server (streamable HTTP) into this launch, scoped by a per-project token.
      const url = `${SELF_URL}/mcp/${wikiMcpToken(project.id)}`;
      if (tool === 'claude') {
        const mcpFile = join(DATA_DIR, 'launch', sid + '.mcp.json');
        await mkdir(join(DATA_DIR, 'launch'), { recursive: true });
        await writeFile(mcpFile, JSON.stringify({ mcpServers: { aios_wiki: { type: 'http', url } } }) + '\n', { mode: 0o600 });
        argvOpts.mcpConfigPath = mcpFile;
      } else if (tool === 'codex') {
        argvOpts.mcpUrl = url;
      }
    }
  } catch (e) {
    console.error('[aios] launch-feature wiring skipped:', e?.message || e);
  }
  const argv = TOOLS[tool].argv(task, argvOpts);
  const cmd = argv.map(shquote).join(' ');
  // per-tool env. For claude this is resolved per-launch (auto-detect): external proxy if
  // reachable, else Supercalm's own dashboard login via the local shim, else the CLI's own
  // ~/.claude login — so it works on machines with or without the proxy fleet, no config.
  const baseEnv = tool === 'claude' ? (await resolveClaudeEnv({ model })).env : TOOLS[tool].env || {};
  const envMap = typeof baseEnv === 'function' ? baseEnv({ model, effort, autonomy, fastMode, resume, viaProxy }) : baseEnv;
  const toolEnv = Object.entries(envMap).map(([k, v]) => `${k}=${shquote(String(v))}`).join(' ');
  // Isolated (worktree) sessions get AIOS_NO_DEPLOY=1 so `bin/deploy` refuses (it must run only from the
  // canonical main checkout). A speed-bump, not a sandbox: the agent could `cd ~/aios && unset` it — real
  // enforcement needs separate unix users/containers (out of scope). Integration is an operator-gated action.
  const noDeploy = isolated ? 'AIOS_NO_DEPLOY=1 ' : '';
  const line = `export PATH="${TOOL_PATH}:$PATH"; ${toolEnv ? toolEnv + ' ' : ''}${noDeploy}AIOS_SESSION_ID=${sid} AIOS_URL=${SELF_URL} ${cmd}`;
  // NEVER type the full launch line into the pane: a long task pushes it past the kernel's
  // canonical-mode line limit (MAX_CANON = 1024 on macOS) — the freshly-spawned shell hasn't
  // entered raw mode yet, so everything beyond 1KB is silently dropped and the truncated,
  // unterminated command wedges the shell. Write it to a script and source it (short line).
  const launchDir = join(DATA_DIR, 'launch');
  await mkdir(launchDir, { recursive: true });
  const launchFile = join(launchDir, sid + '.sh');
  await writeFile(launchFile, line + '\n', { mode: 0o700 });
  await exec(TMUX, ['send-keys', '-t', name, '-l', '--', `. ${shquote(launchFile)}`], X);
  await exec(TMUX, ['send-keys', '-t', name, 'Enter'], X);
  return name;
}

export async function launch({ project, tool, task, effort = null, autonomy = null, model = null, fastMode = false, orchestration = null }) {
  if (!TOOLS[tool]) throw new Error('unknown tool: ' + tool);
  const activeFastMode = tool === 'codex' && modelSupportsFast(model || TOOLS[tool].model) && !!fastMode;
  if (tool === 'agy') {
    await assertAgyCliLoggedIn();
    await ensureAgyStatuslineHook().catch((e) => console.error('[aios] agy statusline hook install failed:', e.message));
  }
  const sid = id('s');
  // Pre-flight spec-sharpen (#3, flag preflightGrill, default OFF): interrogate the task against the repo
  // and prepend an ADVISORY sharpened brief to the agent's first prompt (original task preserved + kept
  // authoritative). Fully fail-open + hard-bounded; resume() never reaches here. Title/message keep the
  // original task.
  let launchTask = task;
  if (helperEnabled(project?.id, 'preflight') && task && task.trim()) {
    try {
      const pf = await preflightSpec({ sid, project, task });
      if (pf.status === 'success' && pf.spec) {
        const composed = composeTask(pf.spec, pf.questions, task);
        if (composed.length <= 16000) launchTask = composed; // argv-size guard; else fall back to original
      }
    } catch (e) {
      console.error('[aios] preflight skipped (fail-open):', e?.message || e);
    }
  }
  // Inject distilled lessons from PAST sessions in this repo (advisory; gated on the lessons helper).
  // Reuses EmbodiSkill-classified, success-gated skill-fix lessons only; prepended so the agent sees them
  // ahead of the (possibly preflight-composed) task. Fail-open + argv-size guarded.
  if (helperEnabled(project?.id, 'lessons') && task && task.trim()) {
    try {
      const ls = retrieveLessons({ projectId: project.id, queryText: task, k: 3 });
      const block = formatLessons(ls);
      if (block && block.length + launchTask.length + 48 <= 16000) {
        launchTask = `<relevant_lessons>\n${block}\n</relevant_lessons>\n\n${launchTask}`;
        noteLessonReuse(project.id, ls.map((l) => l.id));
      }
    } catch (e) {
      console.error('[aios] lessons inject skipped (fail-open):', e?.message || e);
    }
  }
  // codex only: snapshot the rollout set right before launch so captureCodexUuid can diff for the NEW
  // rollout codex creates — recording its UUID (store.codex_uuid) makes the transcript/resume findable
  // even when the rollout's cwd differs from the project path (the operator's cwd-mismatch failure).
  const codexBefore = tool === 'codex' ? new Set(await codexRolloutFiles().catch(() => [])) : null;
  // Per-session worktree isolation (opt-in per project, #isolation helper). Concurrent sessions on one
  // repo get their own worktree+branch so they never clobber each other. FAIL-OPEN: any error → the
  // shared tree, and the launch line is byte-identical to before (the default-inert boundary).
  let wt = null;
  if (helperEnabled(project?.id, 'isolation') && project?.path) {
    try {
      if (await isGitRepo(project.path)) wt = await ensureWorktree({ repoPath: project.path, sid, project });
    } catch (e) { console.error('[aios] worktree isolation skipped (fail-open):', e?.message || e); wt = null; }
  }
  const name = await startPane({ sid, project, tool, task: launchTask, effort, autonomy, model, fastMode: activeFastMode, orchestration, resume: false, cwd: wt?.path });
  const s = store.createSession({
    id: sid,
    project_id: project?.id || null,
    tool,
    tmux: name,
    title: task ? task.slice(0, 100) : '(interactive)',
    status: 'working',
    autonomy,
    effort,
    model,
    fast_mode: activeFastMode ? 1 : 0,
    orchestration,
  });
  if (wt) store.updateSession(sid, { worktree_path: wt.path, branch: wt.branch }); // source of truth for confinement + resume
  store.addEvent(sid, 'launch', { tool, dir: wt?.path || project?.path, task: task || null, autonomy, effort, model, fastMode: activeFastMode, orchestration, worktree: wt?.path || null, branch: wt?.branch || null });
  if (task) store.addMessage(sid, 'in', 'task', task);
  register(s);
  if (codexBefore) captureCodexUuid(sid, codexBefore); // fire-and-forget; async + fail-open, never blocks launch
  emitSessionStatus(s, { previousStatus: null, source: 'launch' });
  bus.emit('changed');
  bus.emit('event', { type: 'launch', session: sid, tool, project: project?.name });
  return s;
}

// Relaunch a stopped session, continuing the tool's conversation in the same project.
export async function resume(sid, { force = false } = {}) {
  const s = store.getSession(sid);
  if (!s) throw new Error('no such session');
  if (!TOOLS[s.tool]) throw new Error('unknown tool: ' + s.tool);
  if (s.tool === 'agy') {
    await assertAgyCliLoggedIn();
    await ensureAgyStatuslineHook().catch((e) => console.error('[aios] agy statusline hook install failed:', e.message));
  }
  const alive = await tmuxOk('has-session', '-t', s.tmux);
  // A tmux pane lingers at a shell prompt after the agent (claude/codex/agy) exits, so `has-session`
  // alone means "pane exists", NOT "agent running". Only short-circuit when the agent is genuinely live
  // (status not exited); an exited session must relaunch even though its pane lingers.
  if (alive && s.status !== 'exited' && !force) return s; // genuinely running -> don't double-launch
  if (alive) await tmuxOk('kill-session', '-t', s.tmux); // kill the lingering/old pane, then relaunch fresh
  const project = s.project_id ? store.getProject(s.project_id) : null;
  // Isolated session: reuse its worktree (re-`git worktree add` if the registration was pruned). Its
  // cwd wins over project.path for the pane AND the codex rollout lookup. Fail-open to the shared tree.
  let cwd = undefined;
  if (s.worktree_path && project?.path) {
    try {
      const wt = await ensureWorktree({ repoPath: project.path, sid, project, desiredPath: s.worktree_path, desiredBranch: s.branch });
      cwd = wt?.path;
    } catch (e) { console.error('[aios] worktree resume reuse failed (fail-open):', e?.message || e); }
  }
  // codex resume is global-most-recent by default; pin it to THIS project's conversation — prefer the
  // UUID captured at launch (cwd-independent), then fall back to the cwd-match lookup (worktree-aware).
  const resumeId = s.tool === 'codex' ? (s.codex_uuid || (await findCodexSession(cwd || project?.path || process.env.HOME).catch(() => null))) : null;
  if (s.tool === 'codex' && resumeId && !s.codex_uuid) store.updateSession(sid, { codex_uuid: resumeId }); // backfill so the story/next resume match by UUID
  const name = await startPane({
    sid,
    project,
    tool: s.tool,
    task: null,
    effort: s.effort,
    autonomy: s.autonomy,
    model: s.model,
    fastMode: s.tool === 'codex' && modelSupportsFast(s.model || TOOLS[s.tool]?.model) && !!s.fast_mode,
    orchestration: s.orchestration,
    viaProxy: !!s.codex_via_proxy,
    resume: true,
    resumeId,
    cwd,
  });
  store.addEvent(sid, 'resume', { tmux: name, resumeId });
  const updated = store.updateSession(sid, { status: 'working', tmux: name, ended_at: null, exit_code: null, question: null, last_activity: now() });
  reg.delete(sid);
  register(updated);
  // grace window: a freshly relaunched pane reprints the old conversation (which may include 401s
  // from before the relaunch) before the first new exchange — don't let detect.js re-flag it as
  // authNeeded during that reprint. Cleared naturally once a healthy ⏺/⎿ line appears (see detect.js).
  const re = reg.get(sid);
  if (re) re.authGraceUntil = now() + AUTH_GRACE_MS;
  emitSessionStatus(updated, { previousStatus: s.status, source: 'resume' });
  bus.emit('changed');
  bus.emit('event', { type: 'resume', session: sid });
  return updated;
}

function markExited(entry, code) {
  const s = store.getSession(entry.id);
  if (s && s.status !== 'exited') {
    const updated = store.updateSession(entry.id, { status: 'exited', question: null, ended_at: now(), exit_code: code, last_activity: now() });
    store.addEvent(entry.id, 'exit', { code });
    emitSessionStatus(updated, { previousStatus: s.status, source: 'exit' });
    bus.emit('changed');
    bus.emit('event', { type: 'exit', session: entry.id });
  }
  for (const res of entry.subscribers) {
    try {
      res.write('event: ended\ndata: {}\n\n');
    } catch {}
  }
  reg.delete(entry.id);
}

// Reconcile DB <-> tmux on startup: resume live sessions, retire dead ones.
export async function discover() {
  let names = [];
  try {
    names = (await tmux('list-sessions', '-F', '#{session_name}')).split('\n').filter(Boolean);
  } catch {
    names = []; // no tmux server yet
  }
  const alive = new Set(names);
  for (const s of store.listLiveSessions()) {
    if (alive.has(s.tmux)) {
      register(s);
    } else {
      store.updateSession(s.id, { status: 'exited', ended_at: now() });
      store.addEvent(s.id, 'exit', { code: null, reason: 'tmux gone on restart' });
    }
  }
  console.log(`[aios] discovered ${reg.size} live session(s)`);
}

// ---------------------------------------------------------------------------
// status poll loop
// ---------------------------------------------------------------------------
function hash(s) {
  return createHash('sha1').update(s).digest('hex');
}
// For idle/change detection: drop the volatile composer prompt line, rotating
// placeholder hint, and tool footer so they don't masquerade as activity (which
// otherwise keeps idle codex/claude sessions stuck in 'working').
function stableSnap(s) {
  return stripAnsi(s || '')
    .split('\n')
    .map((l) => l.replace(/[│╭╮╰╯─━┃▌▐]/g, '').trim())
    .filter((l) => l && !/^[›❯]/.test(l) && !/·\s*~\//.test(l) && !/\?\s*for shortcuts|to cycle|to interrupt$/.test(l))
    .join('\n');
}

let quotaCache = { ts: 0, data: null };
async function quotaSnapshot() {
  const t = now();
  if (quotaCache.data && t - quotaCache.ts < QUOTA_CACHE_MS) return quotaCache.data;
  try {
    quotaCache = { ts: t, data: await subscriptionStatus() };
  } catch (e) {
    quotaCache = {
      ts: t,
      data: { generatedAt: t, subscriptions: [], errors: [{ id: 'subscription-status', error: String(e.message || e) }] },
    };
  }
  return quotaCache.data;
}

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function publicWindow(w = {}) {
  const used = pct(w.usedPercent ?? (w.remainingPercent == null ? null : 100 - Number(w.remainingPercent)));
  const remaining = pct(w.remainingPercent ?? (used == null ? null : 100 - used));
  return {
    name: w.name || 'quota',
    usedPercent: used,
    remainingPercent: remaining,
    resetAt: w.resetAt || null,
  };
}

function quotaTargetForSession(s = {}) {
  const route = routeForModel(s.model || s.tool);
  return {
    id: route?.proxy || s.tool,
    model: route?.model || s.model || null,
    modelLabel: modelDisplayLabel(s.model) || route?.label || s.model || null,
  };
}

function quotaForSession(s, status) {
  const target = quotaTargetForSession(s);
  const sub = (status?.subscriptions || []).find((x) => x.id === target.id) || null;
  const windows = (sub?.windows || []).map(publicWindow);
  if (sub?.manualUsage?.percentLeft != null) {
    windows.push(publicWindow({
      name: 'credits',
      remainingPercent: sub.manualUsage.percentLeft,
      resetAt: sub.manualUsage.resetAt || null,
    }));
  }
  return {
    generatedAt: status?.generatedAt || now(),
    tool: s.tool,
    provider: target.id,
    model: target.model,
    modelLabel: target.modelLabel,
    ok: !!sub?.ok,
    label: sub?.label || target.id,
    plan: sub?.plan || null,
    account: sub?.account || null,
    windows,
    manualUsage: sub?.manualUsage || null,
    errors: (status?.errors || []).filter((e) => !target.id || e.id === target.id || e.id === 'subscription-status'),
  };
}

function weeklyUsedPercent(quota) {
  const windows = quota?.windows || [];
  const preferred =
    windows.find((w) => w.name === 'weekly') ||
    windows.find((w) => w.name === 'credits') ||
    windows.find((w) => w.name === '5h') ||
    windows[0];
  return preferred ? pct(preferred.usedPercent) : null;
}

async function sessionUsagePayload(s) {
  const status = await quotaSnapshot();
  return {
    ok: true,
    session: decorate(s),
    usage: usageForSession(s),
    quota: quotaForSession(s, status),
    limit: getSessionLimit(s.id),
  };
}

async function enforceUsageLimit(s, entry) {
  const t = now();
  if (t - (entry.lastLimitCheck || 0) < LIMIT_CHECK_MS) return;
  entry.lastLimitCheck = t;

  const limit = getSessionLimit(s.id);
  if (!limit.enabled || limit.triggered_at) return;

  const usage = usageForSession(s);
  const totals = usage?.totals || {};
  const reasons = [];
  const tokenTraffic = Number(totals.token_traffic_tokens || 0);
  const cost = Number(totals.estimated_cost_usd || 0);

  if (limit.token_limit_total && tokenTraffic >= Number(limit.token_limit_total)) {
    reasons.push(`token traffic ${tokenTraffic} >= ${limit.token_limit_total}`);
  }
  if (limit.cost_limit_usd && cost >= Number(limit.cost_limit_usd)) {
    reasons.push(`cost $${cost.toFixed(4)} >= $${Number(limit.cost_limit_usd).toFixed(4)}`);
  }
  if (limit.weekly_limit_percent) {
    const quota = quotaForSession(s, await quotaSnapshot());
    const used = weeklyUsedPercent(quota);
    if (used != null && used >= Number(limit.weekly_limit_percent)) {
      reasons.push(`${quota.provider || s.tool} quota ${used.toFixed(1)}% >= ${Number(limit.weekly_limit_percent).toFixed(1)}%`);
    }
  }
  if (!reasons.length) return;

  const reason = reasons.join('; ');
  markSessionLimitTriggered(s.id, reason);
  store.addEvent(s.id, 'usage-limit-stop', {
    reason,
    token_traffic_tokens: tokenTraffic,
    estimated_cost_usd: cost,
    limit,
  });
  await sendKey(entry.tmux, 'ctrl-c').catch(() => {});
  bus.emit('changed');
  bus.emit('event', { type: 'usage-limit-stop', session: s.id, reason });
}

// Codex's ChatGPT-account usage-limit banner. When a NATIVE-model codex session hits it, Supercalm falls back
// to running the model through the proxy fleet (a different ChatGPT account/quota) and relaunch-continues.
const CODEX_USAGE_LIMIT_RX = /you'?ve hit your usage limit|upgrade to (plus|pro) to continue using codex|usage limit[^\n]*try again/i;

async function pollOnce() {
  for (const entry of [...reg.values()]) {
    const s = store.getSession(entry.id);
    if (!s || s.status === 'exited') {
      reg.delete(entry.id);
      continue;
    }
    if (!(await tmuxOk('has-session', '-t', entry.tmux))) {
      markExited(entry, null);
      continue;
    }
    const cmd = await paneCmd(entry.tmux);
    if (SHELLS.has(cmd)) {
      markExited(entry, 0);
      continue;
    }
    await enforceUsageLimit(s, entry).catch((e) => console.error('[aios] usage limit check failed:', e.message));
    const snap = await snapshot(entry.id);
    // Codex usage-limit auto-fallback: a NATIVE-model codex session that's hit the operator's personal
    // ChatGPT Codex cap is dead in the water — reroute it through the proxy fleet (different quota) and
    // relaunch-continue, ONCE (codex_via_proxy=1 then prevents re-fire; the entry guard covers the relaunch window).
    if (s.tool === 'codex' && !s.codex_via_proxy && !entry.viaProxyFallback &&
        isNativeModel('codex', s.model || TOOLS.codex.model) && CODEX_USAGE_LIMIT_RX.test(snap)) {
      entry.viaProxyFallback = true;
      store.updateSession(s.id, { codex_via_proxy: 1 });
      store.addEvent(s.id, 'codex-via-proxy-fallback', { reason: 'chatgpt-usage-limit' });
      console.log(`[aios] codex ${s.id}: ChatGPT usage limit -> falling back to the proxy fleet (codex_via_proxy)`);
      resume(s.id, { force: true }).catch((e) => console.error('[aios] codex via-proxy fallback relaunch failed:', e.message));
      continue;
    }
    const h = hash(stableSnap(snap));
    const changed = h !== entry.lastHash;
    if (changed) {
      entry.lastHash = h;
      entry.lastChange = now();
    }
    const idleMs = now() - entry.lastChange;

    let status = 'working';
    let question = null;
    if (classifier) {
      const r = classifier({ session: s, tool: s.tool, paneCmd: cmd, snap, idleMs, changed, authGraceUntil: entry.authGraceUntil });
      if (r) {
        // a login just completed in this pane -> auto-refresh this provider's stuck sessions
        if (r.loginOk) recoverAuth(s.tool, 'login-detected');
        // session is blocked on an expired login/token -> surface it clearly + mark for recovery
        if (r.authNeeded) {
          entry.authNeeded = true;
          entry.waitStreak = 2;
          applyAuthNeeded(s);
          continue;
        }
        entry.authNeeded = false; // no auth error this poll
        status = r.status || status;
        question = r.question ?? null;
        // autonomous session asked us to auto-accept a one-time gate (trust / bypass warning)
        if (r.confirm && now() - (entry.lastConfirm || 0) > 6000) {
          entry.lastConfirm = now();
          store.addEvent(s.id, 'auto-confirm', { autonomy: s.autonomy });
          (async () => {
            for (const k of r.confirm) {
              await sendKey(entry.tmux, k).catch(() => {});
              await sleep(280);
            }
          })();
        }
      }
    }
    // debounce waiting to avoid flicker on animated TUIs: require 2 consecutive polls
    if (status === 'waiting') {
      entry.waitStreak = (entry.waitStreak || 0) + 1;
      if (entry.waitStreak < 2 && s.status !== 'waiting') {
        status = 'working';
        question = null;
      }
    } else {
      entry.waitStreak = 0;
    }
    applyStatus(s, status, question, changed);
  }
}
function applyStatus(s, status, question, activityBump) {
  const patch = {};
  if (status && status !== s.status) patch.status = status;
  if ((question ?? null) !== (s.question ?? null)) patch.question = question ?? null;
  if (activityBump) patch.last_activity = now();
  const wasWaiting = s.status === 'waiting';
  const nowWaiting = status === 'waiting';
  if (wasWaiting && !nowWaiting) {
    patch.summary = null; // leaving waiting -> drop the stale summary/category
    patch.category = null;
  }
  if (!Object.keys(patch).length) return;
  const updated = store.updateSession(s.id, patch);
  if (patch.status) {
    store.addEvent(s.id, 'status', { from: s.status, to: patch.status });
    emitSessionStatus(updated, { previousStatus: s.status, source: 'poll' });
  }
  if (nowWaiting && !wasWaiting) {
    if (question) store.addMessage(s.id, 'out', 'detect', question);
    runSummary(s.id); // async: LLM summary+category, then fires 'waiting' (push)
  }
  bus.emit('changed');
}

// A reply was just sent to this session (text OR voice): move it OUT of the needs-you
// queue immediately rather than waiting for the poll loop to notice the screen change.
// Sets working, clears the stale question/summary, and resets the idle timer + wait
// streak so the poll loop doesn't instantly re-flag it as waiting. Shared by the
// /input route and the voice concierge so both paths behave identically.
export function noteReply(sid) {
  const before = store.getSession(sid);
  const updated = store.updateSession(sid, { status: 'working', question: null, summary: null, category: null, stage: null, last_activity: now() });
  const entry = reg.get(sid);
  if (entry) {
    entry.lastChange = now();
    entry.waitStreak = 0;
  }
  if (before && before.status !== updated.status) {
    emitSessionStatus(updated, { previousStatus: before.status, source: 'reply' });
  }
  bus.emit('changed');
}

// Summarize a freshly-waiting session via the proxy LLM, then notify (once per episode).
async function runSummary(sid) {
  let snap = '';
  try {
    snap = await snapshot(sid);
  } catch {}
  let result = null;
  try {
    result = await summarize(snap);
  } catch (e) {
    console.error('[aios] summarize failed:', e.message);
  }
  const cur = store.getSession(sid);
  if (!cur || cur.status !== 'waiting') return; // moved on while summarizing
  const summary = (result?.summary || cur.question || cur.title || 'Waiting for your input').replace(/\s+/g, ' ').slice(0, 220);
  const category = result?.category || 'review';
  const stage = result?.stage || null; // semantic lifecycle stage for the Supervisor's stand-down gate
  store.updateSession(sid, { summary, category, stage });
  // Record the decision event: the model-distilled CORE ask (the agent's reasoning + background +
  // the actual question — NO terminal trash) plus the summary/category. Your reply is linked later
  // (answerPendingDecision). For quick history + future decision-model training.
  try {
    if (category !== 'working') { // a real ask (decision/action/review), not a working false-positive
      const ask = String(result?.ask || summary || cur.question || '').trim().slice(0, 2000);
      const project = cur.project_id ? store.getProject(cur.project_id) : null;
      store.createDecision({ session_id: sid, project_id: cur.project_id, project: project?.name || null, tool: cur.tool, model: cur.model, asked_at: now(), category, summary, question: cur.question || null, ask });
    }
  } catch (e) {
    console.error('[aios] record decision failed:', e.message);
  }
  bus.emit('waiting', { session: sid, summary, category });
  bus.emit('changed');
}

// ---------------------------------------------------------------------------
// auth recovery: when a session's login/token expires it 401s ("Please run /login").
// A relaunch (--continue) reloads the refreshed credentials. When a login is detected
// (in any session of the same tool) OR the user hits Re-auth, relaunch every stuck
// session of that tool so the whole provider recovers in one go.
// ---------------------------------------------------------------------------
const DEFAULT_REAUTH_SUMMARY =
  "🔑 Re-login required — the agent's auth/token expired. Log in once (this or any session, or a terminal) and Supercalm auto-recovers it; or tap Re-auth.";
const TOOL_REAUTH_SUMMARY = {
  agy:
    'Antigravity CLI login required. Run `agy` in a terminal, choose Google OAuth, finish the browser/code flow, then tap Re-auth or start a new session.',
};
function reauthSummary(s) {
  return TOOL_REAUTH_SUMMARY[s.tool] || DEFAULT_REAUTH_SUMMARY;
}
function reauthQuestion(s) {
  return s.tool === 'agy' ? 'Antigravity CLI login required' : 'Re-login required (auth/token expired)';
}
function applyAuthNeeded(s) {
  const summary = reauthSummary(s);
  const question = reauthQuestion(s);
  const patch = {};
  if (s.status !== 'waiting') patch.status = 'waiting';
  if (s.summary !== summary) patch.summary = summary;
  if (s.category !== 'action') patch.category = 'action';
  if ((s.question ?? null) !== question) patch.question = question;
  if (!Object.keys(patch).length) return;
  const firstWait = patch.status === 'waiting';
  const updated = store.updateSession(s.id, patch);
  if (patch.status) emitSessionStatus(updated, { previousStatus: s.status, source: 'auth-needed' });
  if (firstWait) {
    store.addEvent(s.id, 'auth-needed', {});
    bus.emit('waiting', { session: s.id, summary, category: 'action' });
  }
  bus.emit('changed');
}

const _lastRecover = new Map(); // tool -> ts (debounce the trigger)
function recoverAuth(tool, reason = 'manual', { force = false } = {}) {
  const t = now();
  if (!force && t - (_lastRecover.get(tool) || 0) < 8000) return 0; // debounce auto-triggers
  _lastRecover.set(tool, t);
  const targets = [...reg.values()].filter((e) => {
    const s = store.getSession(e.id);
    return s && s.tool === tool && s.status !== 'exited' && e.authNeeded && t - (e.lastReauth || 0) > 30000;
  });
  for (const e of targets) {
    e.lastReauth = t;
    e.authNeeded = false;
    store.addEvent(e.id, 'reauth', { reason });
    resume(e.id, { force: true }).catch((err) => console.error('[aios] reauth relaunch failed', e.id, err.message));
  }
  if (targets.length) {
    console.log(`[aios] re-auth(${tool}, ${reason}): relaunched ${targets.length} stuck session(s)`);
    bus.emit('changed');
  }
  return targets.length;
}

// ---------------------------------------------------------------------------
// live-terminal tailer
// ---------------------------------------------------------------------------
async function readRange(path, start, end) {
  const fh = await open(path, 'r');
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf;
  } finally {
    await fh.close();
  }
}

function applyBackspaces(s) {
  const out = [];
  for (const ch of String(s || '')) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

function cleanTerminalLog(s) {
  return applyBackspaces(stripAnsi(s))
    .replace(/\r/g, '\n')
    // Keep tabs/newlines, remove the remaining terminal controls that make a transcript unreadable.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{6,}/g, '\n\n\n\n\n');
}

async function terminalLogTail(sid, maxBytes = TERMINAL_LOG_MAX_BYTES) {
  const s = store.getSession(sid);
  if (!s) return null;
  const logFile = join(LOG_DIR, sid + '.log');
  const limit = Math.max(4096, Math.min(4 * 1024 * 1024, Number(maxBytes) || TERMINAL_LOG_MAX_BYTES));
  const st = await stat(logFile);
  const start = Math.max(0, st.size - limit);
  const buf = await readRange(logFile, start, st.size);
  return { text: cleanTerminalLog(buf.toString('utf8')), bytes: st.size - start, totalBytes: st.size, truncated: start > 0 };
}
async function tailOnce() {
  for (const entry of reg.values()) {
    let st;
    try {
      st = await stat(entry.logFile);
    } catch {
      continue;
    }
    if (st.size < entry.offset) entry.offset = 0; // truncated/rotated
    if (!entry.subscribers.size) {
      entry.offset = st.size; // keep cursor current cheaply
      continue;
    }
    if (st.size > entry.offset) {
      const buf = await readRange(entry.logFile, entry.offset, st.size);
      entry.offset = st.size;
      const payload = `event: data\ndata: ${buf.toString('base64')}\n\n`;
      for (const res of entry.subscribers) {
        try {
          res.write(payload);
        } catch {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
function decorate(s) {
  const project = s.project_id ? store.getProject(s.project_id) : null;
  const T = TOOLS[s.tool];
  const modelLabel = (T?.models || []).find((m) => m.id === s.model)?.label || modelDisplayLabel(s.model) || T?.modelLabel || null;
  const fastCapable = s.tool === 'codex' && modelSupportsFast(s.model || T?.model);
  return {
    ...s,
    fastMode: fastCapable && !!s.fast_mode,
    fastCapable,
    project,
    toolLabel: T?.label || s.tool,
    toolColor: T?.color || '#8b949e',
    modelLabel,
  };
}

function emitSessionStatus(s, { previousStatus = null, source = 'status' } = {}) {
  if (!s?.id) return;
  const d = decorate(s);
  bus.emit('session-status', {
    session: d.id,
    status: d.status,
    previousStatus,
    question: d.question || null,
    title: d.title || null,
    tool: d.tool,
    toolLabel: d.toolLabel,
    toolColor: d.toolColor,
    modelLabel: d.modelLabel,
    project: d.project ? { id: d.project.id, name: d.project.name } : null,
    source,
    ts: now(),
  });
}

async function suggestSessionTitle(s) {
  const project = s.project_id ? store.getProject(s.project_id) : null;
  const messages = store.recentMessagesFor(s.id, 40);
  const events = store.eventsFor(s.id, 20);
  const fallback = fallbackSessionTitle({ session: s, messages, events });
  const ctx = titleContext({ session: s, project, messages, events });
  try {
    const { obj, model } = await chatJson([
      { role: 'system', content: 'You write compact dashboard titles for coding-agent sessions. Return strict JSON only: {"title":"..."}. The title must be 3-8 words, under 60 characters, specific, and not include project/tool names unless essential.' },
      { role: 'user', content: ctx },
    ], { temperature: 0.1, max_tokens: 80 });
    const title = cleanSessionTitle(obj?.title || fallback);
    return { title: title || fallback, model, generated: !!obj?.title, fallback: false };
  } catch (e) {
    return { title: fallback, model: null, generated: false, fallback: true, error: String(e?.message || e).slice(0, 300) };
  }
}

function safeAttachmentName(name) {
  const raw = basename(String(name || 'attachment')).replace(/\0/g, '').trim() || 'attachment';
  const cleaned = raw.replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, ' ').slice(0, 160).trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'attachment';
}

function attachmentFormat(name, type = '') {
  const ext = extname(name || '').replace('.', '').toUpperCase();
  if (ext) return ext.slice(0, 12);
  const mime = String(type || '').split(';')[0].trim().toLowerCase();
  if (FORMAT_BY_MIME[mime]) return FORMAT_BY_MIME[mime];
  const subtype = mime.split('/')[1];
  return subtype ? subtype.toUpperCase().slice(0, 12) : 'FILE';
}

function attachmentDirForSession(s) {
  const project = s.project_id ? store.getProject(s.project_id) : null;
  const base = project?.path || DATA_DIR;
  return join(base, '.aios', 'attachments', s.id);
}

function normalizeAttachmentMeta(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((a) => {
      const name = safeAttachmentName(a?.name);
      const type = String(a?.type || '').slice(0, 120);
      const path = String(a?.path || '').trim();
      if (!path) return null;
      const size = Math.max(0, Number(a?.size || 0));
      return {
        name,
        type,
        size,
        path,
        format: String(a?.format || attachmentFormat(name, type)).slice(0, 16),
        isImage: Boolean(a?.isImage || type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)),
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function textWithAttachmentBlock(text, attachments) {
  const base = String(text || '').trim();
  if (!attachments.length) return base;
  const lines = attachments.map((a, i) => {
    const kind = a.isImage ? 'image' : 'file';
    const bits = [a.format, a.type || kind].filter(Boolean).join(', ');
    return `${i + 1}. ${a.name}${bits ? ` (${bits})` : ''}: ${a.path}`;
  });
  const lead = base || 'Please review the attached files/images.';
  return `${lead}\n\nAttached files available locally to this coding CLI:\n${lines.join('\n')}\n\nOpen these paths directly when you need the uploaded content.`;
}

function parsePayload(row) {
  try {
    return row?.payload ? JSON.parse(row.payload) : {};
  } catch {
    return {};
  }
}

function truncateText(text, limit = TIMELINE_TEXT_LIMIT) {
  const s = String(text || '');
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: s.slice(0, limit) + `\n\n[truncated ${s.length - limit} chars]`, truncated: true };
}

function attachmentUrl(sid, filePath) {
  const file = basename(String(filePath || ''));
  return file ? `api/session/${encodeURIComponent(sid)}/attachment/${encodeURIComponent(file)}` : null;
}

function attachmentDownloadUrl(sid, filePath) {
  const url = attachmentUrl(sid, filePath);
  return url ? `${url}?download=1` : null;
}

function attachmentFromPath(sid, { name, type, size, path, format, isImage } = {}) {
  const displayName = String(name || basename(String(path || '')) || 'attachment').slice(0, 180);
  const mime = String(type || '').slice(0, 120);
  const fmt = String(format || attachmentFormat(displayName, mime)).slice(0, 16);
  const image = Boolean(isImage || mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(displayName));
  return {
    name: displayName,
    type: mime,
    size: Math.max(0, Number(size || 0)),
    path: String(path || ''),
    file: basename(String(path || '')),
    format: fmt,
    isImage: image,
    url: attachmentUrl(sid, path),
    downloadUrl: attachmentDownloadUrl(sid, path),
  };
}

function attachmentRefText(a, s) {
  const id = `attachment:${s.id}:${basename(String(a.path || ''))}`;
  return `[${id}] ${a.name || basename(String(a.path || 'attachment'))}: ${a.path}`;
}

function assetContentKind(type = '', name = '') {
  const mime = String(type || '').split(';')[0].toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image';
  if (mime.startsWith('text/') || /(\.txt|\.md|\.markdown|\.json|\.csv|\.log|\.yaml|\.yml)$/i.test(name)) return 'text';
  if (mime === 'application/json') return 'text';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  return 'file';
}

function previewSnippet(text, max = ASSET_PREVIEW_CHARS) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(0, max));
}

async function filePreviewSnippet(filePath, max = ASSET_PREVIEW_CHARS) {
  if (!filePath) return '';
  let fh = null;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(Math.max(256, Math.min(64 * 1024, ASSET_PREVIEW_READ_BYTES)));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return previewSnippet(buf.subarray(0, bytesRead).toString('utf8'), max);
  } catch {
    return '';
  } finally {
    try { await fh?.close(); } catch {}
  }
}

function attachmentAsset(s, p, ts = 0) {
  const a = attachmentFromPath(s.id, p);
  const file = basename(String(a.path || ''));
  const idv = `attachment:${s.id}:${file}`;
  const refText = attachmentRefText(a, s);
  return {
    id: idv,
    kind: 'upload',
    contentKind: assetContentKind(a.type, a.name),
    session_id: s.id,
    session_title: s.title || '',
    ts,
    name: a.name,
    file,
    type: a.type,
    format: a.format,
    size: a.size,
    isImage: a.isImage,
    path: a.path,
    url: a.url,
    viewUrl: a.url,
    downloadUrl: a.downloadUrl,
    refText,
    composerText: refText,
  };
}

function wikiDownloadName(path) {
  const file = basename(String(path || 'wiki.md')).replace(/"/g, '') || 'wiki.md';
  return /\.md$/i.test(file) ? file : `${file}.md`;
}

function wikiRawUrl(pid, path, download = false) {
  return `api/project/${encodeURIComponent(pid)}/wiki/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
}

async function projectAssets(pid, { currentSessionId = '' } = {}) {
  const p = store.getProject(pid);
  if (!p) return null;
  const sessions = store.listSessions().filter((s) => s.project_id === pid);
  const uploadsByPath = new Map();
  for (const s of sessions) {
    for (const e of store.eventsFor(s.id, 1000)) {
      if (e.type !== 'attachment-upload') continue;
      const payload = parsePayload(e);
      if (!payload?.path) continue;
      uploadsByPath.set(String(payload.path), attachmentAsset(s, payload, e.ts));
    }
    for (const m of store.messagesFor(s.id, 500)) {
      const parsed = splitMessageAttachments(s.id, m.text || '');
      for (const a of parsed.attachments || []) {
        if (!a.path || uploadsByPath.has(a.path)) continue;
        uploadsByPath.set(a.path, attachmentAsset(s, a, m.ts));
      }
    }
  }
  const uploads = (await Promise.all([...uploadsByPath.values()]
    .map(async (a) => ({
      ...a,
      current_session: a.session_id === currentSessionId,
      preview: a.contentKind === 'text' ? await filePreviewSnippet(a.path) : '',
    }))))
    .sort((a, b) => Number(b.current_session) - Number(a.current_session) || Number(b.ts || 0) - Number(a.ts || 0));
  const wiki = listWiki(pid).map((w) => {
    const idv = `wiki:${w.path}`;
    const localPath = w.path.startsWith('docs/wiki/') && p.path ? join(p.path, w.path) : '';
    const page = readWiki(pid, w.path);
    const refText = `[${idv}] ${w.title || w.path}${localPath ? `: ${localPath}` : `: ${wikiRawUrl(pid, w.path)}`}`;
    return {
      id: idv,
      kind: 'wiki',
      contentKind: 'text',
      path: w.path,
      title: w.title || w.path,
      name: w.path,
      source: w.source || '',
      size: Number(w.bytes || 0),
      updated_at: w.updated_at || '',
      localPath,
      url: wikiRawUrl(pid, w.path),
      viewUrl: wikiRawUrl(pid, w.path),
      downloadUrl: wikiRawUrl(pid, w.path, true),
      downloadName: wikiDownloadName(w.path),
      preview: previewSnippet(page?.content || ''),
      refText,
      composerText: refText,
    };
  });
  return { ok: true, project: { id: p.id, name: p.name, path: p.path }, currentSessionId, uploads, wiki };
}

function splitMessageAttachments(sid, text) {
  const raw = String(text || '');
  const marker = '\n\nAttached files available locally to this coding CLI:\n';
  const idx = raw.indexOf(marker);
  if (idx < 0) return { text: raw, attachments: [] };
  const before = raw.slice(0, idx).trim();
  const rest = raw.slice(idx + marker.length);
  const attachments = [];
  for (const line of rest.split('\n')) {
    if (/^Open these paths directly/i.test(line)) break;
    const m = line.match(/^\s*\d+\.\s+(.+?)(?:\s+\(([^)]*)\))?:\s+(.+?)\s*$/);
    if (!m) continue;
    const meta = String(m[2] || '');
    const bits = meta.split(',').map((x) => x.trim()).filter(Boolean);
    const filePath = m[3].trim();
    attachments.push(attachmentFromPath(sid, {
      name: m[1].trim(),
      format: bits[0] || '',
      type: bits[1] || '',
      path: filePath,
    }));
  }
  return { text: before || raw, attachments };
}

function messageBlock(sid, m, decisionTimes) {
  if (m.direction === 'out' && m.source === 'detect' && decisionTimes.some((t) => Math.abs(Number(t) - Number(m.ts)) < 15000)) {
    return null;
  }
  const parsed = splitMessageAttachments(sid, m.text);
  const body = truncateText(parsed.text || m.text);
  const incoming = m.direction === 'in';
  return {
    id: `message-${m.id}`,
    type: 'message',
    role: incoming ? 'user' : 'agent',
    ts: m.ts,
    title: incoming ? `You${m.source ? ` · ${m.source}` : ''}` : 'Agent question',
    summary: (parsed.text || m.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    text: body.text,
    truncated: body.truncated,
    source: m.source || null,
    direction: m.direction,
    attachments: parsed.attachments,
  };
}

function decisionBlock(d) {
  const ask = truncateText(d.ask || d.question || '', 20000);
  const response = truncateText(d.response || '', 12000);
  return {
    id: `decision-${d.id}`,
    type: 'decision',
    ts: d.asked_at,
    category: d.category || 'review',
    status: d.status || 'pending',
    title: d.category === 'decision' ? 'Decision needed' : d.category === 'action' ? 'Action needed' : 'Review needed',
    summary: d.summary || d.question || 'Agent needs input',
    question: d.question || '',
    ask: ask.text,
    askTruncated: ask.truncated,
    response: response.text,
    responseTruncated: response.truncated,
    respondedAt: d.responded_at || null,
    responseSource: d.response_source || null,
  };
}

function eventBlock(sid, e) {
  const p = parsePayload(e);
  if (e.type === 'input') return null;
  if (e.type === 'hook') return null;
  if (e.type === 'status') return null;
  if (e.type === 'request-checkpoint') return null;
  if (e.type === 'attachment-upload') {
    const attachment = attachmentFromPath(sid, p);
    return {
      id: `event-${e.id}`,
      type: 'attachment',
      ts: e.ts,
      title: attachment.isImage ? 'Image attached' : 'File attached',
      summary: `${attachment.name} · ${attachment.format}${attachment.size ? ` · ${Math.round(attachment.size / 1024)} KB` : ''}`,
      attachment,
    };
  }
  const titles = {
    launch: 'Session launched',
    resume: 'Session resumed',
    exit: 'Session exited',
    settings: 'Settings changed',
    'auto-confirm': 'Auto-confirmed prompt',
    'usage-limit-stop': 'Usage limit stop',
  };
  if (!titles[e.type]) return null;
  const summary =
    e.type === 'status'
      ? `${p.from || 'unknown'} -> ${p.to || 'unknown'}`
      : e.type === 'settings'
        ? Object.keys(p).join(', ')
        : e.type === 'launch'
          ? [p.tool, p.dir].filter(Boolean).join(' · ')
          : e.type === 'usage-limit-stop'
            ? p.reason || titles[e.type]
            : titles[e.type];
  return {
    id: `event-${e.id}`,
    type: 'event',
    subtype: e.type,
    ts: e.ts,
    title: titles[e.type],
    summary,
    payload: p,
  };
}

function groupAttachmentBlocks(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b?.type !== 'attachment') {
      out.push(b);
      continue;
    }
    const group = [b];
    while (i + 1 < blocks.length && blocks[i + 1]?.type === 'attachment' && Number(blocks[i + 1].ts || 0) - Number(group[group.length - 1].ts || 0) < 120000) {
      group.push(blocks[++i]);
    }
    if (group.length === 1) {
      out.push(b);
      continue;
    }
    const attachments = group.map((x) => x.attachment).filter(Boolean);
    out.push({
      id: `attachment-group-${group[0].id}`,
      type: 'attachment',
      ts: group[0].ts,
      title: `${attachments.length} files attached`,
      summary: attachments.slice(0, 3).map((a) => a.name).join(', ') + (attachments.length > 3 ? `, +${attachments.length - 3} more` : ''),
      attachments,
    });
  }
  return out;
}

function parseNumstat(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const add = parts[0] === '-' ? null : Number(parts[0]);
    const del = parts[1] === '-' ? null : Number(parts[1]);
    const path = parts.slice(2).join('\t').trim();
    if (!path) continue;
    out.set(path, {
      path,
      add: Number.isFinite(add) ? add : null,
      del: Number.isFinite(del) ? del : null,
      binary: add == null || del == null,
    });
  }
  return out;
}

function numstatDeltas(beforeText, afterText) {
  const before = parseNumstat(beforeText);
  const after = parseNumstat(afterText);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const rows = [];
  for (const path of [...paths].sort()) {
    const b = before.get(path) || { add: 0, del: 0, binary: false };
    const a = after.get(path) || { add: 0, del: 0, binary: false };
    if (a.binary || b.binary) {
      if (a.binary !== b.binary || Boolean(after.get(path)) !== Boolean(before.get(path))) rows.push({ path, binary: true, add: null, del: null });
      continue;
    }
    const add = Number(a.add || 0) - Number(b.add || 0);
    const del = Number(a.del || 0) - Number(b.del || 0);
    if (add || del || Boolean(after.get(path)) !== Boolean(before.get(path))) rows.push({ path, add, del, binary: false });
  }
  return rows;
}

function formatNumstatDeltas(rows) {
  return rows.map((r) => {
    if (r.binary) return `${r.path}\tbinary changed`;
    const add = r.add > 0 ? `+${r.add}` : String(r.add || 0);
    const del = r.del > 0 ? `-${r.del}` : String(r.del || 0);
    return `${r.path}\t${add} ${del}`;
  }).join('\n');
}

async function projectCheckpoint(s) {
  const project = s.project_id ? store.getProject(s.project_id) : null;
  if (!project?.path) return null;
  const wtRoot = s.worktree_path || project.path; // isolated session → its worktree, not the shared tree
  const inside = await gitOut(wtRoot, ['rev-parse', '--is-inside-work-tree'], { maxBuffer: 4096, timeout: 2500 });
  if (inside.text.trim() !== 'true') return null;
  const [root, status, numstat] = await Promise.all([
    gitOut(wtRoot, ['rev-parse', '--show-toplevel'], { maxBuffer: 8192 }),
    gitOut(wtRoot, ['status', '--short'], { maxBuffer: 256 * 1024 }),
    gitOut(wtRoot, ['diff', '--no-ext-diff', '--numstat'], { maxBuffer: 512 * 1024 }),
  ]);
  return {
    root: root.text || wtRoot,
    status: truncateText(status.text || '', 120000).text,
    numstat: truncateText(numstat.text || '', 120000).text,
  };
}

async function projectDiffBlock(s, checkpoint = null) {
  const project = s.project_id ? store.getProject(s.project_id) : null;
  if (!project?.path) return null;
  const wtRoot = s.worktree_path || project.path; // isolated session → its worktree, not the shared tree
  const inside = await gitOut(wtRoot, ['rev-parse', '--is-inside-work-tree'], { maxBuffer: 4096, timeout: 2500 });
  if (inside.text.trim() !== 'true') return null;
  const [root, status, statOut, diffOut] = await Promise.all([
    gitOut(wtRoot, ['rev-parse', '--show-toplevel'], { maxBuffer: 8192 }),
    gitOut(wtRoot, ['status', '--short'], { maxBuffer: 256 * 1024 }),
    gitOut(wtRoot, ['diff', '--no-ext-diff', '--stat'], { maxBuffer: 512 * 1024 }),
    gitOut(wtRoot, ['diff', '--no-ext-diff', '--find-renames', '--unified=60'], { maxBuffer: 2 * 1024 * 1024, timeout: 6500 }),
  ]);
  const changed = status.text.split('\n').filter((l) => l.trim());
  if (!changed.length && !statOut.text && !diffOut.text) return null;
  if (checkpoint?.numstat) {
    const currentNumstat = await gitOut(wtRoot, ['diff', '--no-ext-diff', '--numstat'], { maxBuffer: 512 * 1024 });
    const deltas = numstatDeltas(checkpoint.numstat, currentNumstat.text || '');
    if (deltas.length) {
      return {
        id: 'diff-current-request',
        type: 'diff',
        scope: 'request',
        ts: now(),
        title: 'Request changes',
        summary: `${deltas.length} changed path${deltas.length === 1 ? '' : 's'} since this request started`,
        project: project.name || '',
        root: root.text || wtRoot,
        status: deltas.map((r) => r.path).join('\n'),
        stat: formatNumstatDeltas(deltas),
        diff: '',
        truncated: false,
        error: '',
      };
    }
  }
  const diff = truncateText(diffOut.text || '', TIMELINE_DIFF_LIMIT);
  return {
    id: 'diff-current-worktree',
    type: 'diff',
    scope: 'workspace',
    ts: now(),
    title: 'Current project changes',
    summary: `${changed.length || 'No'} changed path${changed.length === 1 ? '' : 's'} in the working tree`,
    project: project.name || '',
    root: root.text || wtRoot,
    status: status.text,
    stat: statOut.text,
    diff: diff.text,
    truncated: diff.truncated || Boolean(diffOut.error && !diffOut.text),
    error: diffOut.error && !diffOut.text ? 'Diff is too large or unavailable; showing status/stat only.' : '',
  };
}

async function buildTimeline(s) {
  const sid = s.id;
  const messages = store.messagesFor(sid, 300);
  const decisions = store.decisionsFor(sid, 120);
  const events = store.eventsFor(sid, 220).slice().reverse();
  const decisionTimes = decisions.map((d) => d.asked_at);
  const messageBlocks = messages.map((m) => messageBlock(sid, m, decisionTimes)).filter(Boolean);
  const latestUserTs = Math.max(0, ...messageBlocks.filter((b) => b.type === 'message' && b.role === 'user').map((b) => Number(b.ts || 0)));
  const latestCheckpoint = [...events].reverse().find((e) => e.type === 'request-checkpoint' && Number(e.ts || 0) >= latestUserTs - 5000);
  const messageAttachmentPaths = new Set(messageBlocks.flatMap((b) => b.attachments || []).map((a) => a.path).filter(Boolean));
  const eventBlocks = groupAttachmentBlocks(events.map((e) => {
    const p = parsePayload(e);
    if (e.type === 'attachment-upload' && p.path && messageAttachmentPaths.has(p.path)) return null;
    return eventBlock(sid, e);
  }).filter(Boolean));
  const blocks = [
    {
      id: 'session-start',
      type: 'event',
      subtype: 'session',
      ts: s.started_at,
      title: 'Session created',
      summary: [s.tool, s.model, s.title].filter(Boolean).join(' · '),
    },
    ...messageBlocks,
    ...decisions.map(decisionBlock),
    ...eventBlocks,
  ];
  const diff = await projectDiffBlock(s, latestCheckpoint ? parsePayload(latestCheckpoint) : null).catch(() => null);
  if (diff) blocks.push(diff);
  const tailRaw = stripAnsi(await snapshot(sid, TIMELINE_TERMINAL_LINES).catch(() => ''));
  const tail = truncateText(tailRaw.split('\n').filter((l) => l.trim()).slice(-TIMELINE_TERMINAL_LINES).join('\n'), 24000);
  if (tail.text) {
    blocks.push({
      id: 'terminal-tail',
      type: 'terminal',
      ts: now(),
      title: 'Terminal tail',
      summary: `Latest ${TIMELINE_TERMINAL_LINES} terminal lines`,
      text: tail.text,
      truncated: tail.truncated,
    });
  }
  blocks.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  return {
    generatedAt: now(),
    stats: {
      messages: messageBlocks.length,
      decisions: decisions.length,
      attachments: blocks.reduce((n, b) => n + (b.attachments?.length || (b.attachment ? 1 : 0)), 0),
      events: eventBlocks.length,
      diffs: diff ? 1 : 0,
    },
    blocks,
  };
}

route('POST', '/api/session', async (req, res) => {
  const b = await readJson(req);
  const tool = b.tool;
  if (!TOOLS[tool]) return json(res, 400, { error: 'unknown or missing tool' });
  let project = null;
  if (b.project_id) project = store.getProject(b.project_id);
  if (!project && b.path) {
    const p = String(b.path).trim();
    project = store.getProjectByPath(p) || store.createProject({ id: id('p'), name: basename(p) || p, path: p });
  }
  if (!project) return json(res, 400, { error: 'project_id or path required' });
  const T = TOOLS[tool];
  const autonomy = AUTONOMY_LEVELS.includes(b.autonomy) ? b.autonomy : DEFAULT_AUTONOMY;
  const effort = T.efforts.length ? (T.efforts.includes(b.effort) ? b.effort : T.defaultEffort) : null;
  const model = cleanModelId(b.model) || T.model || null;
  const fastMode = tool === 'codex' && modelSupportsFast(model) && boolParam(b.fastMode ?? b.fast_mode);
  const orchestration = T.orchestrations?.length ? (T.orchestrations.includes(b.orchestration) ? b.orchestration : T.defaultOrchestration) : null;
  try {
    const s = await launch({ project, tool, task: b.task ? String(b.task) : null, effort, autonomy, model, fastMode, orchestration });
    json(res, 201, decorate(s));
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

// Manual re-auth recovery (for logins Supercalm can't see, e.g. on the proxy dashboard or a terminal):
// relaunch every stuck-on-expired-login session of the given tool (or all tools).
route('POST', '/api/reauth', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  let relaunched = 0;
  if (b.tool && TOOLS[b.tool]) relaunched = recoverAuth(b.tool, 'manual', { force: true });
  else for (const t of Object.keys(TOOLS)) relaunched += recoverAuth(t, 'manual', { force: true });
  json(res, 200, { ok: true, relaunched });
});

route('GET', '/api/session/:id', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  json(res, 200, {
    ...decorate(s),
    messages: store.messagesFor(sid),
    events: store.eventsFor(sid, 60),
    snapshot: await snapshot(sid),
  });
});

route('GET', '/api/session/:id/log', async (req, res, { id: sid }) => {
  if (!store.getSession(sid)) return json(res, 404, { error: 'no such session' });
  const u = new URL(req.url, SELF_URL);
  try {
    const log = await terminalLogTail(sid, u.searchParams.get('max'));
    json(res, 200, { ok: true, ...log });
  } catch {
    json(res, 200, { ok: true, text: '', bytes: 0, totalBytes: 0, truncated: false });
  }
});

route('POST', '/api/session/:id/title', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req).catch(() => ({}));
  const title = cleanSessionTitle(b.title);
  if (!title) return json(res, 400, { error: 'title required' });
  const updated = store.updateSession(sid, { title });
  store.addEvent(sid, 'title-update', { title, source: b.source || 'manual' });
  emitSessionStatus(updated, { previousStatus: s.status, source: 'title' });
  bus.emit('changed');
  json(res, 200, { ok: true, session: decorate(updated), title });
});

route('POST', '/api/session/:id/title/suggest', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req).catch(() => ({}));
  const suggestion = await suggestSessionTitle(s);
  if (b.apply) {
    const updated = store.updateSession(sid, { title: suggestion.title });
    store.addEvent(sid, 'title-update', { title: suggestion.title, source: suggestion.generated ? 'model' : 'fallback', model: suggestion.model, fallback: suggestion.fallback });
    emitSessionStatus(updated, { previousStatus: s.status, source: 'title-suggest' });
    bus.emit('changed');
    return json(res, 200, { ok: true, ...suggestion, session: decorate(updated) });
  }
  json(res, 200, { ok: true, ...suggestion });
});

route('GET', '/api/session/:id/timeline', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const timeline = await buildTimeline(s);
  json(res, 200, { ok: true, session: decorate(s), ...timeline });
});

route('GET', '/api/session/:id/agui', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const session = decorate(s);
  const timeline = await buildTimeline(s);
  json(res, 200, buildAgentTimelinePayload({ session, timeline }));
});

route('GET', '/api/session/:id/usage', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  json(res, 200, await sessionUsagePayload(s));
});

route('GET', '/api/session/:id/map', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  json(res, 200, { ok: true, map: getSessionMap(sid), options: sessionMapOptions() });
});

route('POST', '/api/session/:id/map', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req);
  const mode = b.mode === 'update' ? 'update' : 'generate';
  const map = await generateSessionMap(s, { snapshot: await snapshot(sid), mode, targetId: b.target || null });
  json(res, 200, { ok: map.status !== 'error', map, options: sessionMapOptions() });
});

// Deterministic "session space map" (solar-system + flow): built from the transcript, zero LLM, auto-updated.
route('GET', '/api/session/:id/space', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  let space = getSessionSpace(sid);
  if (!space || !space.space) space = await ensureSessionSpace(s); // build on first view
  kickLabels(s); // label THIS session on demand (the sweep only labels live sessions); cheap when cached
  json(res, 200, { ok: true, space, labeling: labelStats() });
});

// Global cheap-LLM labeling switch + running token/$ meter (labeling spans all sessions). The graph panel
// shows the spend and lets the user turn it off so a token-hungry fleet can't quietly rack up cost.
route('GET', '/api/space/labeling', async (req, res) => {
  json(res, 200, { ok: true, labeling: labelStats() });
});
route('POST', '/api/space/labeling', async (req, res) => {
  const b = await readJson(req);
  json(res, 200, { ok: true, labeling: setLabeling(!!b.enabled) });
});
// graph-agent config (⚙): default view, labeling model, extra prompt instructions, enable — all global.
route('GET', '/api/space/config', async (req, res) => {
  // every chat-capable fleet model, so the picker can switch among them by usage condition (exclude
  // image/video/audio/embedding models — they can't do the JSON labeling task)
  const models = listProxyModels({ includeImages: false })
    .filter((m) => !/image|video|wan2|tts|whisper|embed|computer-use/i.test(m.id))
    .map((m) => ({ id: m.id, label: m.label, provider: m.providerLabel, port: m.port }));
  json(res, 200, { ok: true, config: labelConfig(), models });
});
route('POST', '/api/space/config', async (req, res) => {
  const b = await readJson(req);
  json(res, 200, { ok: true, config: setLabelConfig(b) });
});

// Click-to-transcript: the raw jsonl slice a node was built from.
route('GET', '/api/session/:id/space/source/:node', async (req, res, { id: sid, node }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const slice = await sourceSliceFor(sid, node);
  json(res, 200, { ok: !!slice, slice });
});

startSpaceBuilder();

route('POST', '/api/session/:id/limit', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req);
  if (b.clear) clearSessionLimit(sid);
  else setSessionLimit(sid, b);
  json(res, 200, await sessionUsagePayload(store.getSession(sid) || s));
});

route('GET', '/api/session/:id/attachment/:file', async (req, res, { id: sid, file }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const u = new URL(req.url, 'http://x');
  const download = u.searchParams.get('download') === '1';
  const name = basename(String(file || ''));
  if (!name || name === '.' || name === '..') return json(res, 400, { error: 'bad attachment name' });
  const dir = normalize(attachmentDirForSession(s));
  const target = normalize(join(dir, name));
  if (!target.startsWith(dir + '/') && target !== dir) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(target);
    const ext = extname(target).toLowerCase();
    const type = ATTACHMENT_CONTENT_TYPES[ext] || 'application/octet-stream';
    const inline = !download && (/^image\//.test(type) || /^text\//.test(type) || /^application\/(json|pdf)\b/.test(type));
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'private, max-age=3600',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`,
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'attachment not found' });
  }
});

route('GET', '/api/project/:id/assets', async (req, res, { id: pid }) => {
  const s = new URL(req.url, 'http://x').searchParams.get('session') || '';
  const assets = await projectAssets(pid, { currentSessionId: s });
  if (!assets) return json(res, 404, { error: 'no such project' });
  json(res, 200, assets);
});

// --- project working-tree files: let the operator SEE the docs an agent wrote --------------------
// The agent says "I wrote docs/specs/foo.md" but the operator can't read it. These two routes expose the
// project's working tree (confined to the project root): a list of what the agent just changed + tracked
// docs, and a single-file reader (JSON metadata, or ?raw=1 for the bytes) feeding the click-to-open viewer
// and the Knowledge "Files" list. Path traversal is blocked by resolveInRoot(); size is capped.

async function walkRecentFiles(root, { cap = 400, maxDepth = 6 } = {}) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || out.length >= cap) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.') && e.name !== '.env') { /* skip dotfiles/dirs except .env */ }
      if (e.isDirectory()) {
        if (FILE_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const abs = join(dir, e.name);
        if (!FILE_TEXT_EXTS.has(extname(e.name).toLowerCase())) continue;
        try { const st = await stat(abs); out.push({ path: relative(root, abs), status: 'tracked', bytes: st.size, mtime: st.mtimeMs }); } catch {}
      }
    }
  }
  await walk(root, 0);
  return out;
}

async function listProjectFiles(root) {
  const base = normalize(root);
  const rows = new Map(); // rel -> {path, status, bytes, mtime}
  const gitRepo = (await gitOut(base, ['rev-parse', '--is-inside-work-tree'])).text.trim() === 'true';
  if (gitRepo) {
    // Uncommitted changes = what the agent just wrote. -z: NUL-separated, path unquoted.
    const status = await gitOut(base, ['status', '--porcelain=v1', '-z']);
    const toks = status.text ? status.text.split('\0') : [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t) continue;
      const xy = t.slice(0, 2);
      let p = t.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C') { i++; /* next token is the source path; use dest (p) */ }
      if (!p) continue;
      const status_ = (xy.includes('A') || xy === '??') ? 'new' : 'modified';
      rows.set(p, { path: p, status: status_ });
    }
    // Tracked docs so committed specs still show. Limit to markdown + the docs/ tree.
    const docs = await gitOut(base, ['ls-files', '-z', '--', '*.md', '*.markdown', 'docs']);
    for (const p of (docs.text ? docs.text.split('\0') : [])) {
      if (p && !rows.has(p)) rows.set(p, { path: p, status: 'tracked' });
    }
  } else {
    for (const r of await walkRecentFiles(base)) rows.set(r.path, r);
  }
  // stat for bytes/mtime (best-effort), drop anything that escaped/vanished
  const list = [];
  for (const r of rows.values()) {
    const abs = resolveInRoot(base, r.path);
    if (!abs) continue;
    if (r.bytes == null) { try { const st = await stat(abs); r.bytes = st.size; r.mtime = st.mtimeMs; } catch { continue; } }
    list.push(r);
  }
  const rank = { new: 0, modified: 1, tracked: 2 };
  list.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.mtime - a.mtime) || a.path.localeCompare(b.path));
  const truncated = list.length > FILE_LIST_MAX;
  return { root: base, gitRepo, files: list.slice(0, FILE_LIST_MAX), truncated };
}

route('GET', '/api/session/:id/files', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  try {
    json(res, 200, await listProjectFiles(projectFileRoot(s)));
  } catch (e) {
    json(res, 200, { root: projectFileRoot(s), gitRepo: false, files: [], truncated: false, error: String(e.message || e) });
  }
});

route('GET', '/api/session/:id/file', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const u = new URL(req.url, 'http://x');
  const rel = u.searchParams.get('path') || '';
  const raw = u.searchParams.get('raw') === '1';
  const download = u.searchParams.get('download') === '1';
  if (!rel) return json(res, 400, { error: 'path required' });
  const root = projectFileRoot(s);
  const target = resolveInRoot(root, rel);
  if (!target) return json(res, 403, { error: 'path is outside the project root' });
  let st;
  try { st = await stat(target); } catch { return json(res, 404, { error: 'file not found' }); }
  if (st.isDirectory()) return json(res, 400, { error: 'path is a directory' });
  const ext = extname(target).toLowerCase();
  const isImg = FILE_IMAGE_RX.test(ext);
  const isPdf = ext === '.pdf';
  const viewBase = `api/session/${encodeURIComponent(sid)}/file?path=${encodeURIComponent(rel)}`;

  if (!raw) {
    let kind = 'binary';
    if (isImg) kind = 'image';
    else if (isPdf) kind = 'pdf';
    else {
      const head = await readHead(target, Math.min(8192, st.size || 1)).catch(() => '');
      kind = (st.size === 0 || (head && !head.includes("\u0000"))) ? "text" : "binary";
    }
    return json(res, 200, {
      path: relative(root, target) || basename(target), rel, name: basename(target),
      bytes: st.size, mtime: st.mtimeMs, contentKind: kind, binary: kind === 'binary',
      truncated: st.size > FILE_VIEW_MAX_BYTES,
      viewUrl: `${viewBase}&raw=1`, downloadUrl: `${viewBase}&raw=1&download=1`,
    });
  }

  try {
    let data = await readFile(target);
    let truncated = false;
    if (data.length > FILE_VIEW_MAX_BYTES) { data = data.subarray(0, FILE_VIEW_MAX_BYTES); truncated = true; }
    const type = FILE_VIEW_CONTENT_TYPES[ext] || (isImg || isPdf ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    const inline = !download && (/^text\//.test(type) || /json|pdf|markdown/.test(type) || isImg);
    const headers = {
      'content-type': type,
      'cache-control': 'private, max-age=15',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${basename(target).replace(/"/g, '')}"`,
    };
    if (truncated) headers['x-aios-truncated'] = '1';
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    json(res, 404, { error: 'file not found' });
  }
});

route('POST', '/api/session/:id/upload', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req);
  const name = safeAttachmentName(b.name);
  const type = String(b.type || '').slice(0, 120);
  const data = String(b.data_base64 || b.data || '').replace(/^data:[^,]+,/, '');
  if (!data) return json(res, 400, { error: 'data_base64 required' });
  const estimatedBytes = Math.floor((data.length * 3) / 4);
  if (estimatedBytes > ATTACHMENT_MAX_BYTES + 4) {
    return json(res, 413, { error: `attachment too large; max ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB` });
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) return json(res, 400, { error: 'empty attachment' });
  if (buf.length > ATTACHMENT_MAX_BYTES) {
    return json(res, 413, { error: `attachment too large; max ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB` });
  }
  const dir = attachmentDirForSession(s);
  await mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${id('u')}-${name}`;
  const path = join(dir, fileName);
  await writeFile(path, buf, { mode: 0o600 });
  const attachment = {
    id: id('a'),
    name,
    type,
    size: buf.length,
    path,
    format: attachmentFormat(name, type),
    isImage: type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name),
  };
  store.addEvent(sid, 'attachment-upload', {
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    path: attachment.path,
    format: attachment.format,
    isImage: attachment.isImage,
  });
  json(res, 201, { ok: true, attachment, maxBytes: ATTACHMENT_MAX_BYTES });
});

// Deliver an operator/assistant reply into a session's pane with full bookkeeping — the ONE shared
// path for the /input route and the voice concierge (voice used to re-implement a subset by hand:
// no liveness check, no checkpoint — drift that made it type into dead panes and claim success).
// Returns { ok:true } | { stopped:true } | { missing:true }; throws only when tmux delivery itself
// fails. Post-send bookkeeping is best-effort: once the pane ACCEPTED the text, a store hiccup must
// not re-announce the reply as failed — the caller would re-deliver it.
export async function deliverReply(sid, text, { source = 'text', attachments = 0 } = {}) {
  const s = store.getSession(sid);
  if (!s) return { missing: true };
  // graceful when the pane is gone (stopped/killed) — tell the caller to offer resume
  if (!(await tmuxOk('has-session', '-t', s.tmux))) {
    if (s.status !== 'exited') {
      const updated = store.updateSession(sid, { status: 'exited', ended_at: now() });
      emitSessionStatus(updated, { previousStatus: s.status, source: 'stopped-input' });
      bus.emit('changed');
    }
    return { stopped: true };
  }
  const checkpoint = await projectCheckpoint(s).catch(() => null);
  await sendText(s.tmux, text);
  try { store.addMessage(sid, 'in', source, text); } catch {}
  try { if (checkpoint) store.addEvent(sid, 'request-checkpoint', checkpoint); } catch {}
  try { store.answerPendingDecision(sid, { response: text, response_source: source }); } catch {} // link to the open ask, if any
  try { store.addEvent(sid, 'input', { source, len: text.length, attachments }); } catch {}
  try { bus.emit('event', { type: 'input', session: sid, source }); } catch {} // doctrine distiller listens (fire-and-forget)
  try { noteReply(sid); } catch {} // -> working, clear question/summary, reset idle timer, broadcast
  return { ok: true };
}

route('POST', '/api/session/:id/input', async (req, res, { id: sid }) => {
  if (!store.getSession(sid)) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req);
  const attachments = normalizeAttachmentMeta(b.attachments);
  const text = textWithAttachmentBlock(b.text, attachments);
  if (!text.trim()) return json(res, 400, { error: 'text required' });
  const r = await deliverReply(sid, text, { source: b.source || 'text', attachments: attachments.length });
  if (r.stopped) return json(res, 409, { error: 'session has stopped — resume it to continue', stopped: true });
  if (r.missing) return json(res, 404, { error: 'no such session' });
  json(res, 200, { ok: true });
});

// Ask TTL sweep (attention governor): archive pending asks nobody answered within the TTL. Runs at
// boot + hourly; 'expired' status keeps them queryable on /decisions without polluting live queues.
import { askTtlMs } from './agents/supervisor/engagement.js';
function sweepStaleAsks() {
  const n = store.expireStaleAsks(askTtlMs());
  if (n) console.log(`[aios] expired ${n} stale pending ask(s) past the TTL`);
}
setTimeout(sweepStaleAsks, 30_000);
setInterval(sweepStaleAsks, 3600_000).unref?.();

// Per-project CONTEXT.md (shared vocabulary). Injected into launches only when the contextInject flag
// AND the per-project `enabled` toggle are on (see startPane). Generation uses a cheap non-claude model.
route('GET', '/api/project/:id/context', (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  json(res, 200, { ok: true, context: getContext(pid), injectEnabled: flagOn('contextInject') });
});
route('POST', '/api/project/:id/context', async (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  const b = await readJson(req).catch(() => ({}));
  const patch = {};
  if (typeof b.doc === 'string') {
    if (b.doc.length > 20000) return json(res, 413, { error: 'doc too large (max 20000)' });
    patch.doc = b.doc; patch.source = 'manual';
  }
  if ('enabled' in b) patch.enabled = !!b.enabled;
  json(res, 200, { ok: true, context: setContext(pid, patch) });
});
route('POST', '/api/project/:id/context/generate', async (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  try {
    json(res, 200, { ok: true, context: await generateContext(p) });
  } catch (e) {
    json(res, 502, { error: 'generate failed: ' + (e?.message || e) });
  }
});

// Pre-flight sharpened spec for a session (#3). Stable shape incl. status so the operator can tell
// success vs skipped/timeout/error vs none.
route('GET', '/api/session/:id/preflight', (req, res, { id: sid }) => {
  const pf = getPreflight(sid);
  json(res, 200, pf ? { ok: true, ...pf } : { ok: true, status: 'none', sessionId: sid });
});

// Per-project wiki (#4 Phase 1). Read + search + on-demand rebuild. Pages are synthesized from the
// project's CONTEXT.md + session history + repo by a cheap non-claude model.
route('GET', '/api/project/:id/wiki', (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams.get('q');
  const path = u.searchParams.get('path');
  if (path) { const pg = readWiki(pid, path); return json(res, pg ? 200 : 404, pg ? { ok: true, page: pg } : { error: 'no such page' }); }
  if (q) return json(res, 200, { ok: true, results: searchWiki(pid, q) });
  json(res, 200, { ok: true, pages: listWiki(pid) });
});
route('GET', '/api/project/:id/wiki/raw', (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  const u = new URL(req.url, 'http://x');
  const path = u.searchParams.get('path') || '';
  const pg = path ? readWiki(pid, path) : null;
  if (!pg) return json(res, 404, { error: 'no such page' });
  const download = u.searchParams.get('download') === '1';
  const file = wikiDownloadName(path);
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': 'private, max-age=300',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${file}"`,
  });
  res.end(String(pg.content || ''));
});
route('POST', '/api/project/:id/wiki/rebuild', async (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  try { json(res, 200, { ok: true, ...(await rebuildWiki(p)) }); }
  catch (e) { json(res, 502, { error: 'rebuild failed: ' + (e?.message || e) }); }
});

// Per-project helper enables + models (context-inject / preflight / wiki-MCP) — the panel's on/off + config.
route('GET', '/api/project/:id/helpers', (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  json(res, 200, { ok: true, helpers: getHelpers(pid), models: listProxyModels({ includeImages: false }) });
});
route('POST', '/api/project/:id/helpers', async (req, res, { id: pid }) => {
  const p = store.getProject(pid);
  if (!p) return json(res, 404, { error: 'no such project' });
  const b = await readJson(req).catch(() => ({}));
  json(res, 200, { ok: true, helpers: setHelpers(pid, b) });
});

route('POST', '/api/session/:id/key', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req);
  if (!b.key) return json(res, 400, { error: 'key required' });
  await sendKey(s.tmux, b.key);
  store.updateSession(sid, { last_activity: now() });
  json(res, 200, { ok: true });
});

// Raw keystrokes from the interactive terminal (web/session.js term.onData). Like /input, tell the
// client to resume if the pane is gone (409 stopped) so the UI can offer Resume rather than erroring.
route('POST', '/api/session/:id/type', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req);
  const data = typeof b.data === 'string' ? b.data : '';
  if (!data) return json(res, 400, { error: 'data required' });
  if (!(await tmuxOk('has-session', '-t', s.tmux))) {
    if (s.status !== 'exited') {
      const updated = store.updateSession(sid, { status: 'exited', ended_at: now() });
      emitSessionStatus(updated, { previousStatus: s.status, source: 'stopped-type' });
      bus.emit('changed');
    }
    return json(res, 409, { error: 'session has stopped — resume it to continue', stopped: true });
  }
  await sendRaw(s.tmux, data);
  markTyping(sid); // live terminal keystrokes are operator presence too -> hold supervisor auto-sends
  store.updateSession(sid, { last_activity: now() });
  json(res, 200, { ok: true });
});

// Operator-presence heartbeat. The composer pings this while you're mid-reply (and live terminal typing
// marks it via /type) so the autonomous supervisor defers its auto-sends instead of racing your message.
// Pure presence (TTL'd in operator_presence.js) -- no tmux, safe even on a stopped pane; cheap + fire-and-
// forget from the client. 404 only if the session id is unknown.
route('POST', '/api/session/:id/typing', async (req, res, { id: sid }) => {
  if (!store.getSession(sid)) return json(res, 404, { error: 'no such session' });
  markTyping(sid);
  json(res, 200, { ok: true });
});

route('POST', '/api/session/:id/resize', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const b = await readJson(req);
  // Clamp cols against the client's own viewport: a real terminal cell is never <4 CSS px wide, so a
  // 400px phone can hold ~100 cols, not 354. A glitched measurement (font still loading -> tiny cell
  // width -> huge colsCapacity) would otherwise set the pane absurdly wide and garble the TUI. This is
  // defence-in-depth alongside the narrowest-wins arbitration in resizeCandidate().
  const vw = Number(b.viewport?.width) || 0;
  const maxCols = vw ? Math.max(20, Math.floor(vw / 4)) : 500;
  const cols = Math.max(20, Math.min(500, maxCols, parseInt(b.cols, 10) || 0));
  const rows = Math.max(5, Math.min(200, parseInt(b.rows, 10) || 0));
  const t = now();
  const clientId = resizeClientId(req, b.clientId);
  const headless = boolParam(b.headless) || /\bHeadlessChrome\//.test(req.headers['user-agent'] || '');
  const visible = b.visible !== false && !boolParam(b.hidden);
  const focused = boolParam(b.focused);
  const interactive = boolParam(b.interactive);
  const clients = resizeClientPool(sid);
  const prev = clients.get(clientId);
  clients.set(clientId, {
    clientId,
    cols,
    rows,
    visible,
    focused,
    headless,
    ts: t,
    interactiveUntil: interactive ? t + RESIZE_INTERACTIVE_MS : Math.max(prev?.interactiveUntil || 0, 0),
  });
  while (clients.size > RESIZE_MAX_CLIENTS) {
    const oldest = [...clients.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (!oldest) break;
    clients.delete(oldest[0]);
  }
  // Apply the shared (narrowest-fits-all) size whenever it CHANGES — not only when the posting client
  // is the "owner". A newly-joined narrow viewer must be able to shrink the pane immediately so it stops
  // seeing over-wide wrapped content; waiting for the wide owner's next post left the narrow client
  // garbled for up to a full TTL. The per-session cache keeps this idempotent (no redundant tmux calls).
  const chosen = resizeCandidate(sid, t);
  let applied = false;
  if (chosen && chosen.cols && chosen.rows) {
    const dims = `${chosen.cols}x${chosen.rows}`;
    if (resizeApplied.get(sid) !== dims) {
      await tmuxOk('resize-window', '-t', s.tmux, '-x', String(chosen.cols), '-y', String(chosen.rows));
      resizeApplied.set(sid, dims);
      applied = true;
    }
  }
  json(res, 200, {
    ok: true,
    applied,
    cols: chosen?.cols || cols,
    rows: chosen?.rows || rows,
    owner: chosen?.clientId || null,
  });
});

route('POST', '/api/session/:id/stop', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  // A manual Stop is the operator taking over: disable the Supervisor auto-pilot first so it can't
  // relaunch/re-nudge the agent after we halt it. Stays off until re-enabled from the Supervisor tab.
  let supervisorDisabled = false;
  const sup = store.getGrant(sid, 'supervisor');
  if (sup?.enabled) {
    store.upsertGrant(sid, 'supervisor', { enabled: false });
    store.addEvent(sid, 'supervisor-paused', { reason: 'operator-stop' });
    supervisorDisabled = true;
  }
  // "Stop" PARKS the session (not just a Ctrl-C, which was a no-op on an already-idle agent): interrupt
  // anything in flight, then free the tmux pane and mark it exited. The session stays fully RESUMABLE —
  // Resume relaunches claude `--continue` / codex `resume` with the conversation intact — so this is the
  // operator's "stop it now, I'll bring it back later" without the finality of Kill.
  if (s.status !== 'exited') {
    await sendKey(s.tmux, 'ctrl-c').catch(() => {});
    await tmuxOk('kill-session', '-t', s.tmux);
    const entry = reg.get(sid);
    if (entry) markExited(entry, null);
    else {
      const updated = store.updateSession(sid, { status: 'exited', question: null, ended_at: now(), last_activity: now() });
      emitSessionStatus(updated, { previousStatus: s.status, source: 'stop' });
    }
  }
  store.addEvent(sid, 'stop', { parked: true });
  bus.emit('changed');
  json(res, 200, { ok: true, supervisorDisabled, parked: true, resumable: true });
});

route('POST', '/api/session/:id/kill', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  store.addEvent(sid, 'kill', { manual: true });
  await tmuxOk('kill-session', '-t', s.tmux);
  const entry = reg.get(sid);
  if (entry) markExited(entry, null);
  else {
    const updated = store.updateSession(sid, { status: 'exited', ended_at: now() });
    emitSessionStatus(updated, { previousStatus: s.status, source: 'kill' });
  }
  json(res, 200, { ok: true });
});

route('POST', '/api/session/:id/resume', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  try {
    json(res, 200, decorate(await resume(sid)));
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

// Change autonomy / effort / model on the fly. Live where the tool supports it
// (claude `/effort`, codex `/fast`), else applied by relaunching the session continuing the conversation.
route('POST', '/api/session/:id/settings', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  const T = TOOLS[s.tool];
  if (!T) return json(res, 400, { error: 'unknown tool' });
  const b = await readJson(req);
  const patch = {};
  const changed = [];
  if (b.autonomy && AUTONOMY_LEVELS.includes(b.autonomy) && b.autonomy !== s.autonomy) { patch.autonomy = b.autonomy; changed.push('autonomy'); }
  if (b.effort && T.efforts.includes(b.effort) && b.effort !== s.effort) { patch.effort = b.effort; changed.push('effort'); }
  const nextModel = cleanModelId(b.model);
  if (nextModel && nextModel !== s.model) { patch.model = nextModel; changed.push('model'); }
  const hasFastMode = Object.hasOwn(b, 'fastMode') || Object.hasOwn(b, 'fast_mode');
  if (hasFastMode) {
    if (s.tool !== 'codex') return json(res, 400, { error: 'fast mode is codex-only' });
    const fastModel = nextModel || s.model || T.model;
    if (boolParam(b.fastMode ?? b.fast_mode) && !modelSupportsFast(fastModel)) {
      return json(res, 400, { error: 'fast mode is only available for gpt-5.5 and gpt-5.4' });
    }
    const nextFastMode = boolParam(b.fastMode ?? b.fast_mode);
    if (nextFastMode !== !!s.fast_mode) { patch.fast_mode = nextFastMode ? 1 : 0; changed.push('fast_mode'); }
  }
  if (nextModel && !modelSupportsFast(nextModel) && (patch.fast_mode ?? s.fast_mode)) {
    patch.fast_mode = 0;
    if (!changed.includes('fast_mode')) changed.push('fast_mode');
  }
  if (b.orchestration && (T.orchestrations || []).includes(b.orchestration) && b.orchestration !== s.orchestration) { patch.orchestration = b.orchestration; changed.push('orchestration'); }
  if (Object.hasOwn(b, 'codex_via_proxy') || Object.hasOwn(b, 'viaProxy')) {
    if (s.tool !== 'codex') return json(res, 400, { error: 'codex_via_proxy is codex-only' });
    const next = boolParam(b.codex_via_proxy ?? b.viaProxy) ? 1 : 0;
    if (next !== (s.codex_via_proxy ? 1 : 0)) { patch.codex_via_proxy = next; changed.push('codex_via_proxy'); } // not live -> relaunches
  }
  if (!changed.length) return json(res, 200, { ...decorate(s), applied: 'none' });

  store.updateSession(sid, patch);
  store.addEvent(sid, 'settings', patch);

  const alive = await tmuxOk('has-session', '-t', s.tmux);
  const needsRelaunch = changed.some((k) => !(T.live && T.live[k]));
  let applied = 'stored';
  let result = store.getSession(sid);
  try {
    if (alive && needsRelaunch) {
      result = await resume(sid, { force: true }); // applies all current settings via launch flags
      applied = 'relaunched';
    } else if (alive) {
      let sent = 0;
      for (const k of changed) {
        const activeModel = patch.model || s.model;
        if (s.tool === 'claude' && k === 'effort' && activeModel && !isNativeModel('claude', activeModel)) continue;
        await sendText(s.tmux, T.live[k](patch[k])); // live, no restart
        sent++;
      }
      applied = sent ? 'live' : 'stored';
    }
  } catch (e) {
    return json(res, 500, { error: 'applied to settings but failed to take effect: ' + e.message });
  }
  bus.emit('changed');
  json(res, 200, { ...decorate(result), applied });
});

route('GET', '/api/session/:id/stream', async (req, res, { id: sid }) => {
  const s = store.getSession(sid);
  if (!s) return json(res, 404, { error: 'no such session' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const entry = register(s);
  try {
    // Re-baseline the browser xterm to tmux's ACTUAL screen on every (re)connect. If the pane is on the
    // alternate screen (a full-screen TUI like Claude Code), switch xterm to its alt buffer and paint the
    // current visible grid — the startup `1049h` happened long before this connect and isn't in the live
    // tail, so without this the browser stays on the main buffer and every absolute-positioned redraw in
    // the stream tears the UI. On the alt buffer we want exactly the on-screen grid (no scrollback lines),
    // so capture without -S. Off the alt screen (Codex, shells), keep the history-rich snapshot as before.
    if (await paneAltOn(sid)) {
      const grid = (await snapshot(sid, 0)).replace(/\r?\n/g, '\r\n');
      const payload = '\x1b[?1049h\x1b[2J\x1b[H' + grid;
      res.write(`event: data\ndata: ${Buffer.from(payload, 'utf8').toString('base64')}\n\n`);
    } else {
      const snap = await snapshot(sid, TERMINAL_SNAPSHOT_LINES);
      if (snap) {
        const normalized = snap.replace(/\r?\n/g, '\r\n');
        res.write(`event: data\ndata: ${Buffer.from(normalized, 'utf8').toString('base64')}\n\n`);
      }
    }
  } catch {}
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  const done = () => {
    clearInterval(ping);
    if (entry) entry.subscribers.delete(res);
  };
  req.on('close', done);
  res.on('error', done); // abrupt disconnect -> async socket error; swallow it
  if (entry) {
    entry.subscribers.add(res);
  } else {
    res.write('event: ended\ndata: {}\n\n');
  }
});

// ---------------------------------------------------------------------------
// boot (fire-and-forget; no top-level await so the module import resolves fast)
// ---------------------------------------------------------------------------
async function boot() {
  await ensureServer();
  await tmuxOk('set-option', '-g', 'history-limit', '200000');
  await discover();
  setInterval(() => pollOnce().catch((e) => console.error('[aios] poll error', e.message)), POLL_MS);
  setInterval(() => tailOnce().catch((e) => console.error('[aios] tail error', e.message)), TAIL_MS);
  console.log('[aios] sessions ready');
}
boot().catch((e) => console.error('[aios] sessions boot failed:', e.message));
