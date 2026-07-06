// Builds the Supercalm-managed claude settings file (hooks only) passed via `claude --settings`, and the
// codex `-c notify=...` value. Everything here is gated by feature flags + preconditions in the caller;
// if a precondition fails we return null and the caller launches WITHOUT the flag (fail-safe).
import { writeFileSync, readFileSync, mkdirSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // repo root (this file is src/hookcfg.js)
export const CLAUDE_HOOK_SCRIPT = join(ROOT, 'scripts', 'aios-claude-hook.sh');
export const GIT_GUARDRAIL_SCRIPT = join(ROOT, 'scripts', 'aios-git-guardrail.sh');
export const CODEX_NOTIFY_SCRIPT = join(ROOT, 'scripts', 'aios-codex-notify.sh');
const CLAUDE_DIR = join(DATA_DIR, 'claude');

function xok(f) { try { accessSync(f, constants.X_OK); return true; } catch { return false; } }

// `claude --settings` support is cached (one --help probe). If claude is missing or too old, we never
// add the flag.
let _settingsSupported = null;
export function claudeSupportsSettings() {
  if (_settingsSupported !== null) return _settingsSupported;
  try {
    const out = execFileSync('claude', ['--help'], { encoding: 'utf8', timeout: 8000 });
    _settingsSupported = /--settings\b/.test(out);
  } catch { _settingsSupported = false; }
  return _settingsSupported;
}

function lifecycleGroup() {
  return [{ hooks: [{ type: 'command', command: CLAUDE_HOOK_SCRIPT }] }];
}

function writeSettings(name, obj) {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const p = join(CLAUDE_DIR, name);
  const body = JSON.stringify(obj, null, 2) + '\n';
  let cur = '';
  try { cur = readFileSync(p, 'utf8'); } catch { /* missing */ }
  if (cur !== body) writeFileSync(p, body);
  return p;
}

// Absolute path to pass to `claude --settings`, or null if preconditions aren't met. The file defines
// ONLY a `hooks` block so claude's per-key settings merge keeps the user's permissions/model/etc.
// (verified by the merge-semantics test before fleet enablement).
export function claudeSettingsPath({ guardrails = false } = {}) {
  if (!xok(CLAUDE_HOOK_SCRIPT)) return null;
  if (guardrails && !xok(GIT_GUARDRAIL_SCRIPT)) return null;
  if (!claudeSupportsSettings()) return null;
  const g = lifecycleGroup();
  const hooks = { UserPromptSubmit: g, Stop: g, Notification: g };
  if (guardrails) {
    hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: GIT_GUARDRAIL_SCRIPT }] }];
  }
  return writeSettings(guardrails ? 'aios-hooks-guard.settings.json' : 'aios-hooks.settings.json', { hooks });
}

// codex `-c notify=[...]` value (a TOML array literal), or null if the script isn't runnable.
export function codexNotifyArg() {
  if (!xok(CODEX_NOTIFY_SCRIPT)) return null;
  return `notify=["${CODEX_NOTIFY_SCRIPT}"]`;
}
