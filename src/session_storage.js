import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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

function regexQuote(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function homeCreationGuardProfile(home = homedir()) {
  const resolvedHome = resolve(home);
  const canonicalHome = existsSync(resolvedHome) ? realpathSync(resolvedHome) : resolvedHome;
  // Block only NEW direct children of home. Existing configuration and every nested project remain
  // writable; ad-hoc ~/qa-*, ~/tmp-* and similar pollution cannot be created by the agent process.
  return `(version 1)\n(allow default)\n(deny file-write-create (regex #"^${regexQuote(canonicalHome)}/[^/]+$"))`;
}

export function guardAgentArgv(argv, {
  platform = process.platform,
  executable = '/usr/bin/sandbox-exec',
  enabled = process.env.AIOS_SESSION_HOME_GUARD !== '0',
  home = homedir(),
} = {}) {
  if (!enabled || platform !== 'darwin' || !existsSync(executable)) return [...argv];
  return [executable, '-p', homeCreationGuardProfile(home), ...argv];
}
