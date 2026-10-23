import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { mkdir, lstat, statfs, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveWorker, shellQuote } from './archive_transport.js';
import { archiveRecords, saveArchiveRecord } from './artifact_archive.js';
import { assertLiveStorage, isManagedStoragePath } from './live_storage.js';

const exec = promisify(execFile);
export function sameArchive(a, b) {
  if (a.digest !== b.digest || a.bytes !== b.bytes || a.files !== b.files || a.links !== b.links || a.directories !== b.directories) {
    throw new Error('Archive verification mismatch; local files retained');
  }
}
export async function transferArchive(fromRemote, location, local) {
  const remoteCommand = fromRemote
    ? `tar -C ${shellQuote(location.remoteRoot)} -cf - .`
    : `umask 077; mkdir -p ${shellQuote(dirname(location.remoteRoot))} && mkdir ${shellQuote(location.remoteRoot)} && tar -C ${shellQuote(location.remoteRoot)} -xpf - && sync -f ${shellQuote(location.remoteRoot)}`;
  const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    location.host, remoteCommand], { stdio: [fromRemote ? 'ignore' : 'pipe', fromRemote ? 'pipe' : 'inherit', 'inherit'] });
  const tar = spawn('tar', fromRemote ? ['-C', local, '-xpf', '-'] : ['-C', local, '-cf', '-', '.'],
    { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: [fromRemote ? 'pipe' : 'ignore', fromRemote ? 'inherit' : 'pipe', 'inherit'] });
  const finished = process => new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve() : reject(new Error(`Transfer failed (${code}); source retained`)));
  });
  const timer = setTimeout(() => { tar.kill('SIGKILL'); ssh.kill('SIGKILL'); }, 6 * 60 * 60_000);
  try { await Promise.all([finished(ssh), finished(tar), pipeline(fromRemote ? ssh.stdout : tar.stdout, fromRemote ? tar.stdin : ssh.stdin)]); }
  catch (error) { tar.kill('SIGKILL'); ssh.kill('SIGKILL'); throw error; }
  finally { clearTimeout(timer); }
}
// Caller owns the cross-process session lease. Staging is retained on failure for recovery.
export async function restoreArchive(record) {
  const source = record.sourceRoot, parent = dirname(source);
  await assertLiveStorage(parent);
  if (!await isManagedStoragePath(parent)) throw new Error('Restore parent changed or is a symlink');
  if (await lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    throw new Error('Local destination exists; restore never overwrites it');
  }
  const disk = await statfs(parent);
  if (disk.bavail * disk.bsize < record.bytes + 5 * 1024 ** 3) throw new Error('Not enough space to restore with a 5 GiB reserve');
  const stage = join(parent, `.archive-restore-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  await transferArchive(true, record, stage);
  sameArchive(record, await archiveWorker({ op: 'digest', root: stage }));
  if (!await isManagedStoragePath(parent)) throw new Error('Restore parent changed; staging retained');
  if (await lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error(`Destination appeared; verified restore retained at ${stage}`);
  await rename(stage, source);
  await saveArchiveRecord({ ...record, state: 'verified', restoredAt: Date.now(), verifiedAt: 0 });
  if (record.kind === 'worktree' && record.gitLockOwned) {
    // Only release OUR exact Git lock. Never unlock an operator's independent lock.
    const list = (await exec('git', ['-C', record.repoPath, 'worktree', 'list', '--porcelain'], { timeout: 10000 })).stdout;
    const block = list.split('\n\n').find(b => b.split('\n').includes(`worktree ${source}`));
    if (block?.split('\n').includes(`locked ${record.gitLockReason}`)) {
      await exec('git', ['-C', record.repoPath, 'worktree', 'unlock', source], { timeout: 10000 });
    }
  }
  return { restored: source, remoteRetained: true };
}
export async function restoreArchivedWorktree(session) {
  if (!session.worktree_path) return;
  const record = (await archiveRecords({ fresh: true })).find(r => r.sessionId === session.id && r.kind === 'worktree'
    && r.sourceRoot === session.worktree_path);
  if (!record) return;
  if (record.evictionPath) throw new Error('Worktree migration was interrupted. The verified Spark copy and local recovery path are preserved; complete recovery before resuming.');
  if (record.state === 'archived') return restoreArchive(record);
  if (!record.restoredAt && !await lstat(record.sourceRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    throw new Error('Verified worktree source is missing; inspect migration recovery before recreating a checkout');
  }
}
