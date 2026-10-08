import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createGunzip, gunzipSync } from 'node:zlib';
import { createVoiceStreamJob } from '../src/voice_stream_job.js';
import { nativeSpeechFromSse, wavFromPcm, NATIVE_TTS_MODEL } from '../src/tts_native.js';

const tiny = createVoiceStreamJob({ controller: new AbortController(), maxBytes: 300 });
assert.throws(() => tiny.append('text', { delta: 'x'.repeat(500) }), /exceeds limit/);
tiny.cancel(); assert.equal(tiny.closed, true); assert.equal(tiny.release(), true);
const retry = createVoiceStreamJob({ controller: new AbortController(), maxBytes: 1 });
retry.append('retry', { code: 'llm_unavailable', message: 'Reply service is busy', retry_after_ms: 15000 });
assert.equal(retry.closed, true); assert.equal(retry.stage, 'failed');
assert.equal(retry.error, 'Reply service is busy');
assert.equal(retry.release(), true, 'retry is a terminal result even when the replay buffer is full');
const ctrl = new AbortController(), job = createVoiceStreamJob({ controller: ctrl });
const text = 'The exact voice samples must survive compression.';
const pcm = Buffer.alloc(48000);
for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(i * Math.PI * 2 * 331 / 24000)), i * 2);
job.append('metadata', { transport: 'native-pcm-frames' }); job.append('text', { delta: text });
job.append('audio', { index: 0, audio: wavFromPcm(pcm).toString('base64'), model: NATIVE_TTS_MODEL, precision: 'BF16',
  backend: 'faster-ggml', streaming: 'native-pcm-frames', engine: 'qwen', voice: 'Vivian', prosody_profile: 'steady-v3', text });
job.append('done', { text });
assert.throws(() => job.attach({}, { after: 99 }), /cursor/);
const incremental = createVoiceStreamJob({ controller: new AbortController() });
const server = createServer((req, res) => {
  if (req.url === '/incremental') incremental.attach(res, { compressed: true });
  else job.attach(res, { compressed: req.headers['accept-encoding'] === 'gzip' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const get = encoding => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { 'accept-encoding': encoding } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
  }); req.on('error', reject); req.end();
});
try {
  const raw = await get('identity'), zipped = await get('gzip');
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(zipped.body), raw.body);
  assert.deepEqual(nativeSpeechFromSse(gunzipSync(zipped.body), null, { voice: 'Vivian' }).audio, wavFromPcm(pcm),
    'lossless wire compression does not change pitch, samples or speaker');
  assert.ok(zipped.body.length < raw.body.length * .8, 'compression removes substantial PCM/Base64/protocol overhead');
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/incremental' }, res => {
      const gunzip = createGunzip(); let content = '', observed = false;
      res.pipe(gunzip); gunzip.on('error', reject);
      gunzip.on('data', chunk => {
        content += chunk;
        if (!observed && content.includes('early words')) {
          observed = true;
          assert.equal(incremental.closed, false, 'gzip must flush text before generation finishes');
          incremental.append('done', { text: 'early words' });
        }
      });
      gunzip.on('end', resolve);
    }); req.on('error', reject); req.end();
    incremental.append('text', { delta: 'early words' });
  });
  console.log('voice_stream_job trace', JSON.stringify({ pass: true, rawBytes: raw.body.length, compressedBytes: zipped.body.length,
    reductionPercent: Math.round(100 * (1 - zipped.body.length / raw.body.length)), identicalPcm: true, earlyTextFlushed: true }));
} finally {
  job.cancel(); job.release(); incremental.cancel(); incremental.release();
  await new Promise(resolve => server.close(resolve));
}

// Disconnected readers leave generation alive briefly, but abandoned/expired journals never leak.
const lifecycle = [];
const boundedServer = createServer((req, res) => lifecycle[Number(req.url.slice(1))].attach(res));
await new Promise(resolve => boundedServer.listen(0, '127.0.0.1', resolve));
const connect = index => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: boundedServer.address().port, path: '/' + index }, res => {
    res.on('error', () => {}); res.once('data', () => resolve(res));
  }); req.on('error', reject); req.end();
});
try {
  const controller = new AbortController();
  lifecycle.push(createVoiceStreamJob({ controller, orphanMs: 250, ttlMs: 2000 }));
  const reader = await connect(0); reader.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(controller.signal.aborted, false, 'a short disconnect must not cancel generation');
  const resumed = await connect(0);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(controller.signal.aborted, false, 'reattachment clears the orphan timer');
  resumed.destroy();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(controller.signal.aborted, true, 'an abandoned generation is eventually cancelled');
  assert.equal(lifecycle[0].closed, true); assert.equal(lifecycle[0].release(), true);

  const expiring = createVoiceStreamJob({ controller: new AbortController(), ttlMs: 150 }); lifecycle.push(expiring);
  const active = await connect(1);
  await new Promise(resolve => active.once('close', resolve));
  // Client close can precede the server's close callback by an event-loop turn.
  for (let n = 0; n < 50 && !expiring.released; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(expiring.controller.signal.aborted, true);
  assert.equal(expiring.released, true, 'TTL frees its journal even when a reader was connected');

  const disposed = createVoiceStreamJob({ controller: new AbortController() }); lifecycle.push(disposed);
  const liveReader = await connect(2); disposed.dispose();
  await new Promise(resolve => liveReader.once('close', resolve));
  for (let n = 0; n < 50 && !disposed.released; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(disposed.released, true, 'ending a call immediately frees its replay capacity, not six minutes later');

  const capacity = Array.from({ length: 8 }, () => createVoiceStreamJob({ controller: new AbortController() }));
  lifecycle.push(...capacity);
  assert.throws(() => createVoiceStreamJob({ controller: new AbortController() }), error => error.status === 429);
  for (const entry of capacity) { entry.cancel(); entry.release(); }
  const replacement = createVoiceStreamJob({ controller: new AbortController() }); replacement.cancel(); replacement.release();
  console.log('voice_stream_job lifecycle', JSON.stringify({ pass: true, orphanCancelled: true, resumeKeptGeneration: true,
    expiredReaderReleased: true, maxJournals: 8, capacityRecovered: true }));
} finally {
  for (const entry of lifecycle) { entry.cancel(); entry.release(); }
  await new Promise(resolve => boundedServer.close(resolve));
}
