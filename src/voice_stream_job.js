import { createGzip, constants } from 'node:zlib';
const retained = new Set(); // <= 8 journals × 18 MB; not an unbounded audio cache

// A bounded journal for ONE read-only generation. Reattaching a mobile reader never calls a model.
// Slow readers have their own cursor/backpressure; they cannot block upstream text generation.
export function createVoiceStreamJob({ requestId, controller, orphanMs = 10000, maxBytes = 18000000, ttlMs = 360000 } = {}) {
  if (retained.size >= 8) throw Object.assign(new Error('Voice replay capacity is full. Please retry later.'), { status: 429 });
  const events = [], readers = new Set(), waiters = new Set();
  let bytes = 0, closed = false, released = false, expired = false, orphan = null;
  const job = { requestId, controller, text: '', stage: 'thinking', timings: {}, resumes: 0,
    get closed() { return closed; }, get released() { return released; }, get bytes() { return bytes; },
    append(event, data) {
      if (closed || released) return;
      const sequence = events.length + 1;
      const wire = `id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const size = Buffer.byteLength(wire);
      if (event !== 'error' && bytes + size > maxBytes) throw new Error('Voice replay buffer exceeds limit');
      bytes += size; events.push({ sequence, wire });
      if (event === 'text') job.text += String(data.delta || '');
      if (event === 'stage') job.stage = String(data.stage || job.stage);
      for (const key of ['llm_queue_wait_ms', 'llm_first_token_ms', 'llm_complete_ms', 'first_audio_ms', 'total_ms']) {
        if (Number.isFinite(data[key])) job.timings[key] = data[key];
      }
      if (event === 'done' || event === 'error') {
        closed = true; job.stage = event === 'done' ? 'complete' : 'failed';
        if (event === 'error') job.error = data.detail || data.message || 'Voice unavailable';
        clearTimeout(orphan);
      }
      for (const wake of [...waiters]) wake();
    },
    cancel(reason = 'Voice playback stopped') {
      controller.abort();
      if (!closed) job.append('error', { detail: reason, cancelled: true });
    },
    dispose(reason = 'Voice conversation ended') {
      expired = true; job.cancel(reason);
      for (const reader of [...readers]) reader.res.destroy();
      job.release();
    },
    release() {
      if (readers.size || !closed) return false;
      released = true; events.length = 0; bytes = 0; clearTimeout(expiry); retained.delete(job); return true;
    },
    attach(res, { after = 0, compressed = false } = {}) {
      if (released) return false;
      if (!Number.isSafeInteger(after) || after < 0 || after > events.length) throw new Error('Invalid voice resume cursor');
      if (readers.size >= 3) throw Object.assign(new Error('Too many readers for this voice report'), { status: 429 });
      clearTimeout(orphan);
      if (after) job.resumes++;
      const reader = { res }; readers.add(reader);
      let gone = false, waking = null;
      const gzip = compressed ? createGzip({ level: 1, flush: constants.Z_SYNC_FLUSH }) : null;
      const output = gzip || res;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store',
        'x-aios-voice-resumable': '1', vary: 'accept-encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
      res.flushHeaders?.();
      if (gzip) { gzip.on('error', () => res.destroy()); gzip.pipe(res); }
      const detach = () => {
        if (gone) return;
        gone = true; readers.delete(reader); waking?.(); gzip?.destroy();
        res.off('close', detach); res.off('error', detach);
        if (expired && !readers.size && closed) job.release();
        if (!closed && !readers.size) {
          orphan = setTimeout(() => job.cancel('Voice connection was not resumed'), orphanMs); orphan.unref?.();
        }
      };
      res.on('close', detach); res.on('error', detach);
      const write = async wire => {
        if (gone || res.destroyed) return false;
        if (!output.write(wire)) await new Promise(resolve => {
          const done = () => { output.off('drain', done); res.off('close', done); res.off('error', done); resolve(); };
          output.once('drain', done); res.once('close', done); res.once('error', done);
        });
        return !gone;
      };
      (async () => {
        let cursor = after;
        try {
          // A short initial marker starts the response immediately, before evidence/model work.
          await write(': voice-connected\n\n');
          while (!gone) {
            while (!gone && cursor < events.length) {
              const entry = events[cursor];
              if (!await write(entry.wire)) return;
              cursor = entry.sequence;
            }
            if (closed) { output.end(); return; }
            await new Promise(resolve => {
              const timer = setTimeout(() => wake(true), 5000);
              const wake = heartbeat => {
                clearTimeout(timer); waiters.delete(wake); waking = null;
                if (heartbeat && !gone) output.write(': voice-waiting\n\n');
                resolve();
              };
              waking = wake; waiters.add(wake);
            });
          }
        } catch { res.destroy(); }
      })();
      return true;
    },
  };
  retained.add(job);
  const expiry = setTimeout(() => job.dispose('Voice stream expired'), ttlMs); expiry.unref?.();
  return job;
}
