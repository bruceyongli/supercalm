import { gzip, gzipSync } from 'node:zlib';
import { promisify } from 'node:util';

// Small JSON replies take sub-millisecond CPU, but async gzip can wait seconds behind native
// network-disk IO in libuv. Bound synchronous work strictly; larger bodies stay asynchronous and
// fall back to plain bytes instead of delaying headers indefinitely. Bound outstanding jobs too.
export function createHttpCompressor({ sync = gzipSync, async = promisify(gzip),
  smallBytes = 128 * 1024, waitMs = 150, maxPending = 4 } = {}) {
  let pending = 0;
  return async body => {
    if (body.length <= smallBytes) {
      try { return sync(body); } catch { return null; }
    }
    if (pending >= maxPending) return null;
    pending++;
    let timer;
    const work = Promise.resolve().then(() => async(body)).catch(() => null).finally(() => { pending--; });
    try {
      return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), waitMs); })]);
    } finally { clearTimeout(timer); }
  };
}

export const compressHttpBody = createHttpCompressor();
