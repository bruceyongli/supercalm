#!/usr/bin/env node
// Non-destructive staging only, not deployment or live cutover. Originals always stay in place.
// Quiesce writers and verify before a separately coordinated maintenance/cutover operation.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, lstat, realpath, stat, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { validateLiveStorage } from '../src/live_storage.js';
import { archiveWorker } from '../src/archive_transport.js';

const [operation, configFile, sourceArg] = process.argv.slice(2);
if (!['copy', 'verify'].includes(operation) || !configFile || !sourceArg) {
  throw new Error('Usage: migrate-live-storage.mjs copy|verify CONFIG SOURCE (originals retained)');
}
const config = validateLiveStorage(JSON.parse(await readFile(configFile, 'utf8')));
const source = resolve(sourceArg);
const mapping = config.mappings.find(m => m.source === source);
if (!mapping || !source.startsWith('/Users/') || source.split('/').length < 5
    || /\/proxy(?:\/|$)/.test(source) || /\.db(?:-|$)/.test(source)) throw new Error('Source is not an approved storage mapping');
const mount = resolve(config.mount), target = resolve(mapping.target);
if (!target.startsWith(mount + sep) || target.split('/').length < mount.split('/').length + 2) throw new Error('Destination is not a dedicated mounted-storage directory');
if (await realpath(mount) !== mount || (await stat(mount)).dev === (await stat(dirname(mount))).dev
    || (await readFile(join(mount, '.aios-storage-id'), 'utf8')).trim() !== config.id) throw new Error('Expected Spark volume is not mounted; refusing local fallback');
const id = createHash('sha256').update(source).digest('hex').slice(0, 20);
const journalRoot = resolve(config.journalRoot);
if (journalRoot.startsWith(source + sep) || journalRoot.startsWith(mount + sep)) throw new Error('Migration journal must remain on local control storage');
await mkdir(journalRoot, { recursive: true, mode: 0o700 });
const journalFile = join(journalRoot, id + '.json');
// Kernel-owned lease, released on exit/reboot. Never unlink a lock inode.
const lease = await open(join(journalRoot, id + '.lock'), 'a+', 0o600);
await new Promise((yes, no) => {
  const child = spawn('python3', ['-c', 'import fcntl\nfcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],
    { stdio: ['ignore', 'ignore', 'ignore', lease.fd] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.on('error', e => { clearTimeout(timer); no(e); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? yes() : no(Error('Another transfer owns this source; originals retained')); });
});
let journal;
try { journal = JSON.parse(await readFile(journalFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const original = await lstat(source);
if (!journal) {
  if (!original.isDirectory() || original.isSymbolicLink() || await realpath(source) !== source) throw new Error('New source must be a physical directory');
  journal = { version: 1, source, target, id, createdAt: Date.now(), sourceInode: original.ino, sourceDevice: original.dev,
    state: 'planned' };
  try { await lstat(target); throw new Error('Destination already exists without a migration journal'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
if (journal.source !== source || journal.target !== target) throw new Error('Migration identity changed');
const save = async changes => {
  Object.assign(journal, changes, { updatedAt: Date.now() });
  await writeFile(journalFile + '.tmp', JSON.stringify(journal, null, 2), { mode: 0o600 });
  await rename(journalFile + '.tmp', journalFile);
};
const log = createWriteStream(join(journalRoot, id + '.log'), { flags: 'a', mode: 0o600 });
let logError = null, activeChild = null, loggedBytes = 0;
log.on('error', error => {
  logError = error;
  // Journal/log failure (including local ENOSPC) must stop our copier, not orphan it.
  activeChild?.kill('SIGTERM');
});
async function command(file, args, { collect = false, timeoutMs = 12 * 3600_000 } = {}) {
  if (logError) throw Error('Migration log unavailable; originals retained: ' + logError.code);
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child;
  const chunks = []; let size = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => {
    if (!logError && loggedBytes < 1024 * 1024) {
      const bounded = b.subarray(0, 1024 * 1024 - loggedBytes);
      loggedBytes += bounded.length; log.write(bounded);
    }
    if (collect) { size += b.length; if (size <= 2 * 1024 * 1024) chunks.push(b); }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
    if (logError) throw Error('Migration log unavailable; copier stopped and originals retained: ' + logError.code);
    if (code !== 0) throw Object.assign(new Error(`${file} exited ${code}; data retained; inspect ${id}.log`), { exitCode: code });
    if (collect && size > 2 * 1024 * 1024) throw Error('Verification output exceeded its bound; source and destination retained');
    return Buffer.concat(chunks).toString();
  } finally { clearTimeout(timer); activeChild = null; }
}
async function verify() {
  // Independent content hashes: Apple's openrsync checksum/AppleDouble dry-run is not the
  // authority for deleting originals. This command remains staging-only even when hashes agree.
  const local = await archiveWorker({ op: 'digest', root: source });
  const remote = await archiveWorker({ op: 'digest', root: target });
  const after = await archiveWorker({ op: 'digest', root: source, contents: false });
  if (local.digest !== remote.digest || local.fingerprint !== after.fingerprint
      || (await lstat(source)).mode !== (await lstat(target)).mode) {
    throw new Error('Copy differs or source changed during verification; both copies retained');
  }
  return { algorithm: 'sha256', files: local.files, bytes: local.bytes,
    scope: 'names, file contents, modes, symlink targets', cutoverReady: false };
}
try {
  {
    if (!original.isDirectory() || original.ino !== journal.sourceInode || original.dev !== journal.sourceDevice) throw new Error('Source identity changed; inspect journal before recovery');
    if (operation === 'copy') {
      await save({ state: 'copying' });
      await mkdir(target, { recursive: true, mode: original.mode & 0o777 });
      await command('/usr/bin/rsync', ['-aEH', '--stats', source + '/', target + '/']);
      await save({ state: 'copied' });
      console.log(JSON.stringify({ copied: source, target, journal: journalFile, sourceRetained: true }));
    } else {
      const verification = await verify(); await save({ state: 'content-verified', verifiedAt: Date.now(), verification });
      console.log(JSON.stringify({ verified: source, target, verification, sourceRetained: true }));
    }
  }
} catch (error) {
  await save({ error: error.message });
  throw error;
} finally { if (!log.destroyed) await new Promise(resolve => log.end(resolve)); await lease.close(); }
