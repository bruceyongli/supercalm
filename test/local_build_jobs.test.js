import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'aios-local-build-')));
const source = join(fixture, 'source'), local = join(fixture, 'local'), data = join(fixture, 'data');
Object.assign(process.env, { AIOS_DATA: data, AIOS_SESSION_ID: 's_build_test', AIOS_LOCAL_BUILD_ROOT: local,
  AIOS_BUILD_MAX_BYTES: String(32 * 1024 ** 2), AIOS_BUILD_RESERVE_BYTES: '1024' });
delete process.env.AIOS_BUILD_JOB_ID;
const { localBuildJobs, sweepLocalBuildJobs, buildEnvironment } = await import('../src/local_build_jobs.js');
const { sessionHasProtectedJobs } = await import('../src/scratch_jobs.js');
const artifacts = join(data, 'session-artifacts', 's_build_test', 'builds');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await pause(50); } throw Error('Timed out'); }
const run = (code, options = [], env = {}) => exec(process.execPath, [join(ROOT, 'bin/build-run.mjs'), '--source', source,
  '--output', 'dist', ...options, '--', process.execPath, '-e', code], { env: { ...process.env, ...env }, timeout: 40_000, maxBuffer: 1024 ** 2 });
const build = `const fs=require('fs');if(!process.cwd().startsWith(${JSON.stringify(local)}))throw Error('not local');
if(fs.existsSync('.git'))throw Error('Git admin leaked');
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result.txt',fs.readFileSync('input.txt','utf8'));
fs.writeFileSync(process.env.AIOS_BUILD_OUTPUT+'/explicit.txt','durable');
fs.mkdirSync(process.env.npm_config_cache,{recursive:true});fs.writeFileSync(process.env.npm_config_cache+'/cache','temporary');
fs.writeFileSync('input.txt','build may not edit original');console.log('build finished');`;
async function receipts() {
  const names = (await readdir(artifacts)).filter(n => n.startsWith('b_'));
  return Promise.all(names.map(async id => ({ ...JSON.parse(await readFile(join(artifacts, id, 'receipt.json'), 'utf8')), path: join(artifacts, id) })));
}
async function clean() {
  assert.deepEqual(await readdir(local), [], 'no local payload/cache survives a finalized build');
  assert.deepEqual(await localBuildJobs(), []);
}
let interrupted;
try {
  await mkdir(source); await exec('git', ['init', '-q', source]);
  await writeFile(join(source, 'input.txt'), 'original');
  await exec('git', ['-C', source, 'add', 'input.txt']);
  await writeFile(join(source, 'input.txt'), 'dirty operator changes');
  await writeFile(join(source, 'untracked.txt'), 'untracked retained');
  await writeFile(join(source, '.gitignore'), 'node_modules/\n.env.private\ndist/\n');
  await writeFile(join(source, '.env.private'), 'fixture configuration');
  await mkdir(join(source, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(source, 'node_modules', 'fixture.js'), 'module.exports=42');
  await symlink('../fixture.js', join(source, 'node_modules', '.bin', 'fixture'));
  await run(build + `if(require('./node_modules/fixture')!==42)throw Error('dependency missing');
if(!fs.existsSync('untracked.txt'))throw Error('untracked missing');if(fs.existsSync('.env.private'))throw Error('ignored file copied');`);
  await clean();
  assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'dirty operator changes');
  let reports = await receipts();
  assert.equal(reports.length, 1); assert.equal(reports[0].exitCode, 0);
  assert.equal(await readFile(join(reports[0].path, 'files/dist/result.txt'), 'utf8'), 'dirty operator changes');
  assert.equal(await readFile(join(reports[0].path, 'output/explicit.txt'), 'utf8'), 'durable');
  assert.match(await readFile(join(reports[0].path, 'build.log'), 'utf8'), /build finished/);
  if (process.platform === 'darwin') {
    await run(build + `require('child_process').execFileSync('/usr/bin/xattr',['-w','com.aios.build-test','preserve-native-metadata','dist/result.txt']);`);
    const native = (await receipts()).filter(r => !reports.some(old => old.id === r.id))[0];
    assert.equal((await exec('/usr/bin/xattr', ['-p', 'com.aios.build-test', join(native.path, 'files/dist/result.txt')])).stdout.trim(), 'preserve-native-metadata');
    await clean();
  }
  await run(build + `if(!fs.existsSync('.env.private'))throw Error('include missing');`, ['--include', '.env.private']);
  await clean();
  await assert.rejects(run(build + 'process.exit(9)'), e => e.code === 9);
  await clean();
  assert((await receipts()).some(r => r.exitCode === 9), 'failed build preserves remote diagnostics, not local caches');
  const env = buildEnvironment({ id: 'b_test', path: local, source }, { HOME: '/original-home', CUSTOM: 'kept' });
  assert.equal(env.HOME, '/original-home'); assert.equal(env.CUSTOM, 'kept');
  assert(env.npm_config_cache.startsWith(local)); assert(env.TMPDIR.startsWith(local));
  await assert.rejects(run('', ['--output', '../escape']), /relative path/);
  await clean();
  await assert.rejects(run(''), /Declared build output was not produced/);
  await clean();
  await assert.rejects(run(build, [], { AIOS_BUILD_RESERVE_BYTES: String(1024 ** 5) }), /headroom/);
  await clean();
  await assert.rejects(run(build, [], { AIOS_BUILD_MAX_BYTES: '1' }), /admission limit/);
  await clean();
  await symlink(fixture, join(source, 'node_modules', 'escape'));
  await assert.rejects(run(build), /External build symlink/);
  await rm(join(source, 'node_modules', 'escape'));
  await clean();
  await assert.rejects(run(build + `fs.writeFileSync(process.env.AIOS_JOB_TMPDIR+'/oversize',Buffer.alloc(40*1024*1024,1));setInterval(()=>{},1000);`), /disposable disk budget/);
  await clean();

  // The established scratch entry point also works for already-running agents.
  const compat = await exec(process.execPath, [join(ROOT, 'bin/scratch-run.mjs'), '--build', '--source', source,
    '--output', 'dist', '--', process.execPath, '-e', build], { env: process.env, timeout: 30_000 });
  assert.match(compat.stderr, /local snapshot, dependencies and caches removed/);
  await clean();

  // A disconnected/replaced artifact destination may NEVER discard the only
  // outputs. Restore this test's destination; the normal sweeper finishes it.
  const parent = dirname(artifacts), moved = join(fixture, 'saved-artifacts'), outside = join(fixture, 'outside');
  await mkdir(outside);
  await assert.rejects(run(build + `fs.renameSync(${JSON.stringify(parent)},${JSON.stringify(moved)});
fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(parent)});`), /NOT finalized/);
  const [pending] = await localBuildJobs();
  assert.equal(await sessionHasProtectedJobs('s_build_test'), true);
  assert.equal(await readFile(join(pending.path, 'workspace/dist/result.txt'), 'utf8'), 'dirty operator changes');
  await rm(parent); await rename(moved, parent);
  // A reused PID after reboot must not leave a finished job protected forever.
  await writeFile(join(data, 'local-build-jobs', pending.id + '.json'), JSON.stringify({ ...pending,
    ownerPid: process.pid, ownerStamp: 'different process before reboot' }));
  assert((await sweepLocalBuildJobs()).some(r => r.removed));
  await clean();

  // Wrapper death leaves a durable owner/PID receipt. The gated build worker
  // stops its own group on IPC loss; boot/periodic recovery archives and cleans.
  interrupted = spawn(process.execPath, [join(ROOT, 'bin/build-run.mjs'), '--source', source, '--output', 'dist', '--', process.execPath, '-e',
    build + 'setInterval(()=>{},1000)'], { env: process.env, stdio: 'ignore' });
  const job = await until(async () => (await localBuildJobs()).find(j => j.phase === 'running'));
  await until(() => lstat(join(job.path, 'workspace/dist/result.txt')).catch(() => null));
  await assert.rejects(run(build), /Another local build/);
  assert.equal((await sweepLocalBuildJobs())[0].retained, 'active-controller');
  const exited = new Promise(r => interrupted.once('exit', r));
  interrupted.kill('SIGKILL'); await exited;
  await until(async () => (await sweepLocalBuildJobs()).some(r => r.removed));
  await clean();
  assert((await receipts()).some(r => r.interrupted));
  console.log('local_build_jobs.test ok: dirty snapshot, deps, outputs/logs, success/failure cleanup, capacity, symlinks, offline retry, crash recovery, source/session isolation');
} finally {
  if (interrupted?.exitCode === null && !interrupted?.signalCode) interrupted.kill('SIGKILL');
  for (const job of await localBuildJobs().catch(() => [])) {
    if (job.path.startsWith(local + '/') && job.pid) { try { process.kill(-job.pid, 'SIGKILL'); } catch {} }
  }
  await rm(fixture, { recursive: true, force: true });
}
