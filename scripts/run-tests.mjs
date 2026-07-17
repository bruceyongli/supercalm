#!/usr/bin/env node
// Sequential glob test runner — `npm test` runs every test/*.test.js without the package.json
// mega-chain. The && chain was a cross-session rebase-conflict magnet: EVERY session that added a
// test edited the same line and collided with every other session's edit (hit twice on 2026-07-16
// alone). Adding a test is now just adding a file; per-suite `npm run test:<name>` scripts remain
// for targeted runs. Fail-fast like the chain it replaces; each file runs in its own process with
// its own scratch AIOS_DATA (the repo's test convention), so order independence holds — files run
// alphabetically.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join('test', f));

if (!files.length) { console.error('run-tests: no test files found'); process.exit(1); }

const t0 = Date.now();
let n = 0;
for (const f of files) {
  n++;
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nrun-tests: FAIL at ${f} (${n}/${files.length}, exit ${r.status ?? 'signal ' + r.signal})`);
    process.exit(r.status || 1);
  }
}
console.log(`\nrun-tests: ${files.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
