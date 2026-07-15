import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeDbVerdict } from '../src/db_guard.js';

// Layout: a main checkout with data/, and a linked worktree whose `.git` file points back at it.
const base = await mkdtemp(join(tmpdir(), 'aios-db-guard-'));
const mainRoot = join(base, 'aios');
await mkdir(join(mainRoot, '.git', 'worktrees', 's_x'), { recursive: true });
await mkdir(join(mainRoot, 'data'), { recursive: true });
const wt = join(base, 'worktrees', 's_x');
await mkdir(wt, { recursive: true });
const marker = `gitdir: ${join(mainRoot, '.git', 'worktrees', 's_x')}\n`;

// The canonical live data dir → REFUSE (the db file and anything nested in it).
assert.equal(worktreeDbVerdict({ gitMarkerContent: marker, dbPath: join(mainRoot, 'data', 'aios.db'), repoRoot: wt }).refuse, true);
assert.equal(worktreeDbVerdict({ gitMarkerContent: marker, dbPath: join(mainRoot, 'data', 'nested', 'x.db'), repoRoot: wt }).refuse, true);

// An OS-tmpdir scratch dir → ALLOW. This exact false positive killed the integrate gate's `npm test`
// run (project_graph.test.js boots store.js with a tmpdir AIOS_DATA from the gate's linked worktree).
const scratch = await mkdtemp(join(tmpdir(), 'aios-db-guard-scratch-'));
assert.equal(worktreeDbVerdict({ gitMarkerContent: marker, dbPath: join(scratch, 'aios.db'), repoRoot: wt }).refuse, false);

// A data dir inside the worktree itself → ALLOW.
assert.equal(worktreeDbVerdict({ gitMarkerContent: marker, dbPath: join(wt, 'data', 'aios.db'), repoRoot: wt }).refuse, false);

// Prefix trap: <mainRoot>/data-2 must not string-match <mainRoot>/data.
assert.equal(worktreeDbVerdict({ gitMarkerContent: marker, dbPath: join(mainRoot, 'data-2', 'aios.db'), repoRoot: wt }).refuse, false);

// A relative gitdir resolves against the worktree root.
const rel = 'gitdir: ../../aios/.git/worktrees/s_x\n';
assert.equal(worktreeDbVerdict({ gitMarkerContent: rel, dbPath: join(mainRoot, 'data', 'aios.db'), repoRoot: wt }).refuse, true);
assert.equal(worktreeDbVerdict({ gitMarkerContent: rel, dbPath: join(scratch, 'aios.db'), repoRoot: wt }).refuse, false);

// Malformed marker / non-worktree gitdir shape → fail OPEN (matches store.js's fail-safe catch).
assert.equal(worktreeDbVerdict({ gitMarkerContent: 'garbage', dbPath: join(mainRoot, 'data', 'aios.db'), repoRoot: wt }).refuse, false);
assert.equal(worktreeDbVerdict({ gitMarkerContent: `gitdir: ${join(base, 'elsewhere')}\n`, dbPath: join(mainRoot, 'data', 'aios.db'), repoRoot: wt }).refuse, false);

console.log('db_guard.test ok');
