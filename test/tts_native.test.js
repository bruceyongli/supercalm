import assert from 'node:assert/strict';
import { NATIVE_TTS_MODEL, createNativeSpeechDecoder, nativeTextParts, nativeSpeechFromSse, pcmFromWav, wavFromPcm, textForPreparedSpeech } from '../src/tts_native.js';

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
const incremental = createNativeSpeechDecoder('中文第一句。 Second phrase.');
const firstPhrase = Buffer.from(event('audio', { ...frame(0), text: '中文第一句。' }));
const lastPhrase = event('audio', { ...frame(1), text: 'Second phrase.' });
const streamed = [];
for (const byte of firstPhrase) streamed.push(...incremental.feed(Buffer.from([byte])));
assert.equal(streamed[0].data.text, '中文第一句。', 'UTF-8 and SSE can split at every byte');
assert.equal(streamed[0].data.start, 0, 'the first frame is available before done');
incremental.feed(Buffer.from(lastPhrase + event('done', { text: '中文第一句。 Second phrase.' })));
const ready = incremental.finish();
assert.equal(ready.segments.length, 2);
assert.equal(ready.segments[1].start, pcm.length / 48000, 'prepared reading timestamps come from PCM sample counts');
assert.deepEqual(nativeTextParts('One complete reply. ' + '中文'.repeat(100)), ['One complete reply. ' + '中文'.repeat(100)],
  'ordinary replies are sent whole instead of chopped into manual phrases');
assert.equal(nativeTextParts('中'.repeat(2001)).length, 2, 'only gateway hard transport limits require another request');
console.log('tts_native.test ok');
