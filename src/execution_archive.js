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

// Historical media/debug attachments remain in their registered SSH archive.
// Stream only regular report files; never follow symlinks, hydrate the source,
// or rescan/hash the excluded media. Per-file checks still bind transferred bytes
// to the opened source version, and the normal upload receipt checks transport.
const historicalReportArchive = `import os,sys,stat,tarfile
extensions={'.md','.markdown','.txt','.html','.htm','.csv','.tsv','.rst','.adoc','.asciidoc'}
def identity(st): return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns,st.st_mode)
def regular(directory,name):
 try: return stat.S_ISREG(os.stat(name,dir_fd=directory,follow_symlinks=False).st_mode)
 except FileNotFoundError: return False
def cold_directory(directory,name):
 if name=='node_modules': return True
 if name in ('venv','.venv') and regular(directory,name+'/pyvenv.cfg'): return True
 return name.endswith('.app') and regular(directory,name+'/Contents/Info.plist')
root=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 root_identity=identity(os.fstat(root))
 with tarfile.open(fileobj=sys.stdout.buffer,mode='w|',format=tarfile.PAX_FORMAT) as archive:
  for directory,dirs,files,descriptor in os.fwalk('.',topdown=True,follow_symlinks=False,dir_fd=root):
   directory_identity=identity(os.fstat(descriptor))
   dirs[:]=sorted(name for name in dirs if not cold_directory(descriptor,name))
   for name in sorted(files):
    if os.path.splitext(name)[1].lower() not in extensions: continue
    relative=os.path.join(directory,name)
    if any(c in relative for c in '\\\\\\r\\n\\0') or any(p=='..' for p in relative.split('/')): raise RuntimeError('Unsafe report archive member')
    before=os.stat(name,dir_fd=descriptor,follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode): continue
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=descriptor)
    with os.fdopen(fd,'rb') as stream:
     if identity(os.fstat(stream.fileno()))!=identity(before): raise RuntimeError('Report changed before transfer')
     info=tarfile.TarInfo(relative); info.size=before.st_size; info.mode=stat.S_IMODE(before.st_mode); info.mtime=before.st_mtime
     archive.addfile(info,stream)
     if identity(os.fstat(stream.fileno()))!=identity(before) or identity(os.stat(name,dir_fd=descriptor,follow_symlinks=False))!=identity(before): raise RuntimeError('Report changed during transfer')
   if identity(os.fstat(descriptor))!=directory_identity: raise RuntimeError('Report directory changed during transfer')
 if identity(os.fstat(root))!=root_identity or identity(os.stat(sys.argv[1],follow_symlinks=False))!=root_identity: raise RuntimeError('Report archive root changed during transfer')
finally: os.close(root)
`;

export function archivedWorkingArchive(archive, { retainHistoricalArtifacts = false } = {}) {
  validateArchiveLocation(archive.host, archive.remoteRoot);
  const command = retainHistoricalArtifacts && archive.kind !== 'worktree'
    ? `python3 -c ${shellQuote(historicalReportArchive)} ${shellQuote(archive.remoteRoot)}`
    : `tar ${archive.kind === 'worktree' ? '--exclude=./.git ' : ''}-C ${shellQuote(archive.remoteRoot)} -cf - .`;
  return { command: '/usr/bin/ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', archive.host,
    command] };
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
