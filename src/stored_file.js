// Only use after the existing session/file or render-grant authorization.
import { stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { archivedFile } from './artifact_archive.js';
import { archiveRequest, spawnArchiveWorker } from './archive_transport.js';

export async function storedFileInfo(sessionId, target) {
  try { return { info: await stat(target), archive: null }; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const archive = await archivedFile(sessionId, target);
    if (!archive) throw error;
    try {
      const info = await archiveRequest(archive.host, { op: 'stat', root: archive.remoteRoot, logicalRoot: archive.sourceRoot, path: archive.path });
      if (!info.canonicalRelative || isAbsolute(info.canonicalRelative) || info.canonicalRelative.split('/').includes('..')) throw new Error('Invalid archive member');
      return { info: { ...info, isDirectory: () => false, isFile: () => true }, archive: { ...archive, path: info.canonicalRelative },
        canonicalTarget: join(archive.sourceRoot, info.canonicalRelative) };
    } catch (cause) {
      throw Object.assign(new Error('Spark archive is unavailable. Your file is retained; retry when storage reconnects.', { cause }), { status: 503 });
    }
  }
}
export async function storedFileRead(target, file, limit) {
  const length = Math.min(file.info.size, limit);
  if (!length) return Buffer.alloc(0);
  if (file.archive) return archiveRequest(file.archive.host,
    { op: 'read', root: file.archive.remoteRoot, logicalRoot: file.archive.sourceRoot, path: file.archive.path, start: 0, end: length - 1 });
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
export function storedFileStream(target, file, range = {}) {
  if (file.archive) return spawnArchiveWorker(file.archive.host,
    { op: 'read', root: file.archive.remoteRoot, logicalRoot: file.archive.sourceRoot, path: file.archive.path, ...range },
    { timeoutMs: 10 * 60_000 });
  return createReadStream(target, range);
}
