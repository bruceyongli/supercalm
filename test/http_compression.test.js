import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createHttpCompressor } from '../src/http_compression.js';

const compress = createHttpCompressor();
const small = Buffer.from('真实报告与发送确认。'.repeat(3000));
const began = performance.now();
const zipped = await compress(small);
assert.deepEqual(gunzipSync(zipped), small);
console.log(JSON.stringify({ smallBodyBytes: small.length, compressedBytes: zipped.length,
  compressionMs: +(performance.now() - began).toFixed(2) }));
const large = Buffer.alloc(256 * 1024, 42);
assert.deepEqual(gunzipSync(await compress(large)), large);

let submitted = 0;
const pending = [];
const bounded = createHttpCompressor({ smallBytes: 16, maxPending: 2, waitMs: 20,
  async: () => { submitted++; return new Promise(resolve => pending.push(resolve)); } });
assert.equal(await bounded(large), null, 'slow compression returns plain bytes promptly');
assert.equal(await bounded(large), null);
assert.equal(await bounded(large), null);
assert.equal(submitted, 2, 'timed-out jobs cannot accumulate an unbounded queue of retained bodies');
pending[0](Buffer.from('late result'));
await new Promise(resolve => setImmediate(resolve));
assert.equal(await bounded(large), null);
assert.equal(submitted, 3, 'capacity is recovered only when actual background work settles');
for (const done of pending) done(null);
assert.equal(await createHttpCompressor({ sync: () => { throw Error('failed'); } })(small), null);
assert.equal(await createHttpCompressor({ smallBytes: 0, async: async () => { throw Error('failed'); } })(large), null);
console.log('http_compression: exact bytes, bounded small CPU work, large-body timeout/backpressure and fail-open passed');
