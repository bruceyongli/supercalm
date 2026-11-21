// A project launch home is a durable, device-local Git object store, never a
// user's session checkout. Worktrees share its objects, not its index or branch.
import { lstat, realpath, readFile, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { executionGit, assertSelfContainedCommit } from './execution_git.js';
import { migrationError } from './execution_identity.js';
import { assertLocalCheckout } from './execution_bundle.js';

export const workerRoot = () => process.env.AIOS_EXECUTION_ROOT || join(homedir(), '.local/share/supercalm-executor');
export function homePath(projectId) {
  if (!/^p_[A-Za-z0-9_-]+$/.test(projectId || '')) throw migrationError('Invalid execution project');
  return join(workerRoot(), 'projects', projectId + '.git');
}
export const commitId = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
async function localDirectory(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.dev !== (await lstat(homedir())).dev || await realpath(path) !== resolve(path)) {
    throw migrationError('The launch home must be a real directory on the device SSD');
  }
}
export async function inspectLaunchHome(projectId, revision, branch) {
  const path = homePath(projectId);
  try { await localDirectory(path); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    throw migrationError('Local project repository unavailable on the execution device. The request is saved; no cold checkout was substituted.', 'execution-home-unavailable',503);
  }
  await localDirectory(join(path, 'objects'));
  await localDirectory(join(path, 'objects/pack'));
  const marker = await readFile(join(path, 'supercalm-project'), 'utf8');
  if (marker.trim() !== projectId) throw migrationError('Local launch project identity mismatch');
  for (const part of ['objects/info/alternates', 'commondir', 'shallow']) {
    try { await lstat(join(path, part)); throw migrationError('The launch home must own a complete local Git history'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if ((await executionGit(path, ['rev-parse', '--is-bare-repository'])).trim() !== 'true') throw migrationError('Invalid local launch repository');
  if (revision != null && !commitId(revision)) throw migrationError('Invalid launch commit');
  if (branch && (branch.length > 200 || !/^[\w][\w./-]*$/.test(branch) || branch.includes('..'))) throw migrationError('Invalid launch base branch');
  const head = (await executionGit(path, ['rev-parse','--verify',(revision || (branch && 'refs/heads/'+branch) || 'HEAD') + '^{commit}'])).trim();
  if (!commitId(head) || revision && head !== revision) throw migrationError('Exact launch commit is unavailable');
  return { projectId, path, head };
}

// Independent imported checkouts still have the old strict contract. Only a
// worker-created linked worktree in this session's slot may use its project home.
export async function assertExecutionSessionCheckout(s) {
  const cwd = s.worktree_path;
  if (!cwd || !(await lstat(join(cwd,'.git'))).isFile()) return assertLocalCheckout(cwd);
  if (!/^s_[A-Za-z0-9_-]+$/.test(s.id) || cwd !== join(workerRoot(),'workspaces',s.id)) throw migrationError('Unexpected local session worktree');
  await localDirectory(cwd);
  const home = await inspectLaunchHome(s.project_id);
  const common = (await executionGit(cwd,['rev-parse','--path-format=absolute','--git-common-dir'])).trim();
  const admin = (await executionGit(cwd,['rev-parse','--absolute-git-dir'])).trim();
  if (common !== home.path || dirname(admin) !== join(home.path,'worktrees') ||
      await realpath((await readFile(join(admin,'gitdir'),'utf8')).trim()) !== join(cwd,'.git')) throw migrationError('Session worktree does not belong to its local project');
  return cwd;
}
export async function materializeLocalLaunch({ session, project, git }, cwd) {
  const home = await inspectLaunchHome(project.id, git.head);
  const space = await statfs(home.path);
  if (space.bavail * space.bsize < 10 * 1024 ** 3) throw migrationError('The device has less than 10 GiB free','disk-space-critical',507);
  if (cwd !== join(workerRoot(),'workspaces',session.id) || !/^s_[A-Za-z0-9_-]+$/.test(session.id) ||
      !git.branch?.startsWith('supercalm/') || basename(git.branch) !== session.id) throw migrationError('Invalid local launch worktree');
  const exists = await lstat(cwd).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; });
  if (!exists) {
    await assertSelfContainedCommit(home.path,home.head);
    const ref = (await executionGit(home.path,['for-each-ref','--format=%(refname) %(objectname)','refs/heads/'+git.branch])).trim();
    if (ref && ref !== 'refs/heads/'+git.branch+' '+home.head) throw migrationError('Existing session branch differs; it was retained');
    await executionGit(home.path,ref ? ['worktree','add','--',cwd,git.branch] : ['worktree','add','-b',git.branch,'--',cwd,home.head],
      {label:'local checkout',capacityDir:home.path});
  }
  await assertExecutionSessionCheckout({id:session.id, project_id:project.id, worktree_path:cwd});
  if ((await executionGit(cwd,['rev-parse','HEAD'])).trim() !== home.head ||
      (await executionGit(cwd,['symbolic-ref','--short','HEAD'])).trim() !== git.branch) throw migrationError('Existing launch checkout differs; files retained');
  return home;
}
