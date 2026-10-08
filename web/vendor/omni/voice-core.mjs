export function encodeWav(samples, sourceRate, targetRate = 16000) {
  const count = Math.floor(samples.length * targetRate / sourceRate);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * sourceRate / targetRate);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * sourceRate / targetRate)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true);
  }
  return buffer;
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function fromBase64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer;
}

// A cooldown gate, never a retry scheduler. Only a user gesture consumes it.
export class ManualRetry {
  constructor(now = () => performance.now()) { this.now = now; this.clear(); }
  clear() { this.pending = null; this.after = 0; }
  set(payload, delayMs) {
    const delay = Number(delayMs);
    this.pending = payload;
    this.after = this.now() + (Number.isFinite(delay) ? Math.min(30000, Math.max(1000, delay)) : 1000);
  }
  get remainingMs() { return this.pending ? Math.max(0, this.after - this.now()) : 0; }
  take() {
    if (!this.pending || this.remainingMs > 0) return null;
    const payload = this.pending; this.clear(); return payload;
  }
}

export class SSEParser {
  constructor(callback) { this.buffer = ''; this.callback = callback; }
  feed(text) {
    this.buffer += text.replace(/\r/g, '');
    let end;
    while ((end = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      const lines = block.split('\n');
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
      if (data) this.callback(event, JSON.parse(data), id);
    }
    if (this.buffer.length > 6_000_000) throw new Error('The voice stream is too large.');
  }
}

export class VoiceActivity {
  constructor(rate, silenceMs = 1100) {
    this.rate = rate; this.silence = silenceMs / 1000; this.reset();
  }
  reset() { this.parts = []; this.prefix = []; this.prefixSamples = 0; this.samples = 0; this.voiced = 0; this.quiet = 0; this.started = false; }
  push(frame) {
    let sum = 0;
    for (const value of frame) sum += value * value;
    const rms = Math.sqrt(sum / Math.max(frame.length, 1));
    const duration = frame.length / this.rate;
    const active = rms > .012;
    if (!this.started) {
      this.prefix.push(frame); this.prefixSamples += frame.length;
      while (this.prefixSamples > this.rate * .35 && this.prefix.length > 1) this.prefixSamples -= this.prefix.shift().length;
      if (!active) return { rms, active: false };
      this.started = true; this.parts = [...this.prefix]; this.samples = this.prefixSamples;
      this.prefix = []; this.prefixSamples = 0;
    } else { this.parts.push(frame); this.samples += frame.length; }
    if (active) { this.voiced += duration; this.quiet = 0; } else this.quiet += duration;
    if (this.samples / this.rate >= 25 || this.quiet >= this.silence) {
      const samples = this.finish();
      return { rms, active: false, samples };
    }
    return { rms, active: true };
  }
  finish() {
    let merged = null;
    if (this.voiced >= .25) {
      merged = new Float32Array(this.samples);
      let offset = 0;
      for (const frame of this.parts) { merged.set(frame, offset); offset += frame.length; }
    }
    this.reset();
    return merged;
  }
}

// Keep the beginning of the next utterance while the echo-cancellation
// handoff settles. Defer VAD decisions, never discard newly captured speech.
export class CaptureHandoff {
  constructor(rate) { this.rate = rate; this.reset(); }
  reset() { this.until = 0; this.frames = []; this.samples = 0; }
  resume(now) { this.reset(); this.until = now + 350; }
  flush() {
    const frames = this.frames;
    this.reset();
    return frames;
  }
  push(frame, now) {
    if (!this.until) return [frame];
    this.frames.push(frame); this.samples += frame.length;
    // Audio duration also bounds memory if browser callbacks arrive late.
    if (now >= this.until || this.samples >= this.rate * .35) return this.flush();
    return [];
  }
}
// A speaker belongs to the conversation, never to a language or a phrase.
export const SUPPORTED_VOICES = Object.freeze(['Vivian', 'Serena', 'Sohee', 'Ryan', 'Uncle_Fu']);
export class ConversationVoice {
  constructor() { this.reset(); }
  reset() { this.voice = null; }
  select(choice, defaultVoice = 'Ryan') {
    if (this.voice) return this.voice;
    const selected = choice === 'auto' ? defaultVoice : choice;
    if (!SUPPORTED_VOICES.includes(selected)) throw new Error('Unsupported conversation voice.');
    return this.voice = selected;
  }
  verify(actual) {
    if (this.voice && actual !== this.voice) throw new Error('The voice changed unexpectedly. Playback stopped; no voice fallback.');
  }
}

export function voiceApiBase(pathname) {
  return /^\/(?:voice\/)?experiment\/?$/.test(pathname) ? '/voice/experiment' : '/voice';
}

export function playbackStart(currentTime, queuedUntil, data) {
  if (![currentTime, queuedUntil].every(value => Number.isFinite(value) && value >= 0))
    throw new Error('Invalid playback clock.');
  // The native decoder ramps up after its tiny first packet. Hold only each
  // phrase's first frame; later frames keep the existing contiguous queue.
  // This changes scheduling, never PCM, speech rate, gain or source silence.
  const nativeFirst = data.streaming === 'native-pcm-frames' && data.backend === 'faster-ggml' && data.frame_index === 0;
  // The accepted BF16 codec emits a tiny first packet before its larger ramp
  // packets. A 600 ms first-phrase reserve bridges the reviewed warm ramp without changing
  // PCM, rate or voice. Later phrases reuse already queued audio, or 450 ms.
  const earlyFirst = nativeFirst && data.phrase_index === 0 && data.precision === 'BF16'
    && data.native_startup_one_frames === 2;
  return Math.max(currentTime + (earlyFirst ? .60 : nativeFirst ? .45 : .03), queuedUntil);
}
