// Feature flags for launch-path features that could affect the live fleet. EVERYTHING here defaults
// to OFF, so with no config the launch line is byte-identical to before (truly "default-inert").
//
// Two layers, in priority order:
//   1. Environment variable (HARD override / kill-switch): if set to "1"/"true" or "0"/"false" it
//      forces the value regardless of the file. Set these in the launchd plist to lock a feature.
//   2. data/feature_flags.json (live, hot-reloaded by mtime): toggled at runtime via POST /api/flags
//      (or by hand). The persistent, no-restart switch.
// Absent from both -> false.
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = join(DATA_DIR, 'feature_flags.json');

// flag key -> { env: ENV_VAR, desc }
// These are the BUILT-IN infrastructure flags (#1 hooks). The per-project "helpers" (#2 context, #3
// preflight, #4 wiki) are NOT here — they're toggled per-project in the agent panel (project_helpers.js),
// with their AIOS_CONTEXT_INJECT / AIOS_PREFLIGHT_GRILL / AIOS_WIKI env vars surviving only as emergency
// kill-switches read directly by helperEnabled().
export const FLAG_DEFS = {
  claudeHooks: { env: 'AIOS_CLAUDE_HOOKS', desc: 'Inject claude lifecycle hooks (instant working/waiting) via --settings' },
  gitGuardrails: { env: 'AIOS_GIT_GUARDRAILS', desc: 'Block irreversible git via a claude PreToolUse hook' },
  codexNotify: { env: 'AIOS_CODEX_NOTIFY', desc: 'Inject codex notify program for turn-complete reporting' },
};
export const FLAG_KEYS = Object.keys(FLAG_DEFS);

let _cache = {};
let _mtime = -1;
function readFile() {
  try {
    const st = statSync(FILE);
    if (st.mtimeMs === _mtime) return _cache;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    _cache = j && typeof j === 'object' ? j : {};
    _mtime = st.mtimeMs;
  } catch {
    _cache = {};
    _mtime = -1;
  }
  return _cache;
}

function envVal(key) {
  const v = process.env[FLAG_DEFS[key].env];
  if (v == null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return undefined;
}

// Current effective flags (env override wins, else file, else false).
export function flags() {
  const file = readFile();
  const out = {};
  for (const k of FLAG_KEYS) {
    const e = envVal(k);
    out[k] = e !== undefined ? e : file[k] === true;
  }
  return out;
}

export function flagOn(key) {
  return flags()[key] === true;
}

// Persist a patch to the file. Note: an env override still wins on read (it's a hard kill-switch),
// so the returned effective flags may differ from what was written.
export function setFlags(patch) {
  const file = { ...readFile() };
  for (const k of FLAG_KEYS) if (k in patch) file[k] = patch[k] === true;
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
  writeFileSync(FILE, JSON.stringify(file, null, 2) + '\n');
  _cache = file;
  try { _mtime = statSync(FILE).mtimeMs; } catch { _mtime = -1; }
  return flags();
}

// For visibility: which keys are locked by an env override (cannot be toggled via the API).
export function flagLocks() {
  const out = {};
  for (const k of FLAG_KEYS) out[k] = envVal(k) !== undefined;
  return out;
}
