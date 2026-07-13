import https from 'node:https';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPARK, FFMPEG } from './config.js';
import { route, json, readBody } from './server.js';
import { getSpeech, getVoiceOverride } from './model_providers.js';

// Effective Spark connection = UI override (data/model_providers.json) merged over env (SPARK_IP/HOST),
// read at REQUEST time so edits hot-reload without a restart. sparkEnabled() also honors the "use" mute.
export function effectiveSpark() {
  const o = getVoiceOverride()?.spark || {};
  return { ip: o.ip || SPARK.ip, host: o.host || SPARK.host, port: SPARK.port };
}
export function sparkEnabled() {
  return !!effectiveSpark().ip && !getVoiceOverride()?.sparkDisabled;
}

// Reuse TLS connections to Spark across requests (STT + TTS) so we don't pay a fresh
// handshake each time. Measured small (~30ms) since latency is generation-bound, but free.
const sparkAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const STT_POLISH_DEFAULT = /^(1|true|yes|on)$/i.test(process.env.AIOS_STT_POLISH || 'false');
const STT_FORCE_TRANSCODE = /^(1|true|yes|on)$/i.test(process.env.AIOS_STT_TRANSCODE || 'false');

// Fallback normalizer for unsupported/failed uploads. Spark production accepts compressed
// browser audio directly, but 16 kHz mono WAV remains the safest retry format.
async function toWav(audio, ext) {
  const dir = await mkdtemp(join(tmpdir(), 'aios-stt-'));
  const inp = join(dir, 'in.' + ext);
  const out = join(dir, 'out.wav');
  try {
    await writeFile(inp, audio);
    await new Promise((resolve, reject) => {
      let err = '';
      const ff = spawn(FFMPEG, ['-y', '-hide_banner', '-i', inp, '-ac', '1', '-ar', '16000', '-f', 'wav', out], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      ff.stderr.on('data', (d) => (err += d));
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').slice(-3).join(' | ').slice(-400)}`))));
    });
    return await readFile(out);
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Spark dictation is tailnet-only and MagicDNS does not resolve on host, so we
// connect to the IP while overriding SNI + Host so the Tailscale-Serve TLS cert
// and vhost routing match. rejectUnauthorized stays on (cert is valid for SPARK.host).
export function sparkRequest(method, path, { body, contentType, timeout = 60000 } = {}) {
  const spark = effectiveSpark();
  return new Promise((resolve, reject) => {
    const headers = { Host: spark.host };
    if (body) {
      headers['content-type'] = contentType;
      headers['content-length'] = body.length;
    }
    const req = https.request(
      { host: spark.ip, port: spark.port, path, method, servername: spark.host, headers, timeout, agent: sparkAgent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers || {}, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('spark request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function extFor(ct = '') {
  const m = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' };
  return m[ct.split(';')[0].trim()] || 'webm';
}

function baseContentType(ct = '') {
  return ct.split(';')[0].trim().toLowerCase();
}

function sparkAcceptsAudio(ct = '') {
  return new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg']).has(baseContentType(ct));
}

function buildMultipart(fields, fileField, fileBuf, filename, fileType) {
  const boundary = '----aios' + randomBytes(10).toString('hex');
  const pre = [];
  for (const [k, v] of Object.entries(fields)) {
    pre.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  pre.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${fileType}\r\n\r\n`);
  const body = Buffer.concat([Buffer.from(pre.join('')), fileBuf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function boolQuery(req, name, fallback) {
  const value = new URL(req.url, 'http://aios.local').searchParams.get(name);
  if (value == null) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

async function transcribeWithSpark({ audio, contentType, language, polish }) {
  const ext = extFor(contentType);
  const { body, contentType: multipartType } = buildMultipart(
    { language, polish: String(polish), response_format: 'json' },
    'file',
    audio,
    `speech.${ext}`,
    baseContentType(contentType) || 'application/octet-stream'
  );
  return sparkRequest('POST', '/v1/audio/transcriptions', { body, contentType: multipartType });
}

// OpenAI-compatible speech provider (Settings → Voice): the no-Spark STT path. Same multipart
// shape as Spark; `language` omitted when 'auto' (OpenAI rejects it), bearer only when a key exists.
async function transcribeWithProvider(sp, { audio, contentType, language }) {
  const ext = extFor(contentType);
  const fields = { model: sp.stt_model || 'whisper-1', response_format: 'json' };
  if (language && language !== 'auto') fields.language = language;
  const { body, contentType: multipartType } = buildMultipart(
    fields, 'file', audio, `speech.${ext}`, baseContentType(contentType) || 'application/octet-stream'
  );
  const r = await fetch(sp.base_url + '/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'content-type': multipartType, ...(sp.api_key ? { authorization: `Bearer ${sp.api_key}` } : {}) },
    body,
    signal: AbortSignal.timeout(120000),
  });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
}

// Browser records audio and POSTs the raw bytes here; we forward to Spark's
// recommended multipart transcription endpoint and return { text }.
route('POST', '/api/transcribe', async (req, res) => {
  const ct = req.headers['content-type'] || 'audio/webm';
  const url = new URL(req.url, 'http://aios.local');
  const language = url.searchParams.get('language') || 'auto';
  const polish = boolQuery(req, 'polish', STT_POLISH_DEFAULT);
  let audio;
  try {
    audio = await readBody(req, 40 * 1024 * 1024);
  } catch (e) {
    return json(res, 413, { error: 'audio too large' });
  }
  if (audio.length < 500) return json(res, 400, { error: 'no audio captured — the recording was empty' });
  console.error('[aios] transcribe: ct=%s bytes=%d', ct, audio.length);

  const speech = getSpeech({ redact: false });
  const providerConfigured = !!(speech?.enabled && speech.base_url);
  // ?backend=provider forces the speech-provider path (Settings → Voice) even when Spark is
  // configured — the Settings test button and ops checks prove the provider STT works end-to-end.
  const forceProvider = url.searchParams.get('backend') === 'provider';
  const sparkConfigured = sparkEnabled() && !forceProvider;
  if (!sparkConfigured && !providerConfigured) {
    return json(res, 502, { error: 'no speech-to-text configured — add a speech provider in Settings → Voice (or set SPARK_IP/SPARK_HOST)' });
  }
  let r;
  let usedTranscode = false;
  let backend = sparkConfigured ? 'spark' : 'provider';
  try {
    if (sparkConfigured) {
      if (!STT_FORCE_TRANSCODE && sparkAcceptsAudio(ct)) {
        r = await transcribeWithSpark({ audio, contentType: ct, language, polish });
      }
      if (!r || r.status >= 400) {
        if (r && r.status >= 400) console.error('[aios] transcribe direct spark failed:', r.status, r.body.toString('utf8').slice(0, 180));
        const wav = await toWav(audio, extFor(ct));
        usedTranscode = true;
        r = await transcribeWithSpark({ audio: wav, contentType: 'audio/wav', language, polish });
      }
      if (r.status >= 400 && providerConfigured) { r = null; backend = 'provider'; } // Spark down -> provider carries it
    }
    if (!r && providerConfigured) {
      r = await transcribeWithProvider(speech, { audio, contentType: ct, language });
      if (r.status >= 400) {
        // some local servers only take wav — one transcode retry (skipped cleanly if ffmpeg is absent)
        try {
          const wav = await toWav(audio, extFor(ct));
          usedTranscode = true;
          r = await transcribeWithProvider(speech, { audio: wav, contentType: 'audio/wav', language });
        } catch {}
      }
    }
    const txt = r.body.toString('utf8');
    if (r.status >= 400) return json(res, 502, { error: `${backend} stt ${r.status}: ${txt.slice(0, 300)}` });
    let payload = {};
    try {
      payload = JSON.parse(txt);
    } catch {
      payload = { text: txt };
    }
    const text = polish
      ? payload.polished_text || payload.text || payload.raw_text || ''
      : payload.raw_text || payload.text || '';
    json(res, 200, {
      text: String(text).trim(),
      raw_text: payload.raw_text || '',
      polished_text: payload.polished_text || '',
      language: payload.language || language,
      timings: payload.timings || undefined,
      polish,
      transcoded: usedTranscode,
      backend,
    });
  } catch (e) {
    json(res, 502, { error: 'transcription failed: ' + e.message });
  }
});

// Diagnostics: confirm Supercalm -> Spark reachability.
route('GET', '/api/spark/health', async (req, res) => {
  const spark = effectiveSpark();
  try {
    const r = await sparkRequest('GET', '/api/health', { timeout: 8000 });
    json(res, r.status < 400 ? 200 : 502, { status: r.status, body: r.body.toString('utf8').slice(0, 300), via: `${spark.ip} (sni ${spark.host})` });
  } catch (e) {
    json(res, 502, { error: e.message, via: `${spark.ip}` });
  }
});

console.log('[aios] spark transcription proxy ready');
