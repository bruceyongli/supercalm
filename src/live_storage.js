// Explicit, operator-owned relocations. Logical session paths stay stable across storage moves.
// No DB import: this is also used by offline migration/restore and scratch-job commands.
import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { realpath, readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR, DB_PATH } from './config.js';

const inside = (path, root) => path === root || path.startsWith(root + sep);
export function validateLiveStorage(config) {
  if (!config || config.version !== 1 || !config.id || !Array.isArray(config.mappings)
      || !config.mount?.startsWith('/') || resolve(config.mount) !== config.mount
      || config.mount.split('/').filter(Boolean).length < 4) throw new Error('Invalid live storage configuration');
  for (const entry of config.mappings) {
    if (!entry.source?.startsWith('/') || resolve(entry.source) !== entry.source
        || entry.source.split('/').filter(Boolean).length < 3 || entry.source === homedir()
        || !entry.target?.startsWith(config.mount + '/') || resolve(entry.target) !== entry.target
        || inside(entry.source, config.mount) || inside(config.mount, entry.source)
        || inside(DB_PATH, entry.source) || /\/proxy(?:\/|$)/.test(entry.source)
        || /\.db(?:-|$)/.test(entry.source)) throw new Error('Unsafe live storage mapping');
    if (entry.active != null && typeof entry.active !== 'boolean') throw new Error('Invalid storage mapping state');
  }
  if (new Set(config.mappings.map(m => m.source)).size !== config.mappings.length) throw new Error('Duplicate storage source');
  if (new Set(config.mappings.map(m => m.target)).size !== config.mappings.length) throw new Error('Duplicate storage destination');
  if (config.statusFile && (!config.statusFile.startsWith('/') || inside(config.statusFile, config.mount))) throw new Error('Storage status must remain local');
  for (const policy of config.newRoots || []) {
    if (!['project', 'worktree', 'session', 'artifacts'].includes(policy.kind) || !policy.sourceParent?.startsWith('/')
        || resolve(policy.sourceParent) !== policy.sourceParent || policy.sourceParent.split('/').filter(Boolean).length < 2
        || !policy.targetParent?.startsWith(config.mount + '/') || resolve(policy.targetParent) !== policy.targetParent
        || inside(policy.sourceParent, config.mount) || inside(config.mount, policy.sourceParent) && policy.sourceParent !== homedir()
        || /\/proxy(?:\/|$)/.test(policy.sourceParent)
        || (policy.exclude && (!Array.isArray(policy.exclude) || policy.exclude.some(n => typeof n !== 'string' || n.includes('/'))))) {
      throw new Error('Unsafe new-storage-root policy');
    }
  }
  return config;
}
function unavailable(cause) {
  return Object.assign(new Error('Spark storage is unavailable. Files are preserved; reconnect storage before continuing. Local fallback is disabled.', { cause }),
    { code: 'storage-unavailable', status: 503 });
}
export function liveStorageConfigFile() {
  const file = process.env.AIOS_LIVE_STORAGE_CONFIG || join(DATA_DIR, 'live-storage.json');
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return value.configFile || file;
}
export function liveStorageConfig() {
  const file = liveStorageConfigFile();
  return file ? validateLiveStorage(JSON.parse(readFileSync(file, 'utf8'))) : null;
}
export function expectedStoragePath(path, config = liveStorageConfig()) {
  const logical = resolve(path);
  if (!config) return logical;
  const entry = config.mappings.filter(m => inside(logical, m.source)).sort((a, b) => b.source.length - a.source.length)[0];
  if (!entry) return logical;
  let info;
  try { info = lstatSync(entry.source); }
  catch (error) { if (error.code === 'ENOENT' && !entry.active) return logical; throw unavailable(error); }
  if (!info.isSymbolicLink()) {
    if (entry.active) throw unavailable(new Error('Migrated source link is missing or replaced'));
    return logical; // copying/planned, not cut over yet
  }
  const target = resolve(dirname(entry.source), readlinkSync(entry.source));
  if (target !== entry.target) throw unavailable(new Error('Managed storage link does not match its registered destination'));
  return entry.target + logical.slice(entry.source.length);
}
// Recover the stable report/grant name from a physical path only for an active,
// intact operator-registered alias. An arbitrary symlink never grants access.
export function logicalStoragePath(path, config = liveStorageConfig()) {
  const physical = resolve(path);
  const entry = config?.mappings.filter(m => m.active && inside(physical, m.target))
    .sort((a, b) => b.target.length - a.target.length)[0];
  if (!entry) return physical;
  const logical = entry.source + physical.slice(entry.target.length);
  return expectedStoragePath(logical, config) === physical ? logical : physical;
}
// Native CLIs may record getcwd() (the physical mount path), while AIOS retains the
// operator's logical path. Only an explicitly registered alias equates those identities.
export function sameStoragePath(left, right, config = liveStorageConfig()) {
  if (!left || !right) return false;
  if (resolve(left) === resolve(right)) return true;
  try { return expectedStoragePath(left, config) === expectedStoragePath(right, config); }
  catch { return false; }
}
export function storageMigrationProtected(path, config = liveStorageConfig()) {
  // "Migrate, don't delete" remains durable after migration completes. Future disposable
  // jobs may opt into their own retention policy without erasing the migrated corpus.
  return !!(config?.retainDuringMigration || config?.preserveMigratedData)
    && config.mappings.some(m => inside(resolve(path), m.source) || inside(resolve(path), m.target));
}
export async function isManagedStoragePath(path, { allowMissing = false, config = liveStorageConfig() } = {}) {
  const expected = expectedStoragePath(path, config);
  try { return await realpath(path) === expected; }
  catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing) return false;
    if (resolve(path) === dirname(resolve(path))) return false;
    return isManagedStoragePath(dirname(resolve(path)), { allowMissing, config });
  }
}
export async function assertLiveStorage(path, config = liveStorageConfig()) {
  if (!config) return;
  const expected = expectedStoragePath(path, config);
  if (!inside(expected, config.mount)) return; // unmigrated or deliberately local runtime state
  try {
    if (config.statusFile && !liveStorageStatus(config).available) throw new Error('Storage watcher has not confirmed a healthy connection');
    const [mount, parent, marker] = await Promise.all([
      stat(config.mount), stat(dirname(config.mount)), readFile(join(config.mount, '.aios-storage-id'), 'utf8'),
    ]);
    if (mount.dev === parent.dev || marker.trim() !== config.id) throw new Error('Storage volume identity mismatch');
  } catch (cause) {
    throw unavailable(cause);
  }
}

// Health reads the small local watcher record, never blocking HTTP on a lost network filesystem.
export function liveStorageStatus(config = liveStorageConfig(), now = Date.now()) {
  if (!config) return null;
  let result;
  try { result = JSON.parse(readFileSync(config.statusFile, 'utf8')); }
  catch { result = {}; }
  const fresh = result.id === config.id && Number.isFinite(result.checkedAt)
    && result.checkedAt <= now && now - result.checkedAt < 60_000;
  return { configured: true, available: fresh && result.available === true,
    checked_at: result.checkedAt || null, stale: !fresh,
    mount: config.mount, migrated_roots: config.mappings.filter(m => m.active).length,
    planned_roots: config.mappings.length, volume: fresh ? result.volume || null : null,
    backing: fresh ? result.backing || null : null,
    error: fresh ? result.error || null : 'Storage connection has not been verified recently' };
}
