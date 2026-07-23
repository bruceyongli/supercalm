#!/usr/bin/env node
// Isolated glob test runner — `npm test` runs every test/*.test.js without the package.json
// mega-chain. The && chain was a cross-session rebase-conflict magnet: EVERY session that added a
// test edited the same line and collided with every other session's edit (hit twice on 2026-07-16
// alone). Adding a test is now just adding a file. Each suite remains its own process with scratch
// AIOS_DATA; a small worker pool removes the old ~4 minute serialization cost. Output is buffered per
// suite so parallel children cannot interleave unreadably, and every completion reports its duration.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join('test', f));

if (!files.length) { console.error('run-tests: no test files found'); process.exit(1); }

const t0 = Date.now();
const requestedJobs = Number(process.env.AIOS_TEST_JOBS || Math.min(4, availableParallelism()));
const jobs = Math.max(1, Math.min(files.length, Number.isFinite(requestedJobs) ? Math.floor(requestedJobs) : 1));
const active = new Set();
let next = 0;
let completed = 0;
let failed = null;

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Every child gets a private default data root even when an older test forgot to set AIOS_DATA.
    // This makes parallel execution incapable of opening the operator's live SQLite database.
    const dataDir = mkdtempSync(join(tmpdir(), 'aios-test-data-'));
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      env: { ...process.env, AIOS_DATA: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    active.add(child);
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      stderr.push(Buffer.from(String(error?.stack || error)));
    });
    child.on('close', (code, signal) => {
      active.delete(child);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
      resolve({
        file,
        code,
        signal,
        ms: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function worker() {
  while (!failed) {
    const index = next++;
    if (index >= files.length) return;
    const result = await run(files[index]);
    completed++;
    if (failed && result.code === 0) return;
    if (result.code !== 0) {
      if (!failed) {
        failed = result;
        for (const child of active) child.kill('SIGTERM');
      }
      return;
    }
    console.log(`PASS ${result.file} ${result.ms}ms (${completed}/${files.length})`);
  }
}

await Promise.all(Array.from({ length: jobs }, () => worker()));
if (failed) {
  if (failed.stdout) process.stdout.write(failed.stdout);
  if (failed.stderr) process.stderr.write(failed.stderr);
  console.error(`\nrun-tests: FAIL at ${failed.file} (${completed}/${files.length}, exit ${failed.code ?? 'signal ' + failed.signal}, ${failed.ms}ms)`);
  process.exit(failed.code || 1);
}
console.log(`\nrun-tests: ${files.length} suites passed with ${jobs} worker(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
