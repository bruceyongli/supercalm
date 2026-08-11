import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { DATA_DIR } from './config.js';

const STORAGE_ROOT = join(DATA_DIR, 'session-storage');
const ARTIFACT_ROOT = join(DATA_DIR, 'session-artifacts');
const SESSION_ID_RX = /^s_[a-zA-Z0-9_-]+$/;

function checkedSessionId(sessionId) {
  const value = String(sessionId || '');
  if (!SESSION_ID_RX.test(value)) throw new Error('invalid session id for managed storage');
  return value;
}

export function sessionStoragePaths(sessionId) {
  const id = checkedSessionId(sessionId);
  const root = join(STORAGE_ROOT, id);
  return {
    root,
    tmp: join(root, 'tmp'),
    artifacts: join(ARTIFACT_ROOT, id),
  };
}

export async function prepareSessionStorage(sessionId) {
  const paths = sessionStoragePaths(sessionId);
  await Promise.all([
    mkdir(paths.tmp, { recursive: true, mode: 0o700 }),
    mkdir(paths.artifacts, { recursive: true, mode: 0o700 }),
  ]);
  return paths;
}

export function sessionStorageEnv(sessionId) {
  const paths = sessionStoragePaths(sessionId);
  return {
    AIOS_SESSION_STORAGE: paths.root,
    AIOS_SESSION_TMPDIR: paths.tmp,
    AIOS_SESSION_ARTIFACTS: paths.artifacts,
    // Standard names cover Node, Python, shell utilities, browsers, and most test harnesses.
    // TMPDIR conventionally carries a trailing separator on macOS.
    TMPDIR: paths.tmp + sep,
    TMP: paths.tmp,
    TEMP: paths.tmp,
  };
}

export async function cleanupSessionStorage(sessionId) {
  const paths = sessionStoragePaths(sessionId);
  await rm(paths.root, { recursive: true, force: true, maxRetries: 2 });
  // Durable artifacts stay with the session, but do not accumulate one empty directory per launch.
  try { await rmdir(paths.artifacts); }
  catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
  }
  return { removed: true, path: paths.root };
}

export async function sweepSessionStorage(liveSessionIds = []) {
  const live = new Set([...liveSessionIds].map(String));
  const removed = [];
  let entries = [];
  try { entries = await readdir(STORAGE_ROOT, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return removed;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_RX.test(entry.name) || live.has(entry.name)) continue;
    await cleanupSessionStorage(entry.name);
    removed.push(entry.name);
  }
  return removed;
}

// NO exec-level sandbox wrapper lives here anymore — learned the hard way (2026-08-11 fleet
// outage). Launches were once wrapped in a seatbelt profile denying new direct children of $HOME.
// macOS seatbelt does not nest: codex in workspace-write applies its OWN profile and died on every
// command with `sandbox_apply: Operation not permitted`, and claude broke on home-root config
// writes (~/.claude.json temp/lock files are new direct children of $HOME). The home-root boundary
// is now policy, not enforcement: the dedicated TMPDIR env above, the hygiene prompt injected at
// launch, and the sweeps below. If enforcement ever returns, it must use each tool's OWN sandbox
// configuration — the launch argv must always reach the tool binary unwrapped.
