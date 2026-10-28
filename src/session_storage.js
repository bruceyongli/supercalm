import { mkdir, readdir, rm, rmdir, lstat } from 'node:fs/promises';
import { join, sep, dirname, basename } from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import { sessionHasProtectedJobs } from './scratch_jobs.js';
import { assertLiveStorage, liveStorageConfig, storageMigrationProtected } from './live_storage.js';
import { cleanupProvisionedSessionRoot, provisionLiveStorageRoot } from './storage_provision.js';

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
  // Only absent per-session roots follow the selected storage default. Existing
  // directories and whole-root migration aliases keep their registered location.
  // Check before even creating the parents: a missing whole-root migration alias
  // must never become a new local directory that hides the remote files.
  await Promise.all([assertLiveStorage(STORAGE_ROOT), assertLiveStorage(ARTIFACT_ROOT),
    assertLiveStorage(paths.root), assertLiveStorage(paths.artifacts)]);
  await Promise.all([mkdir(STORAGE_ROOT, { recursive: true }), mkdir(ARTIFACT_ROOT, { recursive: true })]);
  await provisionLiveStorageRoot(paths.root, 'session');
  await provisionLiveStorageRoot(paths.artifacts, 'artifacts');
  await Promise.all([assertLiveStorage(paths.tmp), assertLiveStorage(paths.artifacts)]);
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
    AIOS_SCRATCH_RUN: join(ROOT, 'bin', 'scratch-run.mjs'),
    AIOS_BUILD_RUN: join(ROOT, 'bin', 'build-run.mjs'),
    // Standard names cover Node, Python, shell utilities, browsers, and most test harnesses.
    // TMPDIR conventionally carries a trailing separator on macOS.
    TMPDIR: paths.tmp + sep,
    TMP: paths.tmp,
    TEMP: paths.tmp,
  };
}

export async function cleanupSessionStorage(sessionId) {
  const paths = sessionStoragePaths(sessionId);
  if (storageMigrationProtected(paths.root) || storageMigrationProtected(paths.artifacts)) return { removed: false, reason: 'storage-migration' };
  if (await sessionHasProtectedJobs(sessionId)) return { removed: false, reason: 'protected-scratch-jobs' };
  const remote = await cleanupProvisionedSessionRoot(paths.root);
  if (remote && !remote.removed) return remote;
  if (!remote) await rm(paths.root, { recursive: true, force: true, maxRetries: 2 });
  // Durable artifacts stay with the session, but do not accumulate one empty directory per launch.
  try { if (!(await lstat(paths.artifacts)).isSymbolicLink()) await rmdir(paths.artifacts); }
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
  const remote = (liveStorageConfig()?.mappings || []).filter(m => m.provisionedKind === 'session' && dirname(m.source) === STORAGE_ROOT);
  const registered = new Set(remote.map(m => basename(m.source)));
  const candidates = new Set(entries.filter(e => e.isDirectory() || e.isSymbolicLink() && registered.has(e.name)).map(e => e.name));
  // Finish an interrupted owned cleanup even if its last alias was already removed.
  for (const entry of remote) if (entry.disposableCleanup) candidates.add(basename(entry.source));
  for (const name of candidates) {
    if (!SESSION_ID_RX.test(name) || live.has(name)) continue;
    const result = await cleanupSessionStorage(name);
    if (result.removed) removed.push(name);
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
