import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkProjectRelease, fetchReleaseContext, releaseScripts, runProjectRelease, withProjectReleaseLock } from '../src/project_release_guard.js';

const fixture = await mkdtemp(join(tmpdir(), 'aios-release-guard-'));
const repo = join(fixture, 'source');
const fakeBin = join(fixture, 'bin');
await mkdir(join(repo, 'web'), { recursive: true });
await mkdir(fakeBin);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q', '-b', 'release'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
await writeFile(join(repo, 'web', 'package.json'), JSON.stringify({ scripts: { 'deploy:frontend': 'echo reviewed', 'deploy:unsafe': 'echo unapproved' } }));
git('add', '.'); git('commit', '-qm', 'reviewed release');
const sha = git('rev-parse', 'HEAD');
const context = { session_id: 's_release', project_id: 'p_release', project_path: repo, source_dir: repo, source_branch: 'release', auto_release: true,
  release_scripts: [{ cwd: 'web', script: 'deploy:frontend' }], lock_dir: join(fixture, 'locks') };
let liveContext = context;
const server = createServer((req, res) => {
  assert.equal(req.url, '/api/session/s_release/release-context');
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, context: liveContext }));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = 'http://127.0.0.1:' + server.address().port;
await writeFile(join(fakeBin, 'npm'), `#!/usr/bin/env node
console.log(JSON.stringify({called:true,noDeploy:process.env.AIOS_NO_DEPLOY??null,sha:process.env.AIOS_RELEASE_CANDIDATE_SHA,args:process.argv.slice(2)}));
process.exit(Number(process.env.TEST_RELEASE_EXIT||0));
`);
await chmod(join(fakeBin, 'npm'), 0o755);
const options = { tool: 'npm', args: ['run', 'deploy:frontend'], cwd: join(repo, 'web') };
const guard = resolve('scripts/aios-command-guard.sh');
const run = (args = options.args, extra = {}) => new Promise((ok, no) => {
  const child = spawn(guard, args, { cwd: options.cwd, env: { ...process.env, PATH: fakeBin + ':' + process.env.PATH,
    AIOS_SESSION_ID: context.session_id, AIOS_URL: base, AIOS_GUARDED_COMMAND: 'npm', AIOS_NO_DEPLOY: '1',
    AIOS_DEPLOY_SOURCE_DIR: '/stale/launch/value', AIOS_DEPLOY_BRANCH: 'stale', AIOS_DEPLOY_CANDIDATE_SHA: sha, ...extra } });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.on('error', no); child.on('close', code => ok({ code, stdout, stderr }));
});
try {
  assert.equal((await checkProjectRelease(context, options)).sha, sha);
  await assert.rejects(checkProjectRelease({ ...context, auto_release: false }, options), /not configured/);
  await assert.rejects(checkProjectRelease({ ...context, self_deploy: true }, options), /canonical bin\/deploy/);
  await assert.rejects(checkProjectRelease(context, { ...options, expectedSha: '0'.repeat(40) }), /candidate changed/);
  await assert.rejects(checkProjectRelease(context, { ...options, args: ['run', 'deploy:unsafe'] }), /not a configured/);
  await assert.rejects(checkProjectRelease(context, { ...options, args: ['--prefix', repo, 'run', 'deploy:frontend'] }), /command override/);
  await assert.rejects(checkProjectRelease(context, { ...options, tool: 'wrangler', args: ['deploy'] }), /direct vendor/);
  await assert.rejects(checkProjectRelease({ ...context, source_branch: 'other' }, options), /wrong branch/);
  await assert.rejects(runProjectRelease(context, { ...options, executable: '/should-never-run',
    refreshContext: async () => ({ ...context, auto_release: false }) }), /permission changed/);
  await writeFile(join(repo, 'uncommitted'), 'keep');
  await assert.rejects(checkProjectRelease(context, options), /dirty/);
  await rm(join(repo, 'uncommitted'));
  const other = join(fixture, 'other'); await mkdir(other);
  execFileSync('git', ['-C', other, 'init', '-q']);
  await assert.rejects(checkProjectRelease({ ...context, project_path: other }, options), /different project/);
  assert.throws(() => releaseScripts([{ cwd: '../escape', script: 'deploy' }]), /relative/);
  assert.throws(() => releaseScripts([{ cwd: '.', script: 'deploy; rm' }]), /invalid/);
  await assert.rejects(fetchReleaseContext('s_release', 'https://example.com', () => { throw new Error('must not fetch'); }), /local AIOS/);
  assert.equal((await fetchReleaseContext('s_release', base)).project_id, 'p_release');

  let result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { called: true, noDeploy: null, sha, args: options.args });
  assert.match(result.stderr, /Supercalm release: p_release/);
  assert.equal((await readFile(join(context.lock_dir, 'p_release.lock'))).length, 0, 'no stale owner/approval record');
  result = await run(options.args, { TEST_RELEASE_EXIT: '7' });
  assert.equal(result.code, 7, 'preserve release failure');
  assert.equal((await run()).code, 0, 'failure releases the lock without another approval');
  await withProjectReleaseLock(context, async () => {
    result = await run(); assert.equal(result.code, 126); assert.match(result.stderr, /still running/); assert.equal(result.stdout, '');
  });
  assert.equal((await run()).code, 0, 'concurrent refusal leaves the next release usable');
  await assert.rejects(runProjectRelease(context, { ...options, executable: join(fixture, 'missing-binary') }), /ENOENT/);
  assert.equal((await run()).code, 0, 'spawn failure releases permission lease too');
  liveContext = { ...context, auto_release: false };
  result = await run(); assert.equal(result.code, 126); assert.equal(result.stdout, '', 'revoked permission is checked without restarting the session');
  assert.equal((await run(['run', 'build'])).code, 0, 'ordinary commands unchanged');
  liveContext = context;
  assert.equal((await run()).code, 0, 'live permission restores only its reviewed command');
  console.log('project_release_guard.test: source, command, candidate, live permission, concurrency, failure cleanup passed');
} finally {
  await new Promise(ok => server.close(ok));
  await rm(fixture, { recursive: true, force: true });
}
