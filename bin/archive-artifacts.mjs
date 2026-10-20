#!/usr/bin/env node
// Explicit operator maintenance: never selects/deletes a session by age alone.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { mkdir, lstat, realpath, rename, rm, statfs, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../src/config.js';
import { archiveIndexRoot, archiveRecordId, archiveRecords, saveArchiveRecord } from '../src/artifact_archive.js';
import { archiveWorker, archiveRequest, shellQuote, validateArchiveLocation } from '../src/archive_transport.js';

const exec = promisify(execFile);
const [operation, sessionId, name, host, remoteRoot] = process.argv.slice(2);
if (!['copy', 'verify', 'evict', 'restore'].includes(operation) || !/^s_[a-zA-Z0-9_-]+$/.test(sessionId || '')
    || !name || name.startsWith('.') || name !== basename(name) || /[\0\r\n\\]/.test(name)) {
  throw new Error('Usage: AIOS_DATA=/absolute/data node bin/archive-artifacts.mjs copy|verify SID DIRECTORY SSH_HOST REMOTE_DIRECTORY\n       ... evict|restore SID DIRECTORY');
}
const sourceRoot = join(DATA_DIR, 'session-artifacts', sessionId, name);
const parent = dirname(sourceRoot);
if (await realpath(parent) !== parent) throw new Error('Artifact parent is a symlink');
await mkdir(archiveIndexRoot, { recursive: true, mode: 0o700 });
const lock = join(archiveIndexRoot, `${archiveRecordId(sourceRoot)}.lock`);
await mkdir(lock); // Fail closed on another maintenance process or an interrupted operation.
async function unopened(path) {
  try {
    const result = await exec('lsof', ['-nP', '+D', path], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (result.stdout.trim()) throw new Error('Archive directory is in use; no local files removed');
    throw new Error('Could not prove archive directory is unused');
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return;
    throw error;
  }
}
async function localDigest(contents = true, root = sourceRoot) {
  return archiveWorker({ op: 'digest', root, contents });
}
async function remoteDigest(record) {
  return archiveRequest(record.host, { op: 'digest', root: record.remoteRoot }, { timeoutMs: 60 * 60_000 });
}
function same(a, b) {
  if (a.digest !== b.digest || a.bytes !== b.bytes || a.files !== b.files || a.links !== b.links || a.directories !== b.directories) {
    throw new Error('Archive verification mismatch; local files retained');
  }
}
async function transfer(fromRemote, location, local) {
  const remoteCommand = fromRemote
    ? `tar -C ${shellQuote(location.remoteRoot)} -cf - .`
    : `umask 077; mkdir -p ${shellQuote(dirname(location.remoteRoot))} && mkdir ${shellQuote(location.remoteRoot)} && tar -C ${shellQuote(location.remoteRoot)} -xpf - && sync -f ${shellQuote(location.remoteRoot)}`;
  const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    location.host, remoteCommand], { stdio: [fromRemote ? 'ignore' : 'pipe', fromRemote ? 'pipe' : 'inherit', 'inherit'] });
  const tar = spawn('tar', fromRemote ? ['-C', local, '-xpf', '-'] : ['-C', local, '-cf', '-', '.'],
    { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: [fromRemote ? 'pipe' : 'ignore', fromRemote ? 'inherit' : 'pipe', 'inherit'] });
  const finished = process => new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve() : reject(new Error(`Transfer failed (${code}); local source retained`)));
  });
  const timer = setTimeout(() => { tar.kill('SIGKILL'); ssh.kill('SIGKILL'); }, 6 * 60 * 60_000);
  try { await Promise.all([finished(ssh), finished(tar), pipeline(fromRemote ? ssh.stdout : tar.stdout, fromRemote ? tar.stdin : ssh.stdin)]); }
  catch (error) { tar.kill('SIGKILL'); ssh.kill('SIGKILL'); throw error; }
  finally { clearTimeout(timer); }
}
try {
  let record = (await archiveRecords({ fresh: true })).find(r => r.sourceRoot === sourceRoot);
  if (operation === 'copy' || operation === 'verify') {
    validateArchiveLocation(host, remoteRoot);
    if (record && (operation === 'copy' || record.host !== host || record.remoteRoot !== remoteRoot)) {
      throw new Error('Archive already registered; do not overwrite or retarget it');
    }
    if (!(await lstat(sourceRoot)).isDirectory()) throw new Error('Source must be a real directory, not a symlink');
    await unopened(sourceRoot);
    if (operation === 'copy') await transfer(false, { host, remoteRoot }, sourceRoot);
    console.log('Hashing local files and the remote copy (no deletion)...');
    const local = await localDigest();
    console.log(`Local digest complete: ${local.files} files, ${local.links} links. Verifying remote contents...`);
    const remote = await remoteDigest({ host, remoteRoot });
    same(local, remote);
    if (local.fingerprint !== (await localDigest(false)).fingerprint) throw new Error('Source changed; not registered');
    record = { version: 1, sessionId, sourceRoot, host, remoteRoot, ...local, state: 'verified', verifiedAt: Date.now() };
    await saveArchiveRecord(record);
    console.log(JSON.stringify({ verified: true, sourceRoot, host, remoteRoot, ...local }));
  } else if (operation === 'evict') {
    if (!record) throw new Error('Verify the copy before eviction');
    if (Date.now() - record.verifiedAt > 24 * 60 * 60_000) throw new Error('Verification expired; retain local files and re-verify explicitly');
    if (!(await lstat(sourceRoot)).isDirectory()) throw new Error('Source is not a real directory');
    await unopened(sourceRoot);
    if ((await localDigest(false)).fingerprint !== record.fingerprint) throw new Error('Source changed since verification; local files retained');
    same(record, await remoteDigest(record)); // A vanished/corrupt remote must never authorize deletion.
    const quarantine = join(parent, `.archive-eviction-${randomUUID()}`);
    record = { ...record, evictionPath: quarantine };
    await saveArchiveRecord(record); // Crash-recovery breadcrumb, before rename.
    await rename(sourceRoot, quarantine);
    try {
      await unopened(quarantine);
      if ((await localDigest(false, quarantine)).fingerprint !== record.fingerprint) throw new Error('Source changed during eviction');
    } catch (error) {
      if (!await lstat(sourceRoot).catch(() => null)) await rename(quarantine, sourceRoot);
      throw error;
    }
    // Exact newly-renamed verified tree only. Never recursively remove a session/project/storage root.
    if (dirname(quarantine) !== parent || !basename(quarantine).startsWith('.archive-eviction-')) throw new Error('Unsafe eviction target');
    await rm(quarantine, { recursive: true, force: false });
    delete record.evictionPath;
    await saveArchiveRecord({ ...record, state: 'archived', archivedAt: Date.now() });
    console.log(JSON.stringify({ evicted: sourceRoot, recoverableFrom: `${record.host}:${record.remoteRoot}`, bytes: record.bytes }));
  } else {
    if (!record) throw new Error('No archive found');
    if (await lstat(sourceRoot).catch(() => null)) throw new Error('Local destination exists; restore never overwrites it');
    const disk = await statfs(parent);
    if (disk.bavail * disk.bsize < record.bytes + 5 * 1024 ** 3) throw new Error('Not enough space to restore with a 5 GiB reserve');
    const stage = join(parent, `.archive-restore-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    await transfer(true, record, stage);
    same(record, await localDigest(true, stage));
    if (await lstat(sourceRoot).catch(() => null)) throw new Error(`Destination appeared; verified restore retained at ${stage}`);
    await rename(stage, sourceRoot);
    await saveArchiveRecord({ ...record, state: 'verified', restoredAt: Date.now(), verifiedAt: 0 });
    console.log(JSON.stringify({ restored: sourceRoot, remoteRetained: true }));
  }
} finally { await rmdir(lock); }
