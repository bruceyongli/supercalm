import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep, basename } from 'node:path';

// Worktree DB safety: a server booted from a LINKED git worktree must not open the CANONICAL live
// database (the main checkout's data/ — an ~11GB WAL; two writers = contention/corruption). Anything
// else is fine: the worktree's own data/, an OS tmpdir (tests, scratch instances), any explicit
// scratch AIOS_DATA. The old rule — "refuse everything outside my own checkout" — false-positived on
// exactly those legitimate scratch dirs, which silently bricked the integrate gate: the gate runs
// `npm test` from a linked worktree, and test/project_graph.test.js boots store.js with a tmpdir
// AIOS_DATA, so EVERY integration was REJECTED at the tests check regardless of content.

// realpath the LONGEST existing prefix + re-append the (maybe not-yet-created) tail, so a fresh DB
// path and the canonical dir are compared through the SAME symlink resolution (macOS /var → /private/var).
export function realish(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur) && dirname(cur) !== cur) { tail.unshift(basename(cur)); cur = dirname(cur); }
  try { return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur); } catch { return resolve(p); }
}

// gitMarkerContent = the linked worktree's `.git` FILE ("gitdir: <mainRoot>/.git/worktrees/<name>").
// Refuse ONLY when dbPath sits inside the main checkout's data/. Unresolvable/malformed input fails
// OPEN ({refuse:false}), matching the caller's fail-safe catch — a false refusal bricks legitimate
// scratch instances and the deploy gate, which is the worse failure than a skipped check.
export function worktreeDbVerdict({ gitMarkerContent, dbPath, repoRoot }) {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(String(gitMarkerContent || ''));
  if (!m) return { refuse: false, canonicalData: null };
  const gitdir = resolve(String(repoRoot || '.'), m[1]); // a relative gitdir resolves against the worktree
  const worktreesDir = dirname(gitdir); // <mainRoot>/.git/worktrees
  if (basename(worktreesDir) !== 'worktrees' || basename(dirname(worktreesDir)) !== '.git') {
    return { refuse: false, canonicalData: null };
  }
  const canonicalData = realish(join(dirname(dirname(worktreesDir)), 'data'));
  const dbReal = realish(dbPath);
  return { refuse: dbReal === canonicalData || dbReal.startsWith(canonicalData + sep), canonicalData };
}
