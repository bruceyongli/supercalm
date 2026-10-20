// Opt-in job ownership: clean a completed build/test, not an entire live session.
import { mkdir, readFile, readdir, writeFile, rename, rm, lstat, realpath, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { assertDiskHeadroom } from './disk_pressure.js';

const exec = promisify(execFile);
const recordsRoot = join(DATA_DIR, 'scratch-jobs');
const JOB = /^j_[a-f0-9-]{36}$/;
const SID = /^s_[a-zA-Z0-9_-]+$/;
const failureRetention = 24 * 60 * 60_000;
function jobPath(sessionId, id) {
  if (!SID.test(sessionId || '') || !JOB.test(id || '')) throw new Error('Invalid scratch job ownership');
  return join(DATA_DIR, 'session-storage', sessionId, 'tmp', 'jobs', id);
}
function processExists(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid < 2) return true; // missing/uncertain identity is protected
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function writeJob(job) {
  const file = join(recordsRoot, `${job.id}.json`), tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(job), { mode: 0o600 });
  await rename(tmp, file);
}
export async function scratchJobs() {
  const entries = await readdir(recordsRoot).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const jobs = [];
  for (const name of entries.filter(n => JOB.test(n.slice(0, -5)) && n.endsWith('.json'))) {
    const job = JSON.parse(await readFile(join(recordsRoot, name), 'utf8'));
    if (name !== `${job.id}.json`) throw new Error('Scratch job identity does not match its record');
    if (job.path !== jobPath(job.sessionId, job.id)) throw new Error('Scratch job path does not match ownership');
    jobs.push(job);
  }
  return jobs;
}
export async function pathIsUnused(path) {
  try { await exec('lsof', ['-nP', '+D', path], { timeout: 10_000, maxBuffer: 256 * 1024 }); return false; }
  catch (error) { return error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim(); }
}
export async function cleanScratchJob(job, options = {}) {
  jobPath(job.sessionId, job.id);
  const lock = join(recordsRoot, `${job.id}.lock`);
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') return { retained: 'cleanup-in-progress' };
    throw error;
  }
  try { return await cleanOwnedJob(job, options); } finally { await rmdir(lock); }
}
async function cleanOwnedJob(job, { now = Date.now(), alive = processExists, unused = pathIsUnused } = {}) {
  const expected = jobPath(job.sessionId, job.id);
  if (expected !== job.path) throw new Error('Scratch job path changed');
  if (alive(job.pid, true) || (!job.finishedAt && alive(job.ownerPid))) return { retained: 'active-process' };
  if (!job.finishedAt) {
    // A crashed wrapper is not proof of successful work. Preserve it for a day, just like failure.
    await writeJob({ ...job, finishedAt: now, expiresAt: now + failureRetention, exitCode: null });
    return { retained: 'interrupted-job' };
  }
  if (!Number.isFinite(job.expiresAt)) return { retained: 'unknown-retention' };
  if (now < job.expiresAt) return { retained: 'failure-evidence' };
  const info = await lstat(expected).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (info) {
    if (!info.isDirectory() || await realpath(expected) !== expected) return { retained: 'path-changed' };
    if (!await unused(expected)) return { retained: 'open-files-or-unknown' };
    await rm(expected, { recursive: true, force: false });
  }
  await unlink(join(recordsRoot, `${job.id}.json`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  return { removed: true, id: job.id };
}
let sweeping = false;
export async function sweepScratchJobs() {
  if (sweeping) return [];
  sweeping = true;
  try {
    const result = [];
    // Serial, bounded cleanup outside all session polling/status paths.
    const candidates = (await scratchJobs()).filter(job => !processExists(job.pid, true)
      && (job.finishedAt || !processExists(job.ownerPid)));
    for (const job of candidates.sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, 20)) {
      const outcome = await cleanScratchJob(job);
      if (outcome.removed) result.push(outcome);
      else if (!['interrupted-job', 'cleanup-in-progress'].includes(outcome.retained)
        && await lstat(join(recordsRoot, `${job.id}.json`)).catch(() => null)) await writeJob({ ...job, checkedAt: Date.now() });
    }
    return result;
  } finally { sweeping = false; }
}
export async function sessionHasProtectedJobs(sessionId) {
  // Do not let whole-session cleanup bypass a job's liveness or failure-evidence retention.
  return (await scratchJobs()).some(job => job.sessionId === sessionId);
}
export async function runScratchJob(sessionId, command, args = []) {
  if (!command) throw new Error('A command is required');
  assertDiskHeadroom();
  const id = `j_${randomUUID()}`, path = jobPath(sessionId, id);
  await mkdir(recordsRoot, { recursive: true, mode: 0o700 });
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== path) throw new Error('Scratch job directory is redirected');
  let job = { version: 1, id, sessionId, path, ownerPid: process.pid, pid: null, startedAt: Date.now() };
  await writeJob(job);
  const child = spawn(command, args, { detached: true, stdio: 'inherit', env: {
    ...process.env, TMPDIR: path + '/', TMP: path, TEMP: path, AIOS_JOB_TMPDIR: path,
    AIOS_SESSION_TMPDIR: path,
  } });
  // Install error/exit observers immediately: an invalid command must not become an uncaught error.
  const ended = new Promise(resolve => {
    child.on('error', () => resolve({ code: 127 }));
    child.on('exit', (code, signal) => resolve({ code: code ?? 128, signal }));
  });
  job = { ...job, pid: child.pid || process.pid };
  await writeJob(job);
  const forward = signal => { try { process.kill(-child.pid, signal); } catch {} };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const result = await ended;
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  job = { ...job, finishedAt: Date.now(), exitCode: result.code,
    expiresAt: Date.now() + (result.code === 0 ? 0 : failureRetention) };
  await writeJob(job);
  const cleanup = await cleanScratchJob(job);
  process.stderr.write(`[aios] scratch job ${id}: ${cleanup.removed ? 'cleaned' : `retained (${cleanup.retained}) at ${path}`}\n`);
  return result.code;
}
