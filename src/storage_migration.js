// Operator-invoked storage cutover primitives. No database writes and no process termination.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, rename, symlink, lstat, readFile, readlink, realpath, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateLiveStorage, assertLiveStorage } from './live_storage.js';

const exec = promisify(execFile);
const worker = fileURLToPath(new URL('../scripts/storage-manifest.py', import.meta.url));
const inside = (p, root) => p === root || p.startsWith(root + sep);

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

export async function storageManifest(root, { metadataOnly = false, ephemeralSockets = false } = {}) {
  const args = [worker, root];
  if (metadataOnly) args.push('--metadata-only');
  if (ephemeralSockets) args.push('--ephemeral-sockets');
  const { stdout } = await exec('python3', args, { timeout: 12 * 3600_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function verifyStoragePair(source, target, options = {}) {
  const local = await storageManifest(source, options);
  const remote = await storageManifest(target, options);
  const after = await storageManifest(source, { ...options, metadataOnly: true });
  if (local.digest !== remote.digest) throw Error('Persistent contents or native metadata differ; both copies retained');
  if (local.fingerprint !== after.fingerprint) throw Error('Source changed during verification; both copies retained');
  if (remote.ephemeralSockets.length) throw Error('Destination contains runtime sockets; inspect before cutover');
  return local;
}

export async function switchStorageRoot({ source, target, configFile, journal, save,
  evidence, checkUnused = assertUnused, verifyMetadata = storageManifest, checkMounted = assertLiveStorage }) {
  const config = validateLiveStorage(JSON.parse(await readFile(configFile, 'utf8')));
  const mapping = config.mappings.find(m => m.source === source && m.target === target);
  if (!mapping || !evidence?.digest || source === dirname(source) || !inside(target, config.mount)) throw Error('Invalid cutover identity');
  const options = { ephemeralSockets: mapping.ephemeralSockets === true, metadataOnly: true };
  if (await realpath(source) !== source || await realpath(target) !== target) throw Error('Cutover roots must be physical directories');
  const original = await lstat(source);
  if (!original.isDirectory() || original.ino !== journal.sourceInode || original.dev !== journal.sourceDevice) throw Error('Source identity changed');
  await checkUnused([source, target]);
  if ((await verifyMetadata(source, options)).fingerprint !== evidence.fingerprint) throw Error('Source changed after verification');
  const quarantine = join(dirname(source), '.aios-migrated-' + journal.id + '-' + randomUUID());
  if (await lstat(quarantine).catch(() => null)) throw Error('Quarantine already exists');
  // Durable intent precedes the rename. The app fails closed during the small alias gap.
  await save({ state: 'switching', quarantine, verification: evidence });
  mapping.active = true;
  await durableJson(configFile, config);
  await rename(source, quarantine);
  try { await symlink(target, source); }
  catch (error) {
    if (!await lstat(source).catch(() => null)) {
      await rename(quarantine, source);
      mapping.active = false; await durableJson(configFile, config);
      await save({ state: 'verified', quarantine: null });
    }
    throw error;
  }
  await save({ state: 'switched', switchedAt: Date.now() });
  await checkMounted(source, config);
  await checkUnused([quarantine]);
  if ((await verifyMetadata(quarantine, options)).fingerprint !== evidence.fingerprint) {
    throw Error('An old writer changed the retained local copy; do not remove it');
  }
  // The exact unique quarantine inode only. This is a redundant verified copy, never a
  // project/session deletion. Runtime sockets are inventoried in the verification record.
  if (dirname(quarantine) !== dirname(source) || !quarantine.includes('.aios-migrated-' + journal.id + '-')) throw Error('Unsafe quarantine');
  const held = await lstat(quarantine);
  if (!held.isDirectory() || held.ino !== original.ino || held.dev !== original.dev
      || await readlink(source) !== target) throw Error('Cutover identity changed; local copy retained');
  await save({ state: 'reclaiming' });
  await rm(quarantine, { recursive: true, force: false, maxRetries: 2 });
  await save({ state: 'complete', completedAt: Date.now(), reclaimedBytes: evidence.bytes, quarantine: null });
  return { source, target, files: evidence.files, bytes: evidence.bytes, ephemeralSockets: evidence.ephemeralSockets.length };
}
