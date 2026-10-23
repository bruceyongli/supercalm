// Small local location records, not a second copy/cache of archived data. Originals keep their URLs.
import { readFile, readdir, mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { validateArchiveLocation } from './archive_transport.js';
import { worktreeRoot } from './worktrees.js';
import { isManagedStoragePath } from './live_storage.js';

export const archiveIndexRoot = join(DATA_DIR, 'artifact-archives');
const inside = (root, path) => path.startsWith(root + '/');
export function validateArchiveRecord(record) {
  if (!/^s_[a-zA-Z0-9_-]+$/.test(record.sessionId || '')) throw new Error('Invalid archive owner');
  const base = resolve(DATA_DIR, 'session-artifacts', record.sessionId);
  if (record.kind === 'worktree') {
    const parts = relative(resolve(worktreeRoot()), record.sourceRoot).split('/');
    if (!inside(resolve(worktreeRoot()), record.sourceRoot) || resolve(record.sourceRoot) !== record.sourceRoot
        || parts.length !== 2 || parts[1] !== record.sessionId || !isAbsolute(record.repoPath || '')) throw new Error('Archive must own its managed session worktree');
  } else if (record.kind != null || !inside(base, record.sourceRoot) || resolve(record.sourceRoot) !== record.sourceRoot
      || relative(base, record.sourceRoot).split('/').length !== 1) throw new Error('Archive must own one artifact subdirectory');
  validateArchiveLocation(record.host, record.remoteRoot);
  if (!/^[a-f0-9]{64}$/.test(record.digest || '') || !Number.isSafeInteger(record.bytes) || record.bytes < 0) throw new Error('Unverified archive');
  if (!['verified', 'archived'].includes(record.state)) throw new Error('Invalid archive state');
  return record;
}
export function archiveRecordId(sourceRoot) {
  return createHash('sha256').update(sourceRoot).digest('hex');
}
export async function saveArchiveRecord(record) {
  validateArchiveRecord(record);
  await mkdir(archiveIndexRoot, { recursive: true, mode: 0o700 });
  const target = join(archiveIndexRoot, `${archiveRecordId(record.sourceRoot)}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
  cachedUntil = 0;
}
let cached = [], cachedUntil = 0;
export async function archiveRecords({ fresh = false } = {}) {
  if (!fresh && Date.now() < cachedUntil) return cached;
  const entries = await readdir(archiveIndexRoot).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records = [];
  for (const name of entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const value = JSON.parse(await readFile(join(archiveIndexRoot, name), 'utf8'));
    records.push(validateArchiveRecord(value));
  }
  cached = records; cachedUntil = Date.now() + 5000;
  return records;
}
export async function archivedFile(sessionId, target) {
  if (!isAbsolute(target) || resolve(target) !== target) return null;
  const record = (await archiveRecords()).find(r => r.sessionId === sessionId && inside(r.sourceRoot, target));
  if (!record) return null;
  // A newly-created local ancestor symlink must not redirect the logical archive namespace.
  let parent = record.sourceRoot;
  const parts = relative(record.sourceRoot, target).split('/');
  for (const part of ['', ...parts.slice(0, -1)]) {
    if (part) parent = join(parent, part);
    try { if ((await lstat(parent)).isSymbolicLink()) return null; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const base = record.kind === 'worktree' ? resolve(worktreeRoot()) : join(DATA_DIR, 'session-artifacts', sessionId);
  if (!await isManagedStoragePath(base, { allowMissing: true })) return null;
  if (record.kind === 'worktree' && !await isManagedStoragePath(dirname(record.sourceRoot))) return null;
  return { ...record, path: relative(record.sourceRoot, target) };
}
export async function archiveStorageSummary() {
  const records = await archiveRecords();
  return { archives: records.filter(r => r.state === 'archived').map(r => ({
    session_id: r.sessionId, source: r.sourceRoot, host: r.host, bytes: r.bytes, archived_at: r.archivedAt,
  })), bytes: records.filter(r => r.state === 'archived').reduce((n, r) => n + r.bytes, 0) };
}
