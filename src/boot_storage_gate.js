// Boot gate for a data directory that is an alias into live remote storage.
//
// After a macOS reboot the launchd agent starts the server at login, usually BEFORE the storage
// watcher has reconnected the share and attached its image (a post-crash APFS consistency scan over
// the network takes minutes). `mkdir` through the dangling alias then threw ENOENT and launchd
// respawned the server every few seconds, forever, filling the log. Storage that is merely late is
// not a boot failure: wait for it. This never creates a local fallback and never touches the alias.
import { lstatSync, statSync } from 'node:fs';

// true only for a symlink whose target cannot currently be reached.
export function danglingAlias(path) {
  let link;
  try { link = lstatSync(path); } catch { return false; }
  if (!link.isSymbolicLink()) return false;
  try { statSync(path); return false; } catch { return true; }
}

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Synchronous on purpose: module evaluation must not proceed to open the database or recover
// sessions against half-present storage. Returns the milliseconds spent waiting (0 = no wait).
export function waitForStorageAlias(path, { pollMs = 2000, remindMs = 60000, sleep = pause, log = console.error, clock = Date.now } = {}) {
  if (!danglingAlias(path)) return 0;
  const started = clock();
  let reminded = started;
  log(`[aios] waiting for live storage: ${path} is an alias into storage that is not mounted yet`);
  while (danglingAlias(path)) {
    sleep(pollMs);
    if (clock() - reminded >= remindMs) {
      reminded = clock();
      log(`[aios] still waiting for live storage after ${Math.round((reminded - started) / 1000)}s: ${path}`);
    }
  }
  const waited = clock() - started;
  log(`[aios] live storage available after ${Math.round(waited / 1000)}s; continuing boot`);
  return waited;
}
