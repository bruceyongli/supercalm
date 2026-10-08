import assert from 'node:assert/strict';
import { createPcmQueue, nativePcmSamples } from '../web/voice-stream.js';
import { wavFromPcm, NATIVE_TTS_MODEL } from '../src/tts_native.js';

const pcm = Buffer.alloc(4800); // 100 ms at the actual native sample rate
pcm.writeInt16LE(-32768, 0); pcm.writeInt16LE(16384, 2);
const audio = wavFromPcm(pcm).toString('base64');
assert.deepEqual([...nativePcmSamples(audio).slice(0, 2)], [-1, .5], 'streaming never changes PCM gain or samples');
assert.throws(() => nativePcmSamples(Buffer.from('not a WAV').toString('base64')), /Invalid/);
const sources = [], segments = [];
const context = {
  state: 'running', currentTime: 10, destination: {},
  createBuffer(_channels, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; },
  createBufferSource() {
    const node = { playbackRate: { value: 1 }, connect() {}, disconnect() {},
      start(when) { this.when = when; }, stop() { this.stopped = true; } };
    sources.push(node); return node;
  },
};
let ended = 0;
const queue = createPcmQueue(context, { rate: 1.75, onSegment: segment => segments.push(segment), onEmpty: () => ended++ });
const frame = (index, text = '') => ({ index, audio, text, model: NATIVE_TTS_MODEL, engine: 'qwen',
  backend: 'faster-ggml', precision: 'BF16', streaming: 'native-pcm-frames', voice: 'Ryan', prosody_profile: 'steady-v3',
  phrase_index: index === 2 ? 1 : 0, frame_index: index === 1 ? 1 : 0, native_startup_one_frames: 2 });
queue.push(frame(0, 'First phrase.'));
queue.push(frame(1)); queue.push(frame(2, 'Second phrase.'));
queue.push(frame(1));
assert.equal(sources.length, 3, 'duplicate transport packets cannot play twice');
assert.equal(sources[0].when, 10.6, 'the initial reserve matches Omni native BF16 cadence');
assert.ok(Math.abs(sources[1].when - 10.7) < 1e-8);
assert.ok(Math.abs(sources[2].when - 10.8) < 1e-8, 'a phrase boundary adds no pause to already queued audio');
assert.throws(() => queue.push(frame(4)), /order/);
assert.throws(() => queue.push({ ...frame(3), voice: 'Vivian' }), /identity/i);
assert.throws(() => queue.push({ ...frame(3), prosody_profile: 'legacy' }), /identity/i);
context.currentTime = 10.65;
queue.setRate(2);
assert.equal(sources.length, 3, 'a saved fast rate cannot resample or restart native speech');
assert.ok(sources.every(source => source.playbackRate.value === 1 && !source.stopped), 'native playback never raises pitch or drains the buffer too quickly');
queue.seal(); assert.equal(ended, 0, 'network completion does not mean playback completion');
context.currentTime = 11;
for (const node of sources) node.onended();
await Promise.resolve();
assert.equal(ended, 1);
assert.deepEqual(segments.map(segment => segment.text), ['First phrase.', 'Second phrase.']);
queue.stop();
const interrupted = createPcmQueue(context);
interrupted.push(frame(0, 'Only this phrase.')); interrupted.stop();
assert.equal(sources.at(-1).stopped, true, 'interruption stops every scheduled frame immediately');
assert.throws(() => interrupted.push(frame(1)), /closed/);
const late = createPcmQueue(context);
late.push(frame(0, 'First sentence.'));
context.currentTime += 2; // next model sentence arrives after the previous buffer ran out
late.push({ ...frame(1, 'Next sentence.'), phrase_index: 1, frame_index: 0 });
assert.ok(Math.abs(sources.at(-1).when - context.currentTime - .45) < 1e-8,
  'late phrase cadence is Omni’s shared policy, not an AIOS-specific sound fix');
late.stop();
console.log('voice_pcm_queue.test ok');
