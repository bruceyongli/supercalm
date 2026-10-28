// Finite builds run on a local disposable snapshot. Source/history stay where
// they are; only explicit outputs and bounded diagnostics are published back.
import { mkdir, readFile, writeFile, readdir, realpath, lstat, stat, statfs, rename, rm, rmdir, unlink, open, mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { finished } from 'node:stream/promises';
import { DATA_DIR } from './config.js';
import { assertLiveStorage, isManagedStoragePath } from './live_storage.js';
import { withSessionArchiveLock } from './archive_lock.js';
import { buildRelativePath, buildManifest, copyBuildManifest, snapshotBuildSource } from './build_snapshot.js';

const exec = promisify(execFile), GiB = 1024 ** 3;
const SID = /^s_[a-zA-Z0-9_-]+$/, ID = /^b_[a-f0-9-]{36}$/;
const records = join(DATA_DIR, 'local-build-jobs');
const localRoot = resolve(process.env.AIOS_LOCAL_BUILD_ROOT || join(homedir(), '.local/share/aios/local-builds'));
export const localBuildStorageRoot = () => localRoot;
const positive = (v, fallback) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
const maxBytes = positive(process.env.AIOS_BUILD_MAX_BYTES, 30 * GiB);
const reserveBytes = positive(process.env.AIOS_BUILD_RESERVE_BYTES, 50 * GiB);
const LOG_LIMIT = 8 * 1024 * 1024;
const location = id => { if (!ID.test(id || '')) throw Error('Invalid build id'); return join(localRoot, id); };
const recordFile = id => join(records, basename(location(id)) + '.json');
const exists = async path => lstat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
const alive = (pid, group = false) => {
  if (!Number.isSafeInteger(pid) || pid < 2) return true;
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
};
async function processStamp(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try { return (await exec('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000, maxBuffer: 1024 })).stdout.trim() || null; }
  catch { return null; } // Unknown is protected, not proof of an exited owner.
}
async function sameOwner(pid, stamp, group = false) {
  if (!alive(pid, group)) return false;
  const current = await processStamp(pid);
  // A departed leader can still have live children in its group. Conversely,
  // a new process that reused the old PID after reboot is not this job's owner.
  return !stamp || !current || current === stamp;
}
const lease = fn => withSessionArchiveLock('s_local_build_pool', fn);
async function save(job) {
  const path = recordFile(job.id), tmp = path + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(job), { mode: 0o600 });
  await rename(tmp, path);
}
async function capacity(required = 0) {
  const info = await statfs(localRoot), available = Number(info.bavail) * Number(info.bsize);
  if (available - required < reserveBytes) throw Error('Local build stopped: reserved disk headroom would be consumed');
}
async function prepareLocalRoot() {
  if (localRoot === homedir() || localRoot.split('/').filter(Boolean).length < 3) throw Error('Unsafe local build root');
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  if (await realpath(localRoot) !== localRoot || (await stat(localRoot)).dev !== (await stat(homedir())).dev) {
    throw Error('Build scratch must be on the local home disk, not a symlink/network image');
  }
  await mkdir(records, { recursive: true, mode: 0o700 });
}
function validateJob(job) {
  if (job?.version !== 1 || !SID.test(job.sessionId || '') || !ID.test(job.id || '')
      || job.path !== location(job.id) || job.artifacts !== join(DATA_DIR, 'session-artifacts', job.sessionId, 'builds', job.id)
      || typeof job.nonce !== 'string' || !Array.isArray(job.outputs)) throw Error('Invalid local build ownership');
  job.outputs.forEach(buildRelativePath);
  return job;
}
export async function localBuildJobs() {
  const names = await readdir(records).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const jobs = [];
  for (const name of names.filter(n => ID.test(n.slice(0, -5)) && n.endsWith('.json'))) {
    const job = validateJob(JSON.parse(await readFile(join(records, name), 'utf8')));
    if (name !== job.id + '.json') throw Error('Local build record was replaced');
    jobs.push(job);
  }
  return jobs;
}
async function identity(job) {
  validateJob(job);
  const info = await exists(job.path);
  if (!info) return false;
  if (!info.isDirectory() || info.dev !== job.device || info.ino !== job.inode || await realpath(job.path) !== job.path) throw Error('Local build directory identity changed');
  return true;
}
async function unused(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await exec('lsof', ['-nP', '+D', path], { timeout: 10_000, maxBuffer: 256 * 1024 }); }
    catch (e) {
      if (e.code === 1 && !e.stdout?.trim() && !e.stderr?.trim()) return true;
      if (attempt === 2 && !e.stdout?.trim()) process.stderr.write(`[aios] Build handle check unavailable: ${String(e.stderr || e.code).trim().slice(0, 240)}\n`);
    }
    // A just-exited child or log stream can finish closing a little after its
    // exit event. Retry the SAME strict check; never waive a live/unknown handle.
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}
export function buildEnvironment(job, base = process.env) {
  const cache = join(job.path, 'cache'), tmp = join(job.path, 'tmp');
  return { ...base, TMPDIR: tmp + '/', TMP: tmp, TEMP: tmp,
    AIOS_JOB_TMPDIR: tmp, AIOS_SESSION_TMPDIR: tmp, AIOS_BUILD_JOB_ID: job.id,
    AIOS_BUILD_OUTPUT: join(job.path, 'output'), AIOS_BUILD_SOURCE: job.source,
    AIOS_BUILD_RUN: '', // Nested build runners are not independent disk reservations.
    XDG_CACHE_HOME: cache, XDG_DATA_HOME: join(cache, 'data'), XDG_STATE_HOME: join(cache, 'state'),
    npm_config_cache: join(cache, 'npm'), NPM_CONFIG_CACHE: join(cache, 'npm'),
    npm_config_store_dir: join(cache, 'pnpm'), PNPM_CONFIG_STORE_DIR: join(cache, 'pnpm'),
    PNPM_CONFIG_CACHE_DIR: join(cache, 'pnpm-cache'), YARN_CACHE_FOLDER: join(cache, 'yarn'),
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun'), npm_config_devdir: join(cache, 'node-gyp'),
    CCACHE_DIR: join(cache, 'ccache'), SCCACHE_DIR: join(cache, 'sccache'),
    PIP_CACHE_DIR: join(cache, 'pip'), UV_CACHE_DIR: join(cache, 'uv'),
    CARGO_HOME: join(cache, 'cargo'), CARGO_TARGET_DIR: join(job.path, 'output', 'cargo-target'),
    GRADLE_USER_HOME: join(cache, 'gradle'), GOCACHE: join(cache, 'go'), GOMODCACHE: join(cache, 'go-mod'),
    ELECTRON_CACHE: join(cache, 'electron'), ELECTRON_BUILDER_CACHE: join(cache, 'electron-builder'),
    // Keep HOME and credentials/toolchain paths intact. This is not an agent sandbox.
  };
}

async function publish(job) {
  await assertLiveStorage(job.artifacts);
  if (!await isManagedStoragePath(job.artifacts, { allowMissing: true })) throw Error('Build artifact destination changed');
  const receiptFile = join(job.artifacts, 'receipt.json');
  if (await exists(job.artifacts)) {
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    if (receipt.id !== job.id || receipt.nonce !== job.nonce || receipt.complete !== true) throw Error('Build artifact destination is not this completed job');
    return;
  }
  const parent = join(DATA_DIR, 'session-artifacts', job.sessionId, 'builds');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // Each attempt has an exclusive destination. A partial transfer is never an
  // acknowledgement, nor does retry overwrite the operator's published files.
  const stage = await mkdtemp(join(parent, '.' + job.id + '-'));
  try {
    const selections = [['output', join(job.path, 'output'), []], ['files', join(job.path, 'workspace'), job.outputs]];
    const exports = [];
    for (const [name, source, selected] of selections) {
      const paths = name === 'output' ? await readdir(source).catch(e => { if (e.code === 'ENOENT') return []; throw e; }) : selected;
      const manifest = await buildManifest(source, paths, { skipMissing: true });
      await copyBuildManifest(source, join(stage, name), manifest, { durable: true });
      exports.push({ directory: name, files: manifest.entries.length, bytes: manifest.bytes });
    }
    const diagnosticNames = ['build.log'].filter(name => job.logCreated && name === 'build.log');
    await copyBuildManifest(job.path, stage, await buildManifest(job.path, diagnosticNames), { durable: true });
    const receipt = { version: 1, id: job.id, nonce: job.nonce, sessionId: job.sessionId,
      source: job.source, startedAt: job.startedAt, finishedAt: job.finishedAt || null,
      exitCode: job.exitCode ?? null, interrupted: !job.finishedAt, error: job.error || null,
      snapshot: job.snapshot || null, outputs: job.outputs, exports, complete: true,
      logTruncated: !!job.logTruncated, retention: 'no-local-build-cache', publishedAt: Date.now() };
    const fd = await open(join(stage, 'receipt.json'), 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(receipt, null, 2)); await fd.sync(); } finally { await fd.close(); }
    await assertLiveStorage(job.artifacts);
    await rename(stage, job.artifacts);
  } catch (e) {
    // Only this attempt's new remote staging directory. Original files and the
    // local job remain intact if publication fails.
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
async function finishJob(job, { own = false } = {}) {
  validateJob(job);
  if (!own && await sameOwner(job.ownerPid, job.ownerStamp)) return { retained: 'active-controller' };
  if (job.pid && await sameOwner(job.pid, job.workerStamp, true)) return { retained: 'active-workers' };
  if (!await identity(job)) {
    // Deletion may have completed just before the wrapper died.
    if (!job.published) throw Error('Unpublished build directory is missing; refusing to discard its record');
    await unlink(recordFile(job.id));
    return { removed: true, id: job.id };
  }
  if (!await unused(job.path)) return { retained: 'open-files-or-unknown' };
  await publish(job);
  job.published = true; await save(job);
  // Recheck the exact owned directory and any escaped/background handles after
  // transfer, not just before it. Never erase another session or an active job.
  if (job.pid && await sameOwner(job.pid, job.workerStamp, true) || !await unused(job.path)) return { retained: 'active-workers' };
  await identity(job);
  await rm(job.path, { recursive: true, force: false });
  await unlink(recordFile(job.id));
  return { removed: true, id: job.id, artifacts: job.artifacts };
}
let sweeping = false;
export async function sweepLocalBuildJobs() {
  if (sweeping) return [];
  sweeping = true;
  try {
    const jobs = await localBuildJobs();
    if (!jobs.length) return [];
    return await lease(async () => {
      const results = [];
      for (const job of jobs.slice(0, 10)) {
        try { results.push(await finishJob(job)); }
        catch (e) { results.push({ id: job.id, retained: 'publication-or-cleanup-pending', error: e.message }); }
      }
      return results;
    });
  } catch (e) { if (e.code === 'session-archive-in-progress') return []; throw e; }
  finally { sweeping = false; }
}

// The command cannot run before its PID/group are durably recorded. If its
// controller is killed, only this finite build group stops; agents are untouched.
const worker = `const {spawn}=require('node:child_process');let started=false;
process.on('disconnect',()=>{if(started){try{process.kill(-process.pid,'SIGKILL')}catch{}}process.exit(125)});
process.once('message',()=>{started=true;const child=spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit'});
child.on('error',e=>{console.error(e.message);process.exit(127)});
child.on('exit',(code,signal)=>process.exit(code??128));});`;
async function execute(job, command, args) {
  const log = createWriteStream(join(job.path, 'build.log'), { flags: 'wx', mode: 0o600 });
  let logError, logged = 0, child, ended = false, abortReason, interval, checking, ticks = 0, killTimer;
  const abort = reason => {
    abortReason ||= reason;
    if (!child?.pid || ended) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer ||= setTimeout(() => { if (!ended) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 3000);
  };
  const interrupt = () => abort('Build interrupted by operator');
  log.on('error', e => { logError = e; abort('Build log could not be saved'); });
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    job.logCreated = true; await save(job);
    child = spawn(process.execPath, ['-e', worker, command, ...args], { cwd: join(job.path, 'workspace'),
      detached: true, env: buildEnvironment(job), stdio: ['inherit', 'pipe', 'pipe', 'ipc'] });
    const completion = new Promise(resolve => {
      child.on('error', e => resolve({ code: 127, error: e.message }));
      child.on('exit', (code, signal) => { ended = true; resolve({ code: code ?? 128, signal }); });
    });
    const output = (stream, b) => {
      stream.write(b);
      if (!logError && logged < LOG_LIMIT) { const chunk = b.subarray(0, LOG_LIMIT - logged); logged += chunk.length; log.write(chunk); }
      if (logged >= LOG_LIMIT) job.logTruncated = true;
    };
    child.stdout.on('data', b => output(process.stdout, b));
    child.stderr.on('data', b => output(process.stderr, b));
    job.pid = child.pid || null; job.workerStamp = await processStamp(job.pid); job.phase = 'running';
    try { await save(job); if (child.connected) child.send('run'); }
    catch (e) { abort('Build process receipt unavailable'); throw e; }
    interval = setInterval(() => {
      if (checking || ended) return;
      checking = (async () => {
        try {
          await capacity();
          if (++ticks % 5 === 0) {
            const { stdout } = await exec('du', ['-sk', job.path], { timeout: 10_000, maxBuffer: 1024 });
            const bytes = Number(stdout.trim().split(/\s+/)[0]) * 1024;
            if (!Number.isFinite(bytes) || bytes > maxBytes) throw Error('Local build exceeded its disposable disk budget');
          }
        } catch (e) { abort(e.message); }
        finally { checking = null; }
      })();
    }, 1000);
    const result = await completion;
    job.exitCode = abortReason ? 125 : result.code;
    job.error = abortReason || result.error || (result.signal ? 'Build stopped with ' + result.signal : null);
  } finally {
    clearInterval(interval); clearTimeout(killTimer);
    await checking;
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    child?.stdout?.destroy(); child?.stderr?.destroy();
    if (child?.connected) child.disconnect();
    log.end(); await finished(log).catch(e => { logError ||= e; });
    if (logError) { job.error = 'Build log could not be saved'; job.exitCode = 125; }
  }
}

export async function runLocalBuildJob(sessionId, command, args = [], { source = process.cwd(), include = [], outputs = [] } = {}) {
  if (!SID.test(sessionId || '') || !command) throw Error('A session id and finite build command are required');
  if (process.env.AIOS_BUILD_JOB_ID) throw Error('Already inside a disposable build; run the build command directly');
  include.forEach(buildRelativePath); outputs.forEach(buildRelativePath);
  await prepareLocalRoot();
  let job;
  try {
    await lease(async () => {
      for (const prior of await localBuildJobs()) {
        const outcome = await finishJob(prior);
        if (!outcome.removed) throw Error('Another local build is active or awaiting safe cleanup; retry after it finishes');
      }
      await capacity(); await assertLiveStorage(source);
      const sourcePath = await realpath(source);
      const id = 'b_' + randomUUID(), path = location(id);
      await mkdir(path, { mode: 0o700 });
      const info = await lstat(path);
      job = { version: 1, id, path, sessionId, source: sourcePath, outputs,
        nonce: randomUUID(), ownerPid: process.pid, ownerStamp: await processStamp(process.pid), pid: null, startedAt: Date.now(),
        phase: 'staging', device: info.dev, inode: info.ino,
        artifacts: join(DATA_DIR, 'session-artifacts', sessionId, 'builds', id) };
      try { await save(job); }
      catch (e) {
        // No worker or snapshot exists yet; reclaim only this new empty owned directory.
        await rmdir(path);
        throw e;
      }
    });
  } catch (e) {
    if (e.code === 'session-archive-in-progress') throw Error('Another build is being admitted or cleaned; retry shortly');
    throw e;
  }
  process.stderr.write(`[aios] Local build ${job.id}; outputs → ${job.artifacts}\n`);
  try {
    for (const name of ['tmp', 'cache', 'output', 'workspace']) await mkdir(join(job.path, name), { mode: 0o700 });
    // Require the durable destination before starting; never fall back to local
    // artifacts when Spark is disconnected.
    await assertLiveStorage(job.artifacts);
    job.snapshot = await snapshotBuildSource(job.source, join(job.path, 'workspace'), { include, maxBytes, check: capacity });
    await save(job);
    await execute(job, command, args);
    if (job.exitCode === 0) {
      for (const output of outputs) if (!await exists(join(job.path, 'workspace', output))) {
        throw Error('Declared build output was not produced: ' + output);
      }
    }
  } catch (e) { job.exitCode = 125; job.error = e.message; }
  job.finishedAt = Date.now(); job.phase = 'publishing'; await save(job);
  try {
    const outcome = await lease(() => finishJob(job, { own: true }));
    if (!outcome.removed) throw Error(outcome.retained);
    process.stderr.write(`[aios] Build outputs saved: ${job.artifacts}; local snapshot, dependencies and caches removed.\n`);
  } catch (e) {
    process.stderr.write(`[aios] Build is NOT finalized (${e.message}); its files are protected for automatic retry.\n`);
    return 125;
  }
  if (job.error) process.stderr.write(`[aios] ${job.error}\n`);
  return job.exitCode;
}
