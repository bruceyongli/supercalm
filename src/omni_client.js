// Application transport only. Omni owns ASR/TTS, phrasing and playback; the shared
// proxy owns credentials/routing. Never send proxy credentials to a browser.
import http from 'node:http';
import { fleetKey, AIOS_PROXY_API_KEY } from './model_catalog.js';

const voiceAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const healthAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
export function omniBase(native = false) {
  const url = new URL(native ? process.env.AIOS_OMNI_NATIVE_BASE || 'http://127.0.0.1:18002'
    : process.env.AIOS_OMNI_PROXY_BASE || 'http://127.0.0.1:8792/v1');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error('Omni requires a trusted loopback backend');
  return url;
}

export async function omniConfigured() {
  const key = await fleetKey();
  return !!key && (key !== AIOS_PROXY_API_KEY || !!process.env.AIOS_PROXY_KEY || !!process.env.LOCAL_PROVIDER_PROXY_KEY);
}

export async function omniRequest(method, path, { body, contentType = 'application/json',
  signal, timeout = 60000, maxBytes = 18000000, onChunk, native = false, health = false } = {}) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Omni path');
  const base = omniBase(native), key = native ? null : await fleetKey();
  if (!native && !key) throw Object.assign(new Error('The local voice proxy is not configured'), { status: 503, noFallback: true });
  if (signal?.aborted) throw Object.assign(new Error('Voice request cancelled'), { name: 'AbortError' });
  const payload = body == null || Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = { accept: 'text/event-stream, application/json', 'X-Voice-Demo': '1',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(payload ? { 'content-type': contentType, 'content-length': payload.length } : {}) };
    const req = http.request({ hostname: base.hostname, port: base.port,
      path: base.pathname.replace(/\/$/, '') + path, method, headers,
      agent: health ? healthAgent : voiceAgent, timeout }, res => {
      let bytes = 0;
      const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) return req.destroy(new Error('Voice response exceeds limit'));
        if (onChunk && res.statusCode === 200) {
          try { onChunk(chunk, res); } catch (error) { req.destroy(error); }
        } else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Voice response interrupted')));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    const abort = () => req.destroy(Object.assign(new Error('Voice request cancelled'), { name: 'AbortError' }));
    req.on('error', reject);
    req.on('close', () => signal?.removeEventListener('abort', abort));
    req.on('timeout', () => req.destroy(new Error('Voice request timed out')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    req.end(payload);
  });
}

export function omniHttpError(response) {
  let message, data;
  try { data = JSON.parse(response.body.toString('utf8')); message = data.detail || data.error?.message || data.error; } catch {}
  const error = Object.assign(new Error(typeof message === 'string' ? message : response.status === 429
    ? 'Voice is busy. Your words are kept; retry when ready.' : 'Voice is temporarily unavailable. Your words are kept.'),
  { status: response.status, noFallback: true });
  const seconds = Number(response.headers?.['retry-after']);
  if (Number.isFinite(seconds) && seconds > 0) error.retryAfterMs = Math.min(30000, seconds * 1000);
  const delay = Number(data?.retry_after_ms || data?.error?.retry_after_ms);
  if (!error.retryAfterMs && Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(30000, delay);
  if (response.status === 429) error.retry = { code: 'voice_capacity_exceeded', message: error.message,
    retry_after_ms: error.retryAfterMs || 3000 };
  return error;
}

// Read-only health has a separate socket pool and never aborts accepted inference.
let cached, pending;
export async function omniProfile() {
  if (cached && cached.until > Date.now()) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    let value, available = false;
    try {
      const response = await omniRequest('GET', '/voice/profile', { health: true, timeout: 5000,
        signal: AbortSignal.timeout(5500), maxBytes: 128000 });
      if (response.status !== 200) throw omniHttpError(response);
      value = JSON.parse(response.body.toString('utf8')); available = true;
    } catch {
      value = Object.fromEntries(['asr', 'llm', 'tts'].map(name => [name,
        { ready: false, health: { state: 'unknown', reason: 'Voice profile connection could not be confirmed' } }]));
    }
    cached = { value, until: Date.now() + (available ? 10000 : 1000) };
    return value;
  })().finally(() => { pending = null; });
  return pending;
}
