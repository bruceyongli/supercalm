import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, lstat, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'aios-scratch-jobs-')));
process.env.AIOS_DATA = join(fixture, 'data');
process.env.AIOS_SESSION_ID = 's_jobs';
const { scratchJobs, cleanScratchJob, sessionHasProtectedJobs } = await import('../src/scratch_jobs.js');
const { prepareSessionStorage, cleanupSessionStorage } = await import('../src/session_storage.js');
const exec = promisify(execFile);
const paths = await prepareSessionStorage('s_jobs');
const run = code => exec(process.execPath, ['bin/scratch-run.mjs', '--', process.execPath, '-e', code],
  { env: process.env, timeout: 30_000, maxBuffer: 1024 * 1024 });
const produce = `const fs=require('fs');fs.writeFileSync(process.env.AIOS_JOB_TMPDIR+'/generated.txt','temporary');`;
try {
  await writeFile(join(paths.tmp, 'legacy-work.txt'), 'unmanaged existing work is never adopted or deleted');
  await writeFile(join(paths.artifacts, 'report.txt'), 'durable');
  await run(produce);
  assert.equal((await scratchJobs()).length, 0, 'success cleans its owned job without waiting for session exit');
  assert.equal(await readFile(join(paths.tmp, 'legacy-work.txt'), 'utf8'), 'unmanaged existing work is never adopted or deleted');
  await assert.rejects(() => run(produce + 'process.exit(9)'), /Command failed/);
  const [failed] = await scratchJobs();
  assert.equal(failed.exitCode, 9);
  assert.equal(await sessionHasProtectedJobs('s_jobs'), true);
  assert.equal((await cleanupSessionStorage('s_jobs')).removed, false, 'whole-session cleanup cannot bypass job retention');
  assert.equal((await cleanScratchJob(failed)).retained, 'failure-evidence');
  assert.equal((await cleanScratchJob(failed, { now: failed.expiresAt + 1, alive: () => true })).retained, 'active-process');
  assert.equal((await cleanScratchJob(failed, { now: failed.expiresAt + 1, unused: async () => false })).retained, 'open-files-or-unknown');
  await assert.rejects(() => cleanScratchJob({ ...failed, path: fixture }), /path changed/);
  assert.equal((await cleanScratchJob(failed, { now: failed.expiresAt + 1 })).removed, true);
  await assert.rejects(() => lstat(failed.path), { code: 'ENOENT' });
  assert.equal(await readFile(join(paths.artifacts, 'report.txt'), 'utf8'), 'durable');
  // A command that leaves a child process must not lose its working files.
  await run(produce + `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}).unref();`);
  const [background] = await scratchJobs();
  assert.equal((await cleanScratchJob(background)).retained, 'active-process');
  process.kill(-background.pid, 'SIGTERM'); // This test's own isolated process group only.
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await cleanScratchJob(background)).removed) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await scratchJobs()).length, 0);
  console.log('scratch_jobs.test ok: automatic completion cleanup, failed-job retention, live workers, unknown probes, session isolation');
} finally {
  for (const job of await scratchJobs().catch(() => [])) {
    try { if (job.sessionId === 's_jobs') process.kill(-job.pid, 'SIGTERM'); } catch {}
  }
  await rm(fixture, { recursive: true, force: true });
}
