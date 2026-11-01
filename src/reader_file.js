// Worker threads share libuv's four filesystem threads with HTTP compression, local assets and
// delivery receipts. A network read must occupy only its dedicated reader, not that shared pool.
// Direct/main-thread callers retain asynchronous IO; synchronous calls are worker-only.
import { isMainThread } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';

export async function openReaderFile(file) {
  if (isMainThread) return open(file, 'r');
  const fd = openSync(file, 'r');
  let closed = false;
  return {
    async stat() { return fstatSync(fd); },
    async read(buffer, offset, length, position) {
      return { buffer, bytesRead: readSync(fd, buffer, offset, length, position) };
    },
    async close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}
