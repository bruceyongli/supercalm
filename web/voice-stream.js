// Omni's native 24 kHz PCM frames are one speech stream, not individual Audio-element clips.
// Schedule buffers on one audio clock. No text splitting, silence insertion or guessed timing.
export function nativePcmSamples(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 700000) throw new Error('Oversize speech frame');
  const raw = atob(encoded), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const word = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || word(0) !== 'RIFF' || word(8) !== 'WAVE') throw new Error('Invalid speech WAV');
  let pcm, format = false;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true), start = at + 8;
    if (start + size > bytes.length) throw new Error('Truncated speech frame');
    if (word(at) === 'fmt ') {
      if (size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint32(start + 4, true) !== 24000 || view.getUint16(start + 14, true) !== 16) throw new Error('Unexpected speech PCM format');
      format = true;
    }
    if (word(at) === 'data') pcm = { start, size };
    at = start + size + size % 2;
  }
  if (!format || !pcm?.size || pcm.size % 2) throw new Error('Empty speech frame');
  const samples = new Float32Array(pcm.size / 2);
  for (let at = 0; at < samples.length; at++) samples[at] = view.getInt16(pcm.start + at * 2, true) / 32768;
  return samples;
}

export function createPcmQueue(context, { rate = 1, voice, onSegment, onStarted, onEmpty } = {}) {
  const records = new Set(), seen = new Set();
  let until = 0, stopped = false, sealed = false, last = -1, speaker = voice;
  const announce = record => {
    if (stopped || record.announced) return;
    // iOS can suspend its audio clock when backgrounded. A wall-clock timer alone is not proof
    // that playback happened, and must not advance the reading marker ahead of the actual audio.
    if (context.state !== 'running' || context.currentTime < record.start) {
      record.timer = setTimeout(() => announce(record), 30); return;
    }
    record.announced = true; onStarted?.();
    if (record.data.text) onSegment?.({ text: record.data.text, index: record.data.segmentIndex ?? record.data.phrase_index ?? record.data.index });
  };
  const schedule = (record, when) => {
    const node = context.createBufferSource(); node.buffer = record.buffer;
    node.playbackRate.value = rate; node.connect(context.destination);
    record.node = node; record.start = when; record.end = when + (record.buffer.duration - record.offset) / rate;
    node.onended = () => {
      node.disconnect();
      if (record.node !== node || stopped) return;
      clearTimeout(record.timer); announce(record); clearTimeout(record.timer);
      records.delete(record);
      if (sealed && !records.size) onEmpty?.();
    };
    record.timer = setTimeout(() => announce(record), Math.max(0, (when - context.currentTime) * 1000));
    node.start(when, record.offset); until = record.end;
  };
  return {
    push(data) {
      if (stopped || sealed) throw new Error('Speech queue is closed');
      if (seen.has(data.index)) return; // transport replay cannot repeat a spoken frame
      if (data.index !== last + 1 || data.model !== 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'
        || data.precision !== 'BF16' || data.backend !== 'faster-ggml' || data.streaming !== 'native-pcm-frames'
        || data.engine !== 'qwen' || !['Ryan', 'Vivian'].includes(data.voice)
        || (speaker && speaker !== data.voice) || data.prosody_profile !== 'steady-v3') throw new Error('Unexpected native speech identity or frame order');
      speaker = data.voice;
      const samples = nativePcmSamples(data.audio);
      const buffer = context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
      const { audio, ...metadata } = data;
      const record = { buffer, data: metadata, offset: 0, announced: false };
      const first = data.frame_index === 0;
      const reserve = first && data.phrase_index === 0 && data.native_startup_one_frames === 2 ? .6 : first ? .45 : .03;
      const when = Math.max(context.currentTime + reserve, until);
      if (when - context.currentTime > 250) throw new Error('Speech queue exceeds limit');
      records.add(record); schedule(record, when); seen.add(data.index); last = data.index;
    },
    seal() { sealed = true; if (!records.size) onEmpty?.(); },
    setRate(value) {
      if (stopped || value === rate || !Number.isFinite(value) || value <= 0) return;
      const now = context.currentTime;
      const pending = [...records].sort((a, b) => a.start - b.start);
      for (const record of pending) {
        if (record.start < now) record.offset = Math.min(record.buffer.duration, record.offset + (now - record.start) * rate);
        clearTimeout(record.timer);
        const old = record.node; record.node = null; old.onended = null; old.stop(); old.disconnect();
      }
      rate = value; until = now + .01;
      for (const record of pending) {
        if (record.offset >= record.buffer.duration) { records.delete(record); continue; }
        schedule(record, until);
      }
      if (sealed && !records.size) onEmpty?.();
    },
    stop() {
      stopped = true;
      for (const record of records) {
        clearTimeout(record.timer); record.node.onended = null;
        try { record.node.stop(); record.node.disconnect(); } catch {}
      }
      records.clear();
    },
  };
}
