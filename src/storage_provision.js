// Provision only NEW, explicitly configured project/worktree roots directly on storage.
// Existing folders are never moved here; operator migration owns their integrity/cutover.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, readFile, readlink, symlink, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { liveStorageConfigFile, validateLiveStorage, assertLiveStorage, isManagedStoragePath } from './live_storage.js';
import { assertUnused, durableJson } from './storage_migration.js';

export async function withStorageConfigLock(config, action) {
  if (!config.journalRoot || config.journalRoot.startsWith(config.mount + '/')) throw Error('Local storage journal is required');
  await mkdir(config.journalRoot, { recursive: true, mode: 0o700 });
  const lease = await open(join(config.journalRoot, 'config.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise((yes, no) => {
      const child = spawn('python3', ['-c', 'import fcntl\nfcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)'], { stdio: ['ignore', 'ignore', 'ignore', lease.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('error', e => { clearTimeout(timer); no(e); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? yes() : no(Object.assign(Error('Storage configuration is being updated; retry shortly'), { status: 409 })); });
    });
    return await action();
  } finally { await lease.close(); }
}

export async function provisionLiveStorageRoot(path, kind, options = {}) {
  const { configFile = liveStorageConfigFile(), checkMounted = assertLiveStorage,
    withConfigLock = withStorageConfigLock } = options;
  const followsActiveConfig = !Object.hasOwn(options, 'configFile');
  if (!configFile) return false;
  const read = async () => validateLiveStorage(JSON.parse(await readFile(configFile, 'utf8')));
  const config = await read(), source = resolve(path), name = basename(source);
  const policy = config.newRoots?.find(p => p.kind === kind && p.sourceParent === dirname(source));
  if (!policy || name.startsWith('.') || name === 'proxy' || policy.exclude?.includes(name)) return false;
  if (config.mappings.some(m => source === m.source || source.startsWith(m.source + '/'))) {
    await checkMounted(source, config);
    return false;
  }
  if (await lstat(source).catch(e => { if (e.code !== 'ENOENT') throw e; return null; })) return false;
  return withConfigLock(config, async () => {
    if (followsActiveConfig && liveStorageConfigFile() !== configFile) throw Error('Selected storage changed; retry provisioning');
    const current = await read();
    if (current.id !== config.id || current.mount !== config.mount || current.journalRoot !== config.journalRoot) throw Error('Storage configuration changed; retry provisioning');
    // Settings may have selected Local while this request was acquiring the lease.
    // Never use the pre-lock destination after its policy was disabled or replaced.
    const policy = current.newRoots?.find(p => p.kind === kind && p.sourceParent === dirname(source));
    if (!policy || policy.exclude?.includes(name)) return false;
    if (current.mappings.some(m => m.source === source)) { await checkMounted(source, current); return false; }
    if (await lstat(source).catch(e => { if (e.code !== 'ENOENT') throw e; return null; })) return false;
    const target = join(policy.targetParent, name);
    validateLiveStorage({ ...current, mappings: [...current.mappings, { source, target, active: true }] });
    await checkMounted(target, current);
    await checkMounted(dirname(source), current);
    if (!await isManagedStoragePath(dirname(source), { config: current, allowMissing: true })) throw Error('Storage parent is not an approved physical directory');
    await mkdir(dirname(source), { recursive: true, mode: 0o700 });
    if (await realpath(dirname(source)) !== dirname(source)
        || !await isManagedStoragePath(policy.targetParent, { config: current, allowMissing: true })) throw Error('Storage parent is not an approved physical directory');
    await mkdir(policy.targetParent, { recursive: true, mode: 0o700 });
    // Exclusive creation: a leftover/foreign target is evidence to inspect, never overwrite.
    await mkdir(target, { mode: 0o700 });
    current.mappings.push({ source, target, active: true, provisionedAt: Date.now(), provisionedKind: kind });
    await durableJson(configFile, current);
    // Fail closed if interrupted here; no local mkdir fallback can hide the registered target.
    await symlink(target, source);
    return true;
  });
}

// Called only from the existing authorized disposable-session cleanup path. A
// symlink rm alone would leave remote scratch orphaned and its mapping broken.
// Imported/manual roots and durable artifacts are deliberately not owned here.
export async function cleanupProvisionedSessionRoot(path, options = {}) {
  const { configFile = liveStorageConfigFile(), checkMounted = assertLiveStorage,
    checkUnused = assertUnused, removeTree = rm } = options;
  if (!configFile) return null;
  const read = async () => validateLiveStorage(JSON.parse(await readFile(configFile, 'utf8')));
  const config = await read(), source = resolve(path);
  if (!config.mappings.some(m => m.source === source)) return null;
  return withStorageConfigLock(config, async () => {
    if (!Object.hasOwn(options, 'configFile') && liveStorageConfigFile() !== configFile) throw Error('Selected storage changed; retry cleanup');
    const current = await read(), entry = current.mappings.find(m => m.source === source);
    if (!entry) return null;
    if (current.id !== config.id || current.mount !== config.mount || current.journalRoot !== config.journalRoot) throw Error('Storage configuration changed; retry cleanup');
    if (current.retainDuringMigration || current.preserveMigratedData) return { removed: false, reason: 'storage-migration' };
    if (!entry.active || entry.provisionedKind !== 'session' || !Number.isFinite(entry.provisionedAt)) {
      return { removed: false, reason: 'registered-storage' };
    }
    const inside = (path, root) => path === root || path.startsWith(root + '/');
    if (current.mappings.some(m => m !== entry && (inside(m.target, entry.target) || inside(entry.target, m.target)
        || inside(m.source, source)))) throw Error('Storage cleanup overlaps another registered root; files retained');
    await checkMounted(entry.target, current);
    const maybeStat = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const [logical, target] = await Promise.all([maybeStat(source), maybeStat(entry.target)]);
    if (logical && (!logical.isSymbolicLink() || resolve(dirname(source), await readlink(source)) !== entry.target)) throw Error('Storage alias changed; cleanup refused');
    if (target && (!target.isDirectory() || !await isManagedStoragePath(entry.target, { config: current }))) throw Error('Storage destination changed; cleanup refused');
    const same = (stat, identity) => stat && stat.dev === identity.dev && stat.ino === identity.ino;
    if (entry.disposableCleanup) {
      const proof = entry.disposableCleanup;
      if (proof.source !== source || proof.target !== entry.target
          || logical && !same(logical, proof.logical) || target && !same(target, proof.physical)) throw Error('Interrupted cleanup path identity changed; files retained');
    } else {
      if (!logical || !target) throw Error('Storage path is missing without a cleanup receipt; files retained');
      await checkUnused([source, entry.target]);
      entry.disposableCleanup = { startedAt: Date.now(), source, target: entry.target,
        logical: { dev: logical.dev, ino: logical.ino }, physical: { dev: target.dev, ino: target.ino } };
      // This receipt remains durable if target deletion or alias removal fails.
      await durableJson(configFile, current);
    }
    await checkUnused([source, entry.target]);
    const beforeRemoval = await maybeStat(entry.target);
    if (beforeRemoval && !same(beforeRemoval, entry.disposableCleanup.physical)) throw Error('Storage destination changed before cleanup; files retained');
    if (beforeRemoval) await removeTree(entry.target, { recursive: true, force: false, maxRetries: 2 });
    const beforeUnlink = await maybeStat(source);
    if (beforeUnlink && (!same(beforeUnlink, entry.disposableCleanup.logical) || !beforeUnlink.isSymbolicLink()
        || resolve(dirname(source), await readlink(source)) !== entry.target)) throw Error('Storage alias changed before cleanup; files retained');
    if (beforeUnlink) await unlink(source);
    current.mappings = current.mappings.filter(m => m !== entry);
    await durableJson(configFile, current);
    return { removed: true, path: source, remote: true };
  });
}
