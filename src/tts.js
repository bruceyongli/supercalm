import http from 'node:http';
import https from 'node:https';
import { route, json, readJson } from './server.js';
import { sparkRequest, sparkEnabled, effectiveSpark } from './spark.js';
import { getSpeech, getVoiceOverride, getVoiceConfig } from './model_providers.js';
import { resolveChain } from './voice_chain.js';
import { voiceProviders, availabilityMap } from './voice_providers.js';

// TTS for the voice concierge. Two backends:
//   'spark' (default) — Spark server TTS at /v1/audio/speech, reached via tailnet IP+SNI
//                       (reusing spark.js sparkRequest; MagicDNS fails on host). English
//                       defaults to Kokoro realtime TTS; Qwen remains available via
//                       AIOS_TTS_ENGINE=qwen or a per-request model/engine override.
//   'local'           — the macOS `say` + ffmpeg service on host (fast, robotic).
// Spark is primary; on ANY Spark failure we fall back to local say, and the browser has
// speechSynthesis as a final fallback so the voice loop does not die from one outage.
// Flip the default instantly with AIOS_TTS_BACKEND=local (no redeploy needed).
const TTS_PORT = Number(process.env.AIOS_TTS_PORT || 17071);
const ENV_TTS_VOICE = process.env.AIOS_TTS_VOICE || '';
const TTS_ENGINE = normalizeEngine(process.env.AIOS_TTS_ENGINE || process.env.AIOS_TTS_MODEL || 'kokoro');
const TTS_VOICE = ENV_TTS_VOICE || defaultVoiceForEngine(TTS_ENGINE);
const TTS_INSTRUCT = process.env.AIOS_TTS_INSTRUCT ?? ''; // Qwen CustomVoice style; ignored for Kokoro.
const LOCAL_VOICE = process.env.AIOS_LOCAL_TTS_VOICE || 'alloy'; // safe alias for the macOS-say fallback
const TTS_BACKEND = (process.env.AIOS_TTS_BACKEND || 'spark').toLowerCase();
const TTS_FORMATS = new Set(['mp3', 'wav', 'aac', 'aiff', 'flac', 'opus', 'pcm']);

// The live TTS chain config, for Settings → Voice to SHOW what's actually active (developers were told
// "Spark is configured" but saw an empty form — this surfaces the real service). All env-derived.
export function voiceConfig() {
  const ov = getVoiceOverride();
  const o = ov?.spark || {};
  const ttsEngine = normalizeEngine(o.ttsEngine || TTS_ENGINE);
  const ttsVoice = o.ttsVoice || (o.ttsEngine ? defaultVoiceForEngine(ttsEngine) : TTS_VOICE);
  return { backend: TTS_BACKEND, ttsEngine, ttsVoice, ttsInstruct: (o.ttsInstruct ?? TTS_INSTRUCT), localTtsPort: TTS_PORT, localVoice: LOCAL_VOICE, sparkDisabled: !!ov?.sparkDisabled };
}

function normalizeEngine(engine) {
  const value = String(engine || '').trim().toLowerCase();
  if (value === 'qwen' || value === 'quality') return 'qwen';
  return 'kokoro';
}

function defaultVoiceForEngine(engine) {
  if (ENV_TTS_VOICE) return ENV_TTS_VOICE;
  return normalizeEngine(engine) === 'qwen' ? 'Ryan' : 'af_heart';
}

function normalizeFormat(format) {
  const value = String(format || '').trim().toLowerCase();
  return TTS_FORMATS.has(value) ? value : 'mp3';
}

function mediaTypeForFormat(format) {
  return {
    aac: 'audio/aac',
    aiff: 'audio/aiff',
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    opus: 'audio/ogg; codecs=opus',
    pcm: 'audio/pcm',
    wav: 'audio/wav',
  }[normalizeFormat(format)] || 'audio/mpeg';
}

function sparkTtsBody(text, { engine = TTS_ENGINE, voice = defaultVoiceForEngine(engine), format = 'mp3', stream = false, instruct = '' } = {}) {
  const normalizedEngine = normalizeEngine(engine);
  const body = {
    input: text,
    model: normalizedEngine,
    voice,
    response_format: normalizeFormat(format),
  };
  if (stream) body.low_latency = false;
  // Qwen CustomVoice style: per-request instruct (e.g. the voice-report persona) wins over env.
  const style = String(instruct || TTS_INSTRUCT || '').slice(0, 300);
  if (normalizedEngine === 'qwen' && style) body.instruct = style;
  return body;
}

function proxyTtsHeaders(upstreamHeaders = {}, source = 'spark', format = 'mp3') {
  const out = {
    'content-type': upstreamHeaders['content-type'] || mediaTypeForFormat(format),
    'cache-control': 'no-store',
    'x-aios-tts-source': source,
  };
  for (const name of ['x-tts-engine', 'x-tts-backend', 'x-tts-model', 'x-tts-speaker', 'x-tts-language', 'x-tts-timings']) {
    if (upstreamHeaders[name]) out[name] = upstreamHeaders[name];
  }
  return out;
}

// Spark TTS -> full audio buffer (the client downloads the whole blob anyway).
// 25s bound (was 60s): the browser aborts single-shot TTS at ~60s total, so a slow Spark must fail
// early enough for the provider (25s) / local-say (20s) fallbacks to still land inside that window.
async function speakSpark(text, voice, engine, format, instruct = '') {
  const body = sparkTtsBody(text, { voice, engine, format, instruct });
  const payload = Buffer.from(JSON.stringify(body));
  const r = await sparkRequest('POST', '/v1/audio/speech', { body: payload, contentType: 'application/json', timeout: 25000 });
  if ((r.status || 0) >= 400) throw new Error(`spark tts ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`);
  if (!r.body || r.body.length < 200) throw new Error('spark tts returned empty audio');
  return { audio: r.body, headers: r.headers || {} };
}

// Local macOS `say` service on host -> full mp3 buffer. Uses a known-safe alias (the Spark
// speaker name like "Serena" may not be valid here), so the fallback never breaks on voice.
function speakLocal(text) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: 'tts-local', voice: LOCAL_VOICE, input: text, response_format: 'mp3', speed: 1.0 }));
    const up = http.request(
      { host: '127.0.0.1', port: TTS_PORT, path: '/v1/audio/speech', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length }, timeout: 20000 },
      (r) => {
        const ch = [];
        r.on('data', (c) => ch.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(ch);
          if ((r.statusCode || 0) >= 400) return reject(new Error(`local tts ${r.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
          resolve(buf);
        });
      }
    );
    up.on('error', reject);
    up.on('timeout', () => up.destroy(new Error('local tts timeout')));
    up.write(payload);
    up.end();
  });
}

// OpenAI-compatible /v1/audio/speech (the Settings → Voice speech provider): the no-Spark TTS path —
// OpenAI/local Kokoro-FastAPI/openedai-speech/speaches all speak this shape. Speaking-style
// `instructions` (per-request instruct wins over the saved config) go out only when set: OpenAI's
// newer TTS (gpt-4o-mini-tts+) honors them; servers that don't know the param never see it.
async function speakProvider(sp, text, format, instruct = '') {
  const style = String(instruct || sp.tts_instructions || '').slice(0, 300);
  const r = await fetch(sp.base_url + '/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sp.api_key ? { authorization: `Bearer ${sp.api_key}` } : {}) },
    body: JSON.stringify({ model: sp.tts_model || 'tts-1', input: text, voice: sp.tts_voice || 'alloy', response_format: format, ...(style ? { instructions: style } : {}) }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`provider tts ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return { audio: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || '' };
}

// Which server-side TTS providers to try, in order. Normally the resolved TTS chain (Speaks selection),
// filtered to the ones the SERVER can run (spark/cloud/macos — 'browser' is client-side). A `b.backend`
// value forces ONE provider (the Settings/ops Test buttons: spark | provider/api → cloud | local → macos).
async function ttsServerChain(b) {
  const forced = b.backend ? ({ spark: 'spark', provider: 'cloud', api: 'cloud', local: 'macos' })[b.backend] : null;
  if (forced) return [forced];
  const avail = availabilityMap(await voiceProviders());
  const cfg = getVoiceConfig();
  return resolveChain({ capability: 'tts', primary: cfg.tts.primary, fallbacks: cfg.tts.fallbacks, avail })
    .filter((id) => id !== 'browser'); // browser TTS is the client's job
}

// Browser POSTs text here; we synthesize and return mp3, walking the resolved TTS chain with fallback.
route('POST', '/api/tts', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  const text = String(b.text || '').slice(0, 4000);
  if (!text.trim()) return json(res, 400, { error: 'text required' });
  const vc = voiceConfig(); // effective Spark TTS voice/engine (override merged over env)
  const engine = normalizeEngine(b.engine || b.model || vc.ttsEngine);
  const format = normalizeFormat(b.response_format || b.format || 'mp3');
  const voice = b.voice || ((b.engine || b.model) ? defaultVoiceForEngine(engine) : vc.ttsVoice);

  const chain = await ttsServerChain(b);
  let audio = null, responseHeaders = null, lastErr = '';
  for (const name of chain) {
    try {
      if (name === 'spark') {
        if (!sparkEnabled()) continue;
        const r = await speakSpark(text, voice, engine, format, b.instruct ?? vc.ttsInstruct);
        audio = r.audio; responseHeaders = proxyTtsHeaders(r.headers, 'spark', format); break;
      }
      if (name === 'cloud') {
        const speech = getSpeech({ redact: false });
        if (!(speech?.enabled && speech.base_url)) continue;
        const r = await speakProvider(speech, text, format, b.instruct);
        audio = r.audio; responseHeaders = proxyTtsHeaders({}, 'api', format);
        responseHeaders['x-tts-backend'] = 'api'; responseHeaders['x-tts-engine'] = speech.tts_model || 'tts-1';
        if (r.contentType) responseHeaders['content-type'] = r.contentType; break;
      }
      if (name === 'macos') {
        audio = await speakLocal(text); responseHeaders = proxyTtsHeaders({}, 'local', 'mp3');
        responseHeaders['x-tts-engine'] = 'local'; responseHeaders['x-tts-backend'] = 'macos-say'; break;
      }
    } catch (e) {
      lastErr = e.message; console.error(`[aios] tts ${name} failed, falling through:`, e.message);
    }
  }
  if (!audio) return json(res, 502, { error: 'tts unavailable: ' + (lastErr || 'no server TTS provider available — using device voice') });
  res.writeHead(200, responseHeaders || proxyTtsHeaders({}, 'unknown'));
  res.end(audio);
});

// Streaming TTS: proxy Spark's sentence-chunked SSE (/v1/audio/speech/stream) straight to
// the browser so it can play sentence 1 (~1s) while later sentences still generate. Events:
// `metadata`, `chunk` ({audio_base64,index,text,...}), `done`, `error`. Spark-only; if the
// backend is local or Spark fails to START the stream, we 409/502 and the client falls back
// to single-shot /api/tts. Chunks are self-contained audio files (own duration header → iOS-safe).
route('POST', '/api/tts/stream', async (req, res) => {
  const b = await readJson(req).catch(() => ({}));
  const text = String(b.text || '').slice(0, 4000);
  if (!text.trim()) return json(res, 400, { error: 'text required' });
  // Streaming only works via Spark, so it kicks in only when Spark is the EFFECTIVE primary server-TTS
  // (the resolved TTS chain leads with spark). Otherwise 409 → the client uses single-shot /api/tts,
  // which walks the full chain (cloud/macos). So a user whose Speaks primary is cloud never gets spark
  // audio on long text.
  const vc = voiceConfig();
  const chain = await ttsServerChain(b);
  if (chain[0] !== 'spark' || !sparkEnabled()) return json(res, 409, { error: 'streaming requires the spark backend' });
  const engine = normalizeEngine(b.engine || b.model || vc.ttsEngine);
  const format = normalizeFormat(b.response_format || b.format || 'mp3');
  const voice = b.voice || ((b.engine || b.model) ? defaultVoiceForEngine(engine) : vc.ttsVoice);
  const streamBody = sparkTtsBody(text, { engine, voice, format, stream: true, instruct: b.instruct ?? vc.ttsInstruct });
  const payload = Buffer.from(JSON.stringify(streamBody));
  const spark = effectiveSpark();
  const up = https.request(
    { host: spark.ip, port: spark.port, path: '/v1/audio/speech/stream', method: 'POST', servername: spark.host,
      headers: { Host: spark.host, 'content-type': 'application/json', 'content-length': payload.length, accept: 'text/event-stream' }, timeout: 60000 },
    (r) => {
      if ((r.statusCode || 0) >= 400) {
        const ch = [];
        r.on('data', (c) => ch.push(c));
        r.on('end', () => json(res, 502, { error: `spark stream ${r.statusCode}: ${Buffer.concat(ch).toString('utf8').slice(0, 200)}` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-aios-tts-source': 'spark' });
      r.pipe(res);
      r.on('error', () => { try { res.end(); } catch {} });
    }
  );
  up.on('error', (e) => { if (!res.headersSent) json(res, 502, { error: 'spark stream unreachable: ' + e.message }); });
  up.on('timeout', () => up.destroy(new Error('spark stream timeout')));
  // client hung up mid-stream -> stop pulling from Spark. 'close' also fires after a COMPLETED
  // request on some Node versions — only tear the upstream down if we hadn't finished responding.
  req.on('close', () => { if (!res.writableEnded) { try { up.destroy(); } catch {} } });
  up.write(payload);
  up.end();
});

function localHealth() {
  return new Promise((resolve) => {
    const up = http.request({ host: '127.0.0.1', port: TTS_PORT, path: '/api/health', method: 'GET', timeout: 6000 }, (r) => {
      const ch = [];
      r.on('data', (c) => ch.push(c));
      r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch { resolve(null); } });
    });
    up.on('error', () => resolve(null));
    up.on('timeout', () => { up.destroy(); resolve(null); });
    up.end();
  });
}

route('GET', '/api/tts/health', async (req, res) => {
  const vc = voiceConfig(); // effective config, not raw env — health must describe what /api/tts actually does
  if (vc.backend === 'spark' && sparkEnabled()) {
    try {
      const r = await sparkRequest('GET', '/api/health', { timeout: 8000 });
      const h = JSON.parse(r.body.toString('utf8'));
      return json(res, 200, { ok: true, backend: 'spark', engine: vc.ttsEngine, voice: vc.ttsVoice, tts_available: !!h.tts_available, tts_base_url: h.tts_base_url });
    } catch (e) {
      return json(res, 502, { ok: false, backend: 'spark', error: e.message });
    }
  }
  const h = await localHealth();
  json(res, h ? 200 : 502, { ok: !!h, backend: 'local', tts_available: !!(h && h.tts_available), engine: h && h.tts_engine });
});

console.log(`[aios] tts proxy ready (backend=${TTS_BACKEND}${TTS_BACKEND === 'spark' ? ` -> Spark ${TTS_ENGINE} TTS, local say fallback` : ` -> 127.0.0.1:${TTS_PORT} say`})`);
