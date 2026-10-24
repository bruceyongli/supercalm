// Operator-invoked storage cutover primitives. No database writes and no process termination.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, rename, symlink, lstat, readFile, writeFile, readlink, realpath, rm, mkdir, readdir, chmod } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { validateLiveStorage, assertLiveStorage } from './live_storage.js';
import { DATA_DIR } from './config.js';
import { assertTransferReceipt } from './storage_transfer_receipt.js';

const exec = promisify(execFile);
const worker = fileURLToPath(new URL('../scripts/storage-manifest.py', import.meta.url));
const inside = (p, root) => p === root || p.startsWith(root === sep ? sep : root + sep);
const snapshotRoot = join(DATA_DIR, 'storage-manifest-tools');
async function manifestSnapshot(hash = null) {
  if (hash && !/^[0-9a-f]{64}$/.test(hash)) throw Error('Invalid verification implementation identity');
  const code = await readFile(hash ? join(snapshotRoot, hash + '.py') : worker);
  const actual = createHash('sha256').update(code).digest('hex');
  if (hash && actual !== hash) throw Error('Verification implementation changed');
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const path = join(snapshotRoot, actual + '.py');
  try { await writeFile(path, code, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (createHash('sha256').update(await readFile(path)).digest('hex') !== actual) throw Error('Verification implementation changed');
  return { path, hash: actual };
}

export async function durableJson(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
  const parent = await open(dirname(file), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

export function parseOpenFiles(output, roots) {
  let pid, command, descriptor;
  const found = [];
  for (const field0 of output.split('\0')) {
    const field = field0.replace(/^\n/, '');
    if (field[0] === 'p') pid = Number(field.slice(1));
    else if (field[0] === 'c') command = field.slice(1);
    else if (field[0] === 'f') descriptor = field.slice(1);
    else if (field[0] === 'n') {
      const path = field.slice(1);
      if (roots.some(root => inside(path, root))) found.push({ pid, command, descriptor, path });
    }
  }
  return found;
}

export async function openFiles(roots) {
  // One bounded global inventory, not lsof +D statting millions of members. Include cwd,
  // mmap/text and read-only descriptors too: any old inode can defeat a transparent relocation.
  const result = await exec('/usr/sbin/lsof', ['-nP', '-F0pcfn'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.stderr.trim()) throw Error('Open-file inventory was incomplete; originals retained');
  return parseOpenFiles(result.stdout, roots);
}

export async function assertUnused(roots) {
  const owners = await openFiles(roots);
  if (owners.length) throw Object.assign(Error('Storage still has open handles; originals retained: '
    + [...new Set(owners.map(p => p.pid + ':' + p.command))].slice(0, 12).join(', ')), { code: 'storage-in-use', owners });
}

export async function storageManifest(root, { metadataOnly = false, ephemeralSockets = false, equivalentGroups = [], workerFile = worker } = {}) {
  const args = [workerFile, root];
  if (metadataOnly) args.push('--metadata-only');
  else {
    const cacheRoot = join(DATA_DIR, 'storage-hash-proofs');
    if (inside(cacheRoot, resolve(root))) throw Error('Verification proof cache must remain outside the source');
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const cacheId = createHash('sha256').update(resolve(root)).digest('hex');
    args.push('--content-cache=' + join(cacheRoot, cacheId + '.json'));
  }
  if (ephemeralSockets) args.push('--ephemeral-sockets');
  for (const group of equivalentGroups) {
    if (!Number.isInteger(group.from) || !Number.isInteger(group.to) || group.from < 0 || group.to < 0) throw Error('Invalid group equivalence');
    args.push(`--equivalent-group=${group.from}:${group.to}`);
  }
  const { stdout } = await exec('python3', args, { timeout: 12 * 3600_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function verifyStoragePair(source, target, options = {}) {
  // Long jobs must not mix verifier implementations if the checkout is updated while
  // a remote read is in flight. All three passes use one content-addressed local script.
  const implementation = await manifestSnapshot();
  const fixed = { ...options, workerFile: implementation.path };
  const local = await storageManifest(source, fixed);
  const remote = await storageManifest(target, fixed);
  const after = await storageManifest(source, { ...fixed, metadataOnly: true });
  if (local.digest !== remote.digest) throw Error('Persistent contents or native metadata differ; both copies retained');
  if (local.fingerprint !== after.fingerprint) throw Error('Source changed during verification; both copies retained');
  if (remote.ephemeralSockets.length) throw Error('Destination contains runtime sockets; inspect before cutover');
  return { ...local, targetFingerprint: remote.fingerprint, implementationHash: implementation.hash };
}

// A completed independent content verification can be reused at cutover only while
// BOTH inode/ctime/size/name/native-root fingerprints are unchanged. This allows long
// reads before the maintenance pause; any intervening write forces a fresh full check.
export async function reuseStorageVerification(source, target, evidence, options = {}) {
  if (!evidence?.digest || !evidence.fingerprint || !evidence.targetFingerprint || !evidence.implementationHash) return null;
  const implementation = await manifestSnapshot(evidence.implementationHash);
  const fixed = { ...options, metadataOnly: true, workerFile: implementation.path };
  const local = await storageManifest(source, fixed);
  if (local.fingerprint !== evidence.fingerprint) return null;
  const remote = await storageManifest(target, fixed);
  return remote.fingerprint === evidence.targetFingerprint ? evidence : null;
}

export async function switchStorageRoot({ source, target, configFile, journal, save,
  evidence, checkUnused = assertUnused, verifyMetadata = storageManifest, checkMounted = assertLiveStorage }) {
  const config = validateLiveStorage(JSON.parse(await readFile(configFile, 'utf8')));
  const mapping = config.mappings.find(m => m.source === source && m.target === target);
  const transferOnly = evidence?.algorithm === 'transfer-receipt';
  if (!mapping || !(transferOnly || evidence?.digest) || source === dirname(source) || !inside(target, config.mount)) throw Error('Invalid cutover identity');
  if (transferOnly) await assertTransferReceipt(config, journal, evidence);
  const options = { ephemeralSockets: mapping.ephemeralSockets === true, metadataOnly: true };
  if (evidence.implementationHash) options.workerFile = (await manifestSnapshot(evidence.implementationHash)).path;
  if (await realpath(source) !== source || await realpath(target) !== target) throw Error('Cutover roots must be physical directories');
  const original = await lstat(source);
  if (!original.isDirectory() || original.ino !== journal.sourceInode || original.dev !== journal.sourceDevice) throw Error('Source identity changed');
  await checkUnused([source, target]);
  if (!transferOnly && (await verifyMetadata(source, options)).fingerprint !== evidence.fingerprint) throw Error('Source changed after verification');
  const quarantine = join(dirname(source), '.aios-migrated-' + journal.id + '-' + randomUUID());
  if (await lstat(quarantine).catch(() => null)) throw Error('Quarantine already exists');
  // Durable intent precedes the rename. The app fails closed during the small alias gap.
  await save({ state: 'switching', quarantine, verification: evidence });
  mapping.active = true;
  await durableJson(configFile, config);
  try { await rename(source, quarantine); }
  catch (error) {
    mapping.active = false;
    await durableJson(configFile, config);
    await save({ state: transferOnly ? 'transfer-checked' : 'verified', quarantine: null });
    throw error;
  }
  try { await symlink(target, source); }
  catch (error) {
    if (!await lstat(source).catch(() => null)) {
      await rename(quarantine, source);
      mapping.active = false; await durableJson(configFile, config);
      await save({ state: transferOnly ? 'transfer-checked' : 'verified', quarantine: null });
    }
    throw error;
  }
  await save({ state: 'switched', switchedAt: Date.now() });
  await checkMounted(source, config);
  await checkUnused([quarantine]);
  if (transferOnly) {
    // No recursive reread and, crucially, no deletion based on a transfer receipt.
    // Preserve the exact original inode as a separately recorded recovery copy.
    const held = await lstat(quarantine);
    if (!held.isDirectory() || held.ino !== original.ino || held.dev !== original.dev
        || await readlink(source) !== target) throw Error('Cutover identity changed; original retained');
    await save({ state: 'complete', completedAt: Date.now(), reclaimedBytes: 0, sourceRetained: true,
      retainedOriginal: { path: quarantine, inode: held.ino, device: held.dev,
        reason: 'Operator skipped content verification; original retained for recovery' }, quarantine: null });
    return { source, target, contentVerified: false, sourceRetained: true, retainedOriginal: quarantine };
  }
  if ((await verifyMetadata(quarantine, options)).fingerprint !== evidence.fingerprint) {
    throw Error('An old writer changed the retained local copy; do not remove it');
  }
  // The exact unique quarantine inode only. This is a redundant verified copy, never a
  // project/session deletion. Runtime sockets are inventoried in the verification record.
  if (dirname(quarantine) !== dirname(source) || !quarantine.includes('.aios-migrated-' + journal.id + '-')) throw Error('Unsafe quarantine');
  const held = await lstat(quarantine);
  if (!held.isDirectory() || held.ino !== original.ino || held.dev !== original.dev
      || await readlink(source) !== target) throw Error('Cutover identity changed; local copy retained');
  await save({ state: 'reclaiming', reclamationPermissions: 'owner-rwx-directories-only' });
  // Archived build/test outputs sometimes have owner-read-only directories.
  // Only AFTER verification and the alias switch, make this exact redundant
  // quarantine traversable/removable. Never follow symlinks or change live files.
  let writableDirectories = 0;
  async function prepareDuplicate(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.dev !== original.dev) throw Error('Quarantine directory identity changed; retained');
    if ((info.mode & 0o700) !== 0o700) {
      if (info.uid !== process.getuid()) throw Error('Read-only quarantine directory has another owner; retained');
      await chmod(directory, (info.mode & 0o7777) | 0o700);
      writableDirectories++;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await prepareDuplicate(join(directory, entry.name));
    }
  }
  await prepareDuplicate(quarantine);
  await checkUnused([quarantine]);
  const removable = await lstat(quarantine);
  if (removable.ino !== original.ino || removable.dev !== original.dev || await readlink(source) !== target) {
    throw Error('Reclamation identity changed; local duplicate retained');
  }
  await rm(quarantine, { recursive: true, force: false, maxRetries: 2 });
  await save({ state: 'complete', completedAt: Date.now(), reclaimedBytes: evidence.bytes, quarantine: null, writableDuplicateDirectories: writableDirectories });
  return { source, target, files: evidence.files, bytes: evidence.bytes, ephemeralSockets: evidence.ephemeralSockets.length };
}
