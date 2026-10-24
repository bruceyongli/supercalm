import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the production function with deterministic slow I/O, without reading
// any real native conversation or waiting for its 30-second cache lifetime.
const source = await readFile(new URL('../src/sessions.js', import.meta.url), 'utf8');
const implementation = source.slice(source.indexOf('async function sessionTranscriptEvidence(s) {'),
  source.indexOf('\nasync function streamMentionsFile('));
assert.ok(implementation.includes('sessionTranscriptEvidencePending'));
let now = 1000, calls = 0, release;
let gate = new Promise(resolve => { release = resolve; });
let fail = false;
const cache = new Map(), pending = new Map();
const context = vm.createContext({
  Date: { now: () => now },
  SESSION_FILE_EVIDENCE_MS: 30_000,
  SESSION_FILE_EVIDENCE_TAIL_BYTES: 1024,
  sessionTranscriptEvidenceCache: cache,
  sessionTranscriptEvidencePending: pending,
  sessionTranscriptFiles: async s => {
    calls++;
    await gate;
    if (fail) throw new Error('fixture unavailable');
    return [s.claude_transcript || s.codex_uuid];
  },
  stat: async () => ({ size: 20 }),
  readFileTail: async file => `evidence:${file}`,
  parseTranscriptExecutionEvidence: () => {},
  cacheSessionFileEvidence: (map, key, value) => { map.set(key, value); return value; },
});
vm.runInContext(`${implementation}\nthis.load = sessionTranscriptEvidence;`, context);
const session = { id: 's_cache', codex_uuid: 'native-a' };
const first = context.load(session), second = context.load(session);
assert.equal(calls, 1, 'concurrent callers share one exact-native evidence read');
now += 60_000;
release();
const [a, b] = await Promise.all([first, second]);
assert.equal(a, b);
assert.equal(a.expires, now + 30_000, 'a slow result gets its full TTL after completion');
assert.equal(pending.size, 0);
assert.equal(await context.load(session), a);
assert.equal(calls, 1);
const rebound = await context.load({ ...session, codex_uuid: 'native-b' });
assert.equal(calls, 2, 'rebinding the UI session never borrows a different native conversation');
assert.equal(rebound.texts[0], 'evidence:native-b');
now += 30_001;
await context.load(session);
assert.equal(calls, 3, 'completed cache expiry refreshes the evidence');
fail = true;
await assert.rejects(context.load({ id: 's_failure', claude_transcript: 'fixture.jsonl' }), /fixture unavailable/);
assert.equal(pending.size, 0, 'a failed load cannot strand the single-flight entry');
fail = false;
await context.load({ id: 's_failure', claude_transcript: 'fixture.jsonl' });
assert.equal(calls, 5);
console.log('session_file_evidence_cache.test passed: single-flight, completion TTL, native identity and failure recovery');
