// Omni's promoted /voice/api/turn tts_only transport emits tiny WAV frames, not MP3 phrases.
// Join PCM samples, never WAV headers, into one continuous iOS-compatible audio file. A partial,
// duplicate, wrong-model, or downgraded stream cannot be announced as a ready voice update.
export const NATIVE_TTS_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';

// Preparation happens on the server, before the browser's textForTts pass. Preserve that existing
// speech fix here too: dotted versions/dates/decimals are one phrase, never sentence stops.
export function textForPreparedSpeech(text) {
  return String(text || '').replace(/(\d)\.(?=\d)/g, '$1 point ').replace(/\s{2,}/g, ' ');
}

export function pcmFromWav(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid native WAV frame');
  let format = false, pcm = null;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated native WAV frame');
    if (name === 'fmt ') {
      if (size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt32LE(start + 4) !== 24000 || wav.readUInt16LE(start + 14) !== 16) throw new Error('Unexpected native PCM format');
      format = true;
    }
    if (name === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !pcm?.length || pcm.length % 2) throw new Error('Empty native PCM frame');
  return pcm;
}

export function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function nativeSpeechFromSse(body, expectedText) {
  const frames = []; let bytes = 0, complete = false, speaker = '';
  for (const block of body.toString('utf8').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!name || !raw) continue;
    const data = JSON.parse(raw);
    if (complete) throw new Error('Native audio after completion');
    if (name === 'error' || name === 'retry') throw new Error(data.message || 'Native TTS unavailable');
    if (name === 'audio') {
      if (data.model !== NATIVE_TTS_MODEL || data.precision !== 'BF16' || data.backend !== 'faster-ggml'
        || data.streaming !== 'native-pcm-frames' || data.engine !== 'qwen' || data.index !== frames.length
        || !['Ryan', 'Vivian'].includes(data.voice) || typeof data.audio !== 'string'
        || data.audio.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.audio)) throw new Error('Unexpected native TTS identity or frame order');
      const pcm = pcmFromWav(Buffer.from(data.audio, 'base64'));
      bytes += pcm.length;
      if (bytes > 12000000 || frames.length >= 10000) throw new Error('Native audio exceeds limit');
      frames.push(pcm); speaker = data.voice;
    }
    if (name === 'done') {
      if (!frames.length || data.text !== expectedText) throw new Error('Incomplete native TTS response');
      complete = true;
    }
  }
  if (!complete) throw new Error('Native TTS ended without completion');
  return { audio: wavFromPcm(Buffer.concat(frames)), headers: {
    'content-type': 'audio/wav', 'x-tts-engine': 'qwen3-tts-bf16', 'x-tts-model': NATIVE_TTS_MODEL,
    'x-tts-backend': 'faster-ggml', 'x-tts-precision': 'BF16', 'x-tts-speaker': speaker,
  } };
}
