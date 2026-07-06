import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, ROOT } from './config.js';

const SETTINGS_PATH = process.env.AIOS_AGY_SETTINGS || join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const HOOK_PATH = process.env.AIOS_AGY_STATUSLINE_HOOK || join(ROOT, 'bin', 'agy-statusline');

async function readSettings() {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function ensureAgyStatuslineHook() {
  if (!existsSync(HOOK_PATH)) return { installed: false, reason: 'hook script missing', hook: HOOK_PATH };
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await chmod(HOOK_PATH, 0o755).catch(() => {});
  const settings = await readSettings();
  const current = settings.statusLine?.command || '';
  if (current === HOOK_PATH) return { installed: true, changed: false, hook: HOOK_PATH };
  if (current && !/aios.*agy-statusline|agy-statusline/.test(current)) {
    return { installed: false, reason: 'custom statusLine command already configured', command: current, hook: HOOK_PATH };
  }
  settings.statusLine = { type: 'command', command: HOOK_PATH };
  await mkdir(join(homedir(), '.gemini', 'antigravity-cli'), { recursive: true }).catch(() => {});
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return { installed: true, changed: true, hook: HOOK_PATH };
}

export function agyStatuslineLogPath() {
  return process.env.AIOS_AGY_STATUSLINE_LOG || join(DATA_DIR, 'agy-statusline.jsonl');
}
