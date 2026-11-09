// Read an explicitly registered stopped-session archive directly over SSH.
// Never restore it to the old network worktree just to copy it out again.
import { readFile, realpath, lstat, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { archiveRecords } from './artifact_archive.js';
import { archiveRequest, shellQuote, validateArchiveLocation } from './archive_transport.js';
import { sameStoragePath, liveStorageConfig } from './live_storage.js';
import { executionGit } from './execution_git.js';
import { hashFile } from './execution_bundle.js';
import { migrationError } from './execution_identity.js';

export async function executionSource(session, project, { history = false } = {}) {
  const logical = session.worktree_path || project.path;
  // Old non-isolated records have no session-owned checkout to move in history mode.
  if (history && !session.worktree_path) return { path: null, missingWorkspace: true };
  try { return { path: await realpath(logical) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const archive = (await archiveRecords({ fresh: true })).find(r => r.sessionId === session.id && r.kind === 'worktree' && sameStoragePath(r.sourceRoot, logical));
  if (!archive) {
    if (history) return { path: null, missingWorkspace: true };
    throw migrationError('The session checkout is unavailable and has no registered archive');
  }
  if (archive.state !== 'archived' || archive.evictionPath || !sameStoragePath(archive.repoPath, project.path)) throw migrationError('The worktree archive needs recovery before it can move');
  return { path: await realpath(project.path), archive };
}

export async function archivedGitEvidence(archive, projectPath, { request = archiveRequest } = {}) {
  const pointer = (await request(archive.host, { root: archive.remoteRoot, op: 'read', path: '.git', start: 0, end: 4095 })).toString('utf8').trim();
  if (!/^gitdir: \/[^\r\n\0]+$/.test(pointer)) throw migrationError('Archived Git registration is unavailable');
  const common = await realpath((await executionGit(projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const admin = await realpath(pointer.slice(8));
  if (dirname(admin) !== join(common, 'worktrees')) throw migrationError('Archived Git registration belongs to another repository');
  const reciprocal = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
  if (!sameStoragePath(reciprocal, join(archive.sourceRoot, '.git'))) throw migrationError('Archived Git worktree identity differs');
  const run = args => executionGit(projectPath, ['--git-dir=' + admin, ...args]);
  const optional = args => run(args).catch(error => { if ([1, 2].includes(error.exitCode)) return ''; throw error; });
  const [head, branch, origin, name, email, split, sparse] = await Promise.all([
    run(['rev-parse', 'HEAD']), optional(['symbolic-ref', '--short', '-q', 'HEAD']), optional(['config', '--get', 'remote.origin.url']),
    optional(['config', '--get', 'user.name']), optional(['config', '--get', 'user.email']), run(['rev-parse', '--shared-index-path']), optional(['config', '--get', 'core.sparseCheckout']),
  ]);
  if (split.trim() || sparse.trim() === 'true' || /^https?:\/\/[^/]*@/i.test(origin.trim())) throw migrationError('Archived Git configuration cannot be moved safely');
  const index = join(admin, 'index');
  const indexReceipt = await hashFile(index);
  // Metadata fingerprint is a source-stability guard, not a new full-content proof.
  const observed = await request(archive.host, { root: archive.remoteRoot, op: 'digest', contents: false }, { timeoutMs: 120000 });
  // The old index stores LOCAL inode/ctime fingerprints, which necessarily
  // differ on Spark. Compare inventory totals, then bind this remote fingerprint
  // before/after transfer; do not mislabel this as a fresh content verification.
  if (['files', 'directories', 'links', 'bytes'].some(k => observed[k] !== archive[k])) throw migrationError('The registered archive inventory changed; source retained');
  return { head: head.trim(), branch: branch.trim() || null, index, indexReceipt, statusHash: null,
    archiveFingerprint: observed.fingerprint, origin: origin.trim() || null, identity: { name: name.trim(), email: email.trim() } };
}

export async function executionArtifactArchives(sessionId) {
  return (await archiveRecords({ fresh: true })).filter(r => r.sessionId === sessionId && r.kind !== 'worktree' && r.state === 'archived' && !r.evictionPath)
    .map(r => ({ ...r, name: r.sourceRoot.split('/').at(-1) }));
}

export function archivedWorkingArchive(archive) {
  validateArchiveLocation(archive.host, archive.remoteRoot);
  return { command: '/usr/bin/ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', archive.host,
    `tar ${archive.kind === 'worktree' ? '--exclude=./.git ' : ''}-C ${shellQuote(archive.remoteRoot)} -cf - .`] };
}

// Only consult original-retention journals from the configured migration. Never
// guess another user's home, choose the latest conversation, or scan the whole disk.
export async function retainedNativeRoots(source) {
  const root = liveStorageConfig()?.journalRoot;
  if (!root) return [];
  const matches = [];
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9]+\.json$/.test(name)) continue;
    const row = JSON.parse(await readFile(join(root, name), 'utf8'));
    if (resolve(row.source || '/') !== resolve(source) || !row.sourceRetained || !row.retainedOriginal?.path) continue;
    const saved = row.retainedOriginal;
    const info = await lstat(saved.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isDirectory() && info.ino === saved.inode && info.dev === saved.device) matches.push(saved.path);
  }
  return matches;
}
