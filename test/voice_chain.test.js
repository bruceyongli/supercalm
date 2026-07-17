import assert from 'node:assert/strict';
import { resolveChain, normalizeAgentHint } from '../src/voice_chain.js';

// ---- agent hint parsing ----
assert.equal(normalizeAgentHint('Codex'), 'codex');
assert.equal(normalizeAgentHint('claude'), 'claude');
assert.equal(normalizeAgentHint('agy'), null); // agy has no subscription STT
assert.equal(normalizeAgentHint(''), null);
assert.equal(normalizeAgentHint(undefined), null);

// Availability fixture: everything present + capable.
const AV = {
  spark: { caps: { tts: true, stt: true }, available: true, location: 'tailnet' },
  codex: { caps: { tts: false, stt: true }, available: true, location: 'cloud' },
  claude: { caps: { tts: false, stt: true }, available: false, location: 'cloud' }, // never available
  cloud: { caps: { tts: true, stt: true }, available: true, location: 'cloud' },
  macos: { caps: { tts: true, stt: false }, available: true, location: 'server' },
  browser: { caps: { tts: true, stt: true }, available: true, location: 'browser' },
};
const stt = (o) => resolveChain({ capability: 'stt', avail: AV, ...o });
const tts = (o) => resolveChain({ capability: 'tts', avail: AV, ...o });

// ---- STT ----
// match-agent resolves to the hinted agent's provider, then fallbacks
assert.deepEqual(stt({ primary: 'match-agent', fallbacks: ['spark', 'browser'], agentHint: 'codex' }), ['codex', 'spark', 'browser']);
// match-agent with no hint contributes nothing → just the fallbacks
assert.deepEqual(stt({ primary: 'match-agent', fallbacks: ['spark', 'browser'], agentHint: null }), ['spark', 'browser']);
// match-agent → claude, but claude is unavailable → dropped, fallbacks follow (NO cross to codex)
assert.deepEqual(stt({ primary: 'match-agent', fallbacks: ['spark', 'browser'], agentHint: 'claude' }), ['spark', 'browser']);
// a pinned primary
assert.deepEqual(stt({ primary: 'codex', fallbacks: ['spark'] }), ['codex', 'spark']);
// macos has no STT capability → filtered out even if listed
assert.deepEqual(stt({ primary: 'spark', fallbacks: ['macos', 'browser'] }), ['spark', 'browser']);
// unavailable providers dropped, order preserved, deduped
assert.deepEqual(stt({ primary: 'codex', fallbacks: ['codex', 'spark', 'spark', 'browser'], avail: { ...AV, spark: { ...AV.spark, available: false } } }), ['codex', 'browser']);
// a bare match-agent in fallbacks is ignored (only meaningful as primary policy)
assert.deepEqual(stt({ primary: 'spark', fallbacks: ['match-agent', 'browser'] }), ['spark', 'browser']);

// ---- TTS ----
// codex has no TTS capability → never in a TTS chain
assert.deepEqual(tts({ primary: 'spark', fallbacks: ['codex', 'macos', 'browser'] }), ['spark', 'macos', 'browser']);
assert.deepEqual(tts({ primary: 'cloud', fallbacks: ['spark', 'macos'] }), ['cloud', 'spark', 'macos']);
// match-agent is STT-only → as a TTS primary it contributes nothing
assert.deepEqual(tts({ primary: 'match-agent', fallbacks: ['macos'], agentHint: 'codex' }), ['macos']);
// muted spark (unavailable) drops out of the TTS chain
assert.deepEqual(tts({ primary: 'spark', fallbacks: ['macos'], avail: { ...AV, spark: { ...AV.spark, available: false } } }), ['macos']);
// empty when nothing capable/available
assert.deepEqual(tts({ primary: 'spark', fallbacks: [], avail: { spark: { caps: { tts: true, stt: true }, available: false } } }), []);

console.log('voice_chain.test ok');
