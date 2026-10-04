import assert from 'node:assert/strict';
import { NATIVE_TTS_MODEL, nativeSpeechFromSse, pcmFromWav, wavFromPcm, textForPreparedSpeech } from '../src/tts_native.js';

const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
assert.equal(textForPreparedSpeech('Release v0.3.292 on 2026.07.22 costs 3.14.'),
  'Release v0 point 3 point 292 on 2026 point 07 point 22 costs 3 point 14.',
  'server-prepared audio retains the dotted-number fix even though it bypasses the browser TTS request');
const frame = index => ({ index, audio: wavFromPcm(pcm).toString('base64'), model: NATIVE_TTS_MODEL,
  precision: 'BF16', backend: 'faster-ggml', engine: 'qwen', streaming: 'native-pcm-frames', voice: 'Ryan' });
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const completed = event('done', { text: 'A whole update.' });
const good = event('audio', frame(0)) + event('audio', frame(1)) + completed;
const output = nativeSpeechFromSse(Buffer.from(good), 'A whole update.');
assert.deepEqual(pcmFromWav(output.audio), Buffer.concat([pcm, pcm]), 'PCM frames become one file without embedded WAV headers or invented pauses');
assert.equal(output.headers['x-tts-precision'], 'BF16');
for (const changed of [{ precision: 'Q8_0' }, { model: 'kokoro' }, { backend: 'torch' }, { index: 1 }]) {
  assert.throws(() => nativeSpeechFromSse(Buffer.from(event('audio', { ...frame(0), ...changed }) + completed), 'A whole update.'), /identity|order/);
}
assert.throws(() => nativeSpeechFromSse(Buffer.from(event('audio', frame(0))), 'A whole update.'), /without completion/);
assert.throws(() => nativeSpeechFromSse(Buffer.from(event('audio', frame(0)) + event('audio', frame(0)) + completed), 'A whole update.'), /order/);
assert.throws(() => nativeSpeechFromSse(Buffer.from(good), 'Wrong report.'), /Incomplete/);
assert.throws(() => pcmFromWav(output.audio.subarray(0, 46)), /Truncated/);
console.log('tts_native.test ok');
