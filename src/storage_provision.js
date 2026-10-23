// Provision only NEW, explicitly configured project/worktree roots directly on storage.
// Existing folders are never moved here; operator migration owns their integrity/cutover.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, readFile, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { liveStorageConfigFile, validateLiveStorage, assertLiveStorage, isManagedStoragePath } from './live_storage.js';
import { durableJson } from './storage_migration.js';

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

export async function provisionLiveStorageRoot(path, kind, {
  configFile = liveStorageConfigFile(), checkMounted = assertLiveStorage,
} = {}) {
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
  return withStorageConfigLock(config, async () => {
    const current = await read();
    if (current.mappings.some(m => m.source === source)) { await checkMounted(source, current); return false; }
    if (await lstat(source).catch(e => { if (e.code !== 'ENOENT') throw e; return null; })) return false;
    const target = join(policy.targetParent, name);
    validateLiveStorage({ ...current, mappings: [...current.mappings, { source, target, active: true }] });
    await checkMounted(target, current);
    if (await realpath(dirname(source)) !== dirname(source)
        || !await isManagedStoragePath(policy.targetParent, { config: current, allowMissing: true })) throw Error('Storage parent is not an approved physical directory');
    await mkdir(policy.targetParent, { recursive: true, mode: 0o700 });
    // Exclusive creation: a leftover/foreign target is evidence to inspect, never overwrite.
    await mkdir(target, { mode: 0o700 });
    current.mappings.push({ source, target, active: true, provisionedAt: Date.now() });
    await durableJson(configFile, current);
    // Fail closed if interrupted here; no local mkdir fallback can hide the registered target.
    await symlink(target, source);
    return true;
  });
}
