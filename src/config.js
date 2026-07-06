import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { codexProviderArgs, isNativeModel, modelSupportsFast, toolEnv, toolModels } from './model_catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

// Load a gitignored local env file (data/aios.env, or AIOS_ENV_FILE) into process.env BEFORE anything
// reads config. This keeps machine-specific values — device IPs, your tailnet host, keys — OUT of the
// repo while the code ships generic defaults. Simple KEY=VALUE lines (# comments ok); a value already in
// the real environment always wins, so it never overrides an explicit export.
(() => {
  const envFile = process.env.AIOS_ENV_FILE || join(ROOT, 'data', 'aios.env');
  try {
    for (const raw of readFileSync(envFile, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* no local env file — use built-in defaults */ }
})();

// Single source of truth for the release version: package.json. Everything else (the /api/version
// endpoint, /healthz, /api/state, the bottom-left new-version toast) derives from this at runtime —
// nothing else hardcodes the version. `bin/version` (run by `bin/deploy`) is the ONLY thing that
// edits it. Read once at boot; never let a bad/missing package.json crash the daemon (resilience).
export const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || 'dev'; }
  catch { return 'dev'; }
})();

export const PORT = Number(process.env.AIOS_PORT || 8793);
export const HOST = process.env.AIOS_HOST || '127.0.0.1';

export const DATA_DIR = process.env.AIOS_DATA || join(ROOT, 'data');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const DB_PATH = join(DATA_DIR, 'aios.db');
export const WEB_DIR = join(ROOT, 'web');

// Absolute tmux path (Supercalm may run under launchd with a minimal PATH).
export const TMUX = process.env.AIOS_TMUX || '/opt/homebrew/bin/tmux';
// ffmpeg normalizes browser audio (webm/mp4) into WAV that Spark's libsndfile accepts.
export const FFMPEG = process.env.AIOS_FFMPEG || '/opt/homebrew/bin/ffmpeg';
// Prepended to the tool launch line inside tmux so claude/codex/agy resolve
// regardless of the login shell's rc. $HOME is expanded by the pane shell.
export const TOOL_PATH = process.env.AIOS_TOOL_PATH || '/opt/homebrew/bin:$HOME/.local/bin';

// URL the CLI hooks use to reach Supercalm (loopback on host).
export const SELF_URL = process.env.AIOS_SELF_URL || `http://127.0.0.1:${PORT}`;

// Optional Spark dictation/TTS device (voice features). MagicDNS often doesn't resolve on the server, so
// we connect by IP and override SNI + Host so the device's Tailscale-Serve TLS cert + vhost routing match.
// Set SPARK_IP + SPARK_HOST (in data/aios.env or the environment) to your device; unset = voice disabled.
export const SPARK = {
  ip: process.env.SPARK_IP || '',
  host: process.env.SPARK_HOST || '',
  port: Number(process.env.SPARK_PORT || 443),
};

// Per-session launch defaults (overridable in the New-Session UI / API).
export const DEFAULT_AUTONOMY = process.env.AIOS_AUTONOMY || 'full'; // ask | auto | full
export const AUTONOMY_LEVELS = ['ask', 'auto', 'full'];

// Per-session "orchestration" (claude only). ultracode/workflow are NOT claude CLI flags — they're
// keyword/standing-mode behaviors of the agent harness. We apply them with the real, confirmed
// `--append-system-prompt` flag (survives resume since it's rebuilt from the stored row, like
// --effort/--model) and, on first launch, also seed the literal "ultracode" keyword into the task.
export const ORCHESTRATION_LEVELS = ['off', 'workflow', 'ultracode'];
const DEFAULT_CODEX_MODEL = process.env.AIOS_CODEX_MODEL || 'gpt-5.5';
const ORCH_PROMPT = {
  workflow:
    'Orchestration preference: when a task genuinely benefits from multi-agent work — broad search/fan-out, parallel review across dimensions, a large migration, or independent/adversarial verification — author and run a dynamic workflow (spawn subagents) instead of doing everything in one context. For simple or conversational turns, just work directly.',
  ultracode:
    'Ultracode mode (standing): default to authoring and running a multi-agent workflow for every substantial task — fan out subagents for breadth, and adversarially verify findings before committing to them. Be maximally thorough and exhaustive; token cost is not a constraint. Work solo only on trivial or conversational turns.',
};

// Tools Supercalm can launch. `argv(task, {effort, autonomy, model, resume})` returns the raw argv
// (no shell quoting); sessions.js shell-quotes + prefixes env when sending into tmux.
// Effort levels + default are per-tool (claude tops out at "max", codex at "xhigh").
// resume=true continues the tool's most recent conversation in the project dir.
// claude SESSION auth is resolved per-launch in authmode.js (auto-detect): external proxy
// fleet if reachable, else Supercalm's own dashboard login via the local shim, else the CLI's own
// ~/.claude login — one auth to manage, no ~8h token-expiry surprises, portable across machines
// with or without the proxy. AIOS_CLAUDE_BASE_URL pins a URL; '' forces the CLI login.

export const TOOLS = {
  claude: {
    label: 'Claude Code',
    color: '#d08770',
    model: process.env.AIOS_CLAUDE_MODEL || 'opus',
    modelLabel: 'Opus 4.8',
    // getter: the catalog is live (model_scan.js rescans the proxy fleet), so each
    // /api/state read sees newly-discovered models without a restart
    get models() { return toolModels('claude'); },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'max',
    orchestrations: ORCHESTRATION_LEVELS, // off | workflow | ultracode
    defaultOrchestration: 'off',
    // live (no-restart) setters; anything not here is applied by relaunch-continuing-conversation
    live: { effort: (v) => `/effort ${v}` },
    argv: (task, { effort, autonomy, model, resume, orchestration, settingsPath, appendPrompt, mcpConfigPath } = {}) => {
      const a = ['claude'];
      if (resume) a.push('--continue');
      if (model) a.push('--model', model);
      if (effort && (!model || isNativeModel('claude', model))) a.push('--effort', effort);
      if (autonomy === 'full') a.push('--dangerously-skip-permissions');
      else if (autonomy === 'auto') a.push('--permission-mode', 'acceptEdits');
      // Supercalm-managed hooks (lifecycle + optional git-guardrails), scoped to this launch only. Caller
      // passes a path only when the flag + preconditions are satisfied (else launch is unchanged).
      if (settingsPath) a.push('--settings', settingsPath);
      // ONE --append-system-prompt combining orchestration directive + project context (avoids
      // multiple-flag ambiguity). appendPrompt is the data-wrapped CONTEXT block, gated by contextInject.
      const sys = [orchestration && ORCH_PROMPT[orchestration], appendPrompt].filter(Boolean).join('\n\n');
      if (sys) a.push('--append-system-prompt', sys);
      // seed the literal keyword on a fresh launch (the harness's recognized trigger; resume has no task)
      if (task && !resume && orchestration === 'ultracode') task = 'ultracode\n\n' + task;
      if (task) a.push(task);
      // --mcp-config is VARIADIC (`<configs...>`): keep it LAST so it consumes only its own value and
      // never swallows the trailing task positional (else claude treats the task as a 2nd config file).
      if (mcpConfigPath) a.push('--mcp-config', mcpConfigPath);
      return a;
    },
  },
  codex: {
    label: 'Codex',
    color: '#88c0d0',
    model: DEFAULT_CODEX_MODEL,
    modelLabel: 'gpt-5.5',
    get models() { return toolModels('codex'); },
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'xhigh',
    orchestrations: [], // ultracode/workflow are claude-only -> no-op for codex
    defaultOrchestration: null,
    fastMode: true,
    live: { fast_mode: () => '/fast' }, // Codex exposes fast inference as an interactive slash toggle.
    env: ({ model, viaProxy } = {}) => toolEnv('codex', model, viaProxy),
    argv: (task, { effort, autonomy, model, resume, resumeId, fastMode, notifyArg, appendPrompt, mcpUrl, viaProxy } = {}) => {
      const a = resume ? ['codex', 'resume', resumeId || '--last'] : ['codex'];
      // viaProxy forces the proxy bridge even for native gpt-5.x (then an explicit model is required so the
      // bridge knows what to route). Foreign models bridge regardless.
      const m = model || (viaProxy ? DEFAULT_CODEX_MODEL : null);
      if (m) a.push(...codexProviderArgs(m, viaProxy));
      if (m) a.push('-c', `model=${m}`);
      if (effort) a.push('-c', `model_reasoning_effort=${effort}`);
      if (fastMode && modelSupportsFast(model || DEFAULT_CODEX_MODEL)) a.push('-c', 'service_tier=fast');
      // Supercalm notify program (turn-complete reporting), scoped to this launch. Gated + precondition-checked
      // by the caller (codexNotify flag); null when not ready, leaving the launch unchanged.
      if (notifyArg) a.push('-c', notifyArg);
      // Supercalm wiki MCP server (read-only project knowledge) as a streamable-HTTP MCP server.
      if (mcpUrl) a.push('-c', `mcp_servers.aios_wiki.url="${mcpUrl}"`);
      if (resume) {
        // the resume subcommand takes autonomy via -c overrides (the launch flags differ there)
        if (autonomy === 'full') a.push('-c', 'approval_policy=never', '-c', 'sandbox_mode=danger-full-access');
        else if (autonomy === 'auto') a.push('-c', 'approval_policy=never', '-c', 'sandbox_mode=workspace-write');
      } else {
        if (autonomy === 'full') a.push('--dangerously-bypass-approvals-and-sandbox');
        else if (autonomy === 'auto') a.push('-a', 'never', '-s', 'workspace-write');
      }
      // codex has no --append-system-prompt; on a fresh launch, prefix the data-wrapped project context
      // to the task as a clearly-delimited preamble (resume has no task to prefix).
      if (appendPrompt && task && !resume) task = `${appendPrompt}\n\n---\n\n${task}`;
      if (task) a.push(task);
      return a;
    },
  },
  agy: {
    label: 'Antigravity',
    color: '#b48ead',
    model: process.env.AIOS_AGY_MODEL || 'gemini-pro-agent',
    modelLabel: 'Gemini 3.1 Pro (High)',
    get models() { return toolModels('agy'); },
    efforts: [], // agy exposes no effort flag
    defaultEffort: null,
    orchestrations: [], // claude-only -> no-op for agy
    defaultOrchestration: null,
    live: {},
    argv: (task, { autonomy, model, resume } = {}) => {
      const a = ['agy'];
      if (resume) a.push('--continue');
      if (model) a.push('--model', model);
      if (autonomy === 'full' || autonomy === 'auto') a.push('--dangerously-skip-permissions');
      if (task) a.push('-i', task); // -i = prompt-interactive
      return a;
    },
  },
};

export const TOOL_IDS = Object.keys(TOOLS);
