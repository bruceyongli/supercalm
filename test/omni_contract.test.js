import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nativeVoice, NATIVE_TTS_MODEL, wavFromPcm } from '../src/tts_native.js';
import { OmniSpeechClient, OmniAudioPlayer, consumeSpeech } from '../web/vendor/omni/omni-speech.mjs';
import { SUPPORTED_VOICES } from '../web/vendor/omni/voice-core.mjs';
import { createOmniInput } from '../src/omni_input.js';

// Omni integration 2026-10-08b. Lock the accepted paired upstream assets; future updates replace the whole
// package, never patch a private AIOS sound-fix implementation.
const hashes = {
  'voice-core.mjs': 'd1e79ed20d1183e8cb2ad49a8b555cbda5d803f8837dd6dad2815620b01a07aa',
  'omni-speech.mjs': '0103adede86a95b8eb7c7041db6535fa8a048c9f1d4a9ab985d9be3e2d15fa70',
  'voice-stream-client.mjs': '6c4b4ce7ea96cec0da5c768eddcb246aa11a7b6897e6d299cfb9c87aa9706ddb',
  'voice-stream-capture.mjs': '4b89a2736710ae82513f9f337e4e26b08d2c9811bfc44fd80dc7472709fadf31',
  'capture-worklet.js': 'b56fecf539965ad05206ad7e5a4ea0808b06dc3f1b80ba5fecd9ba955abdae19',
};
for (const [file, hash] of Object.entries(hashes)) assert.equal(createHash('sha256')
  .update(readFileSync(new URL('../web/vendor/omni/' + file, import.meta.url))).digest('hex'), hash);
for (const voice of SUPPORTED_VOICES) assert.equal(nativeVoice(voice), voice);
assert.equal(nativeVoice('auto'), 'Ryan');
assert.throws(() => nativeVoice('Vivian_Sichuan'), /no silent/);

// Recover a lost APP → PROXY creation acknowledgement, not just a browser ACK.
// The successful native session already exists: freeze its context and reserve
// its owner exactly once. HTTP capacity errors are terminal, not tight loops.
let preparations = 0, releases = 0, creations = 0, frozen;
const descriptor = { session_id: 'ab'.repeat(16), protocol: 'omni-voice-stream-v1' };
const input = createOmniInput({
  prepare: async voiceId => { preparations++; return { voiceId, alive: () => true, payload: { voice: 'Ryan', history: [{ role: 'user', content: 'Frozen plan' }] } }; },
  classify: () => ({ question: true }), answered() {}, released() { releases++; },
  request: async (method, _path, { body }) => {
    if (method === 'DELETE') return { status: 200, body: Buffer.from('{}') };
    creations++;
    if (!frozen) { frozen = structuredClone(body); throw new Error('Upstream creation ACK lost'); }
    assert.deepEqual(body, frozen, 'same client identity, speaker and context on recovery');
    return { status: 200, body: Buffer.from(JSON.stringify(descriptor)) };
  },
});
const options = { voiceId: 'v_fixture', client_session_id: 'cd'.repeat(16), model: 'omni-voice' };
await assert.rejects(input.start(options), error => error.status === 503);
assert.equal(releases, 0, 'short connection recovery preserves the reserved owner');
assert.deepEqual(await input.start(options), descriptor);
assert.deepEqual(await input.start({ ...options }), descriptor);
assert.equal(preparations, 1); assert.equal(creations, 2);
await input.control(descriptor.session_id, 'DELETE', '', {});
assert.equal(releases, 1);
let deniedRequests = 0, deniedReleases = 0;
const denied = createOmniInput({ prepare: async () => ({ alive: () => true }), classify() {}, answered() {},
  released() { deniedReleases++; }, request: async () => { deniedRequests++; return { status: 429, headers: { 'retry-after': '15' }, body: Buffer.from('{}') }; } });
await assert.rejects(denied.start(options), error => error.status === 429 && error.retryAfterMs === 15000);
await assert.rejects(denied.start(options), error => error.status === 429);
assert.equal(deniedRequests, 1); assert.equal(deniedReleases, 1);

const calls = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
  if (req.url.endsWith('/profile')) return res.end(JSON.stringify({ tts: { ready: true }, asr: { health: { state: 'unknown' } } }));
  if (req.url.endsWith('/busy')) { res.writeHead(429, { 'Retry-After': '15' }); return res.end('{"detail":"Voice busy"}'); }
  if (req.url.endsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    res.write('id: 1\nevent: text\ndata: {"delta":"中文"}\n\n');
    await new Promise(resolve => setTimeout(resolve, 30));
    res.end('id: 2\nevent: done\ndata: {}\n\n'); return;
  }
  res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.AIOS_PROXY_KEY = 'fixture-secret';
process.env.AIOS_OMNI_PROXY_BASE = `http://127.0.0.1:${server.address().port}/v1`;
process.env.AIOS_OMNI_NATIVE_BASE = `http://127.0.0.1:${server.address().port}`;
const { omniBase, omniRequest, omniProfile, omniHttpError } = await import('../src/omni_client.js');
try {
  const p = await omniProfile();
  assert.equal(p.tts.ready, true); assert.equal(p.asr.health.state, 'unknown');
  await omniProfile(); assert.equal(calls.length, 1, 'health coalesces/caches and does not infer');
  const rows = [];
  await omniRequest('GET', '/voice/events', { onChunk: chunk => rows.push(chunk.toString()) });
  assert.equal(rows.length, 2, 'SSE is relayed before response completion');
  assert.ok(rows[0].includes('id: 1'), 'event identity survives transport');
  await omniRequest('POST', '/audio/transcriptions', { body: Buffer.from('fixture PCM'), contentType: 'audio/wav' });
  await omniRequest('POST', '/api/speech/sessions', { native: true, body: { app_id: 'supercalm', voice: 'Ryan' } });
  assert.equal(calls.at(-1).auth, undefined, 'trusted private native tunnel receives no proxy credential');
  assert.equal(calls.at(-2).auth, 'Bearer fixture-secret');
  const busy = omniHttpError(await omniRequest('GET', '/voice/busy'));
  assert.equal(busy.status, 429); assert.equal(busy.retryAfterMs, 15000); assert.equal(busy.noFallback, true);
  process.env.AIOS_OMNI_PROXY_BASE = 'http://untrusted.example/v1';
  assert.throws(() => omniBase(), /trusted loopback/);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

// Scenario A supplies the complete text, not per-sentence TTS requests. A native
// done only finishes after playback drains; fixed speakers and tools stay scoped.
const nodes = [], inputs = [];
const context = { state: 'running', currentTime: 1, destination: {},
  createBuffer(_n, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; },
  createBufferSource() { const node = { playbackRate: { value: 2 }, connect() {}, disconnect() {},
    start(when) { this.when = when; }, stop() {} }; nodes.push(node); return node; } };
const frame = voice => ({ index: 0, voice, model: NATIVE_TTS_MODEL, prosody_profile: 'steady-v3',
  backend: 'faster-ggml', precision: 'BF16', streaming: 'native-pcm-frames', engine: 'qwen',
  phrase_index: 0, frame_index: 0, native_startup_one_frames: 2,
  audio: wavFromPcm(Buffer.from([1, 0, 2, 0])).toString('base64') });
for (const voice of SUPPORTED_VOICES) {
  const player = new OmniAudioPlayer(context, { voice }); player.enqueue(frame(voice));
  assert.equal(nodes.at(-1).playbackRate.value, 1); nodes.at(-1).onended();
  await player.drained();
}
const speech = new OmniSpeechClient({ context, voice: 'Serena', appId: 'supercalm', turnUrl: '/api/tts',
  fetcher: async (_url, options) => {
    inputs.push(JSON.parse(options.body));
    return new Response(`event: audio\ndata: ${JSON.stringify(frame('Serena'))}\n\nevent: done\ndata: {}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
let finished = false;
const speaking = speech.speak('First sentence. 中文句子。 v0.3.347.').then(() => { finished = true; });
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(inputs.length, 1); assert.equal(inputs[0].sentence_speech, false);
assert.equal(inputs[0].tts_only, true); assert.equal(inputs[0].voice, 'Serena');
assert.equal(finished, false, 'generation done is not playback done');
nodes.at(-1).onended(); await speaking;
assert.equal(finished, true);
await assert.rejects(consumeSpeech(new Response('event: retry\ndata: {"code":"llm_unavailable","retry_after_ms":15000}\n\n',
  { headers: { 'content-type': 'text/event-stream' } })), error => error.retry?.retry_after_ms === 15000);
console.log('omni_contract.test ok');
