import assert from 'node:assert/strict';
import { VOICE_CHAIN, chatJson } from '../src/llm.js';

assert.equal(VOICE_CHAIN[0].model, 'gpt-5.6-luna', 'voice starts with the verified low-latency JSON route');

const denied = { port: 45501, model: 'voice-denied-regression' };
const healthy = { port: 45502, model: 'voice-healthy-regression' };
const chain = [denied, healthy];
let calls = [];
const call = async (entry) => {
  calls.push(entry.model);
  if (entry === denied) throw new Error('403 permission denied');
  return '{"say":"Ready.","action":"await","message":""}';
};

let result = await chatJson([], {}, chain, call);
assert.equal(result.model, healthy.model);
assert.deepEqual(calls, [denied.model, healthy.model]);

calls = [];
result = await chatJson([], {}, chain, call);
assert.equal(result.model, healthy.model);
assert.deepEqual(calls, [healthy.model], 'a known 403 route is skipped during its cooldown');

console.log('llm_voice_fallback.test ok');
