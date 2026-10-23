// Recoverable, ordered append of a CLOSED temporary terminal spool. No truncation,
// no overwrite, and no creation of a destination when remote storage is missing.
import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { durableJson } from './storage_migration.js';

export async function mergeStorageLog(file) {
  const job = JSON.parse(await readFile(file, 'utf8'));
  if (job.version !== 1 || job.kind !== 'storage-log-handoff') throw Error('Invalid terminal handoff');
  const source = await open(job.spool, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target;
  try {
    target = await open(job.target, constants.O_RDWR | constants.O_NOFOLLOW);
    const src = await source.stat(), dst = await target.stat();
    if (!src.isFile() || !dst.isFile()) throw Error('Terminal logs must be regular files');
    const identity = { ino: src.ino, dev: src.dev, size: src.size, mtimeMs: src.mtimeMs, ctimeMs: src.ctimeMs };
    if (job.spoolIdentity && JSON.stringify(identity) !== JSON.stringify(job.spoolIdentity)) throw Error('Closed terminal spool changed');
    if (!job.spoolIdentity) {
      job.spoolIdentity = identity;
      job.targetIdentity = { ino: dst.ino, dev: dst.dev, start: dst.size };
      job.phase = 'merging'; await durableJson(file, job);
    }
    const initial = job.targetIdentity;
    if (dst.ino !== initial.ino || dst.dev !== initial.dev || dst.size < initial.start) throw Error('Terminal destination identity changed');
    const already = dst.size - initial.start;
    if (already > src.size && job.phase !== 'merged') throw Error('Unexpected output before spool recovery');
    const bytes = Buffer.alloc(1024 * 1024), check = Buffer.alloc(bytes.length);
    const digest = createHash('sha256');
    for (let at = 0; at < src.size;) {
      const { bytesRead } = await source.read(bytes, 0, Math.min(bytes.length, src.size - at), at);
      if (!bytesRead) throw Error('Short spool read');
      digest.update(bytes.subarray(0, bytesRead));
      const retained = Math.min(bytesRead, Math.max(0, already - at));
      if (retained) {
        const r = await target.read(check, 0, retained, initial.start + at);
        if (r.bytesRead !== retained || !check.subarray(0, retained).equals(bytes.subarray(0, retained))) throw Error('Existing spool prefix differs; both files retained');
      }
      for (let written = retained; written < bytesRead;) {
        const r = await target.write(bytes, written, bytesRead - written, initial.start + at + written);
        if (!r.bytesWritten) throw Error('Short spool write');
        written += r.bytesWritten;
      }
      at += bytesRead;
    }
    const after = await source.stat();
    if (after.size !== src.size || after.mtimeMs !== src.mtimeMs || after.ctimeMs !== src.ctimeMs) throw Error('Spool still has a writer');
    await target.sync();
    job.phase = 'merged'; job.digest = digest.digest('hex'); job.mergedAt ||= Date.now();
    await durableJson(file, job);
    return { bytes: src.size, recoveredPrefix: Math.min(already, src.size), digest: job.digest };
  } finally { await source.close(); await target?.close(); }
}
