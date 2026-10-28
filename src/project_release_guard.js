// Command-scoped permission for a project's OWN reviewed release workflow. This is not the AIOS
// self-publisher: no merging, versioning, uploading, or relaxing the repository's release checks here.
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { gitOut } from './git.js';

export function releaseScripts(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('release_scripts must be a list of at most 20 {cwd, script} entries');
  return value.map(item => {
    const cwd = String(item?.cwd ?? '.');
    const script = String(item?.script ?? '');
    if (!cwd || isAbsolute(cwd) || cwd.split(/[\\/]/).some(p => p === '..') || /[\x00-\x1f\\]/.test(cwd)) throw new Error('release script cwd must be a relative project directory');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,99}$/.test(script)) throw new Error('invalid release script name');
    return { cwd, script };
  });
}

function fail(message) { throw new Error(message); }
async function git(cwd, args) {
  const r = await gitOut(cwd, args, { timeout: 60000 }); // remote source trees can be slow; never treat a timeout as clean
  if (r.error) fail('Cannot verify release source: git ' + args[0] + ' failed');
  return r.text.trim();
}

export async function checkProjectRelease(context, { tool, args, cwd = process.cwd(), expectedSha = '' }) {
  if (!context?.auto_release) fail('Automatic project release is not configured. Configure its source directory, branch and reviewed release scripts; no new coding session is needed.');
  if (context.self_deploy) fail('AIOS itself must use the canonical bin/deploy integration workflow.');
  if (!context.source_dir || !context.source_branch || !context.project_path) fail('The project release source contract is incomplete.');
  // No --prefix/-C/workspace/exec indirection or extra script arguments. The allowlist names an exact
  // package and script; environment variables remain available to that reviewed workflow.
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(tool) || args.length !== 2 || !['run', 'run-script'].includes(args[0])) fail('Use the configured package release command (run SCRIPT), not a direct vendor upload or command override.');
  const source = await realpath(context.source_dir);
  const dir = await realpath(cwd);
  const allowed = releaseScripts(context.release_scripts).find(e => e.script === args[1] && resolve(source, e.cwd) === dir);
  if (!allowed) fail('Command/directory is not a configured release entry. Use ' + context.source_dir + ' on ' + context.source_branch + ' with its reviewed release script.');
  const root = await realpath(await git(dir, ['rev-parse', '--show-toplevel']));
  if (root !== source) fail('Release source must be the declared Git checkout root (nested repositories are not allowed).');
  const common = await realpath(await git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const projectCommon = await realpath(await git(context.project_path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (common !== projectCommon) fail('Release source belongs to a different project repository.');
  if (await git(source, ['branch', '--show-current']) !== context.source_branch) fail('Release source is on the wrong branch; expected ' + context.source_branch);
  const sha = await git(source, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40,64}$/.test(sha) || expectedSha && sha !== expectedSha) fail('Release candidate changed; verify the exact committed candidate again.');
  if (await git(source, ['status', '--porcelain', '--untracked-files=normal'])) fail('Release source is dirty. Commit the intended changes before publishing; nothing was deployed.');
  const manifestPath = relative(source, join(dir, 'package.json')).split('\\').join('/');
  const committedManifest = await git(source, ['show', 'HEAD:' + manifestPath]);
  if ((await readFile(join(dir, 'package.json'), 'utf8')).trim() !== committedManifest) fail('Working package.json differs from the committed release command.');
  const manifest = JSON.parse(committedManifest);
  if (typeof manifest.scripts?.[args[1]] !== 'string' || !manifest.scripts[args[1]].trim()) fail('Release script is not defined in the committed package.json.');
  // Recheck after slow metadata reads: never authorize a moving branch as the checked candidate.
  if (sha !== await git(source, ['rev-parse', 'HEAD'])) fail('Release candidate changed while checking it.');
  return { source, cwd: dir, sha, branch: context.source_branch, script: args[1] };
}

// Kernel-owned per-project lease. The command inherits the same FD: even if this guard is killed, a
// still-running release keeps the lease. A dead process/reboot cannot leave a stale lock behind.
export async function withProjectReleaseLock(context, action) {
  if (!/^p_[a-zA-Z0-9_-]+$/.test(context.project_id || '') || !isAbsolute(context.lock_dir || '')) fail('Invalid project release lock context');
  await mkdir(context.lock_dir, { recursive: true, mode: 0o700 });
  const file = await open(join(context.lock_dir, context.project_id + '.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise((ok, no) => {
      const p = spawn('python3', ['-c', 'import fcntl,sys\ntry: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(75)'], { stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      const timer = setTimeout(() => p.kill('SIGKILL'), 5000);
      p.on('error', e => { clearTimeout(timer); no(e); });
      p.on('close', code => { clearTimeout(timer); code === 0 ? ok() : no(new Error(code === 75 ? 'Another release of this project is still running. Retry after it finishes.' : 'Cannot acquire the project release lock.')); });
    });
    return await action(file.fd);
  } finally { await file.close(); } // keep the empty inode; unlinking would let two publishers own different locks
}

export async function fetchReleaseContext(sessionId, base, fetcher = fetch) {
  if (!/^s_[a-zA-Z0-9_-]+$/.test(sessionId || '')) fail('No AIOS session identity for release permission');
  const url = new URL(base || 'http://127.0.0.1:8793');
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) fail('Release permission must come from the local AIOS service');
  url.pathname = '/api/session/' + sessionId + '/release-context'; url.search = ''; url.hash = '';
  const res = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!res.ok) fail('Cannot read project release permission (HTTP ' + res.status + ')');
  const data = await res.json();
  if (!data.ok || data.context?.session_id !== sessionId) fail('Release permission does not match this session');
  return data.context;
}

export async function runProjectRelease(context, { tool, executable, args, cwd, env = process.env, refreshContext = null }) {
  return withProjectReleaseLock(context, async fd => {
    const checked = await checkProjectRelease(context, { tool, args, cwd, expectedSha: env.AIOS_DEPLOY_CANDIDATE_SHA || '' });
    if (refreshContext) {
      const fresh = await refreshContext();
      for (const key of ['session_id', 'project_id', 'project_path', 'source_dir', 'source_branch', 'auto_release', 'self_deploy', 'release_scripts', 'lock_dir']) {
        if (JSON.stringify(fresh[key]) !== JSON.stringify(context[key])) fail('Project release permission changed during validation; retry using the current contract.');
      }
    }
    // Only this child receives permission. Never change the caller, server, launch configuration or
    // another session's env. Repository-owned gates and public verification remain in the release script.
    const childEnv = { ...env, AIOS_DEPLOY_SOURCE_DIR: checked.source, AIOS_DEPLOY_BRANCH: checked.branch, AIOS_RELEASE_CANDIDATE_SHA: checked.sha };
    delete childEnv.AIOS_NO_DEPLOY;
    process.stderr.write(`Supercalm release: ${context.project_id} ${checked.sha.slice(0, 12)} — ${tool} ${args.join(' ')}\n`);
    return await new Promise((ok, no) => {
      const child = spawn(executable, args, { cwd: checked.cwd, env: childEnv, stdio: ['inherit', 'inherit', 'inherit', fd] });
      const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]);
      for (const [signal, forward] of handlers) process.on(signal, forward);
      const cleanup = () => { for (const [signal, forward] of handlers) process.off(signal, forward); };
      child.on('error', e => { cleanup(); no(e); });
      child.on('close', (code, signal) => { cleanup(); ok(code ?? (signal === 'SIGINT' ? 130 : 143)); });
    });
  });
}
