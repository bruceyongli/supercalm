import assert from 'node:assert/strict';
import { resolveSttCandidates, normalizeSttSource, normalizeAgentHint } from '../src/stt_source.js';

const ALL = { codex: true, claude: true, spark: true, provider: true };
const r = (pref, hint, avail = ALL) => resolveSttCandidates({ pref, hint, avail });

// ---- normalizers ----
assert.equal(normalizeSttSource('CODEX'), 'codex');
assert.equal(normalizeSttSource('nonsense'), 'auto');
assert.equal(normalizeSttSource(undefined), 'auto');
assert.equal(normalizeAgentHint('Claude'), 'claude');
assert.equal(normalizeAgentHint('agy'), null); // agy has no subscription STT
assert.equal(normalizeAgentHint(''), null);

// ---- auto: match the agent, codex-first without a hint, never claude-without-hint ----
assert.deepEqual(r('auto', 'codex'), ['codex', 'spark', 'provider']);
assert.deepEqual(r('auto', 'claude'), ['claude', 'spark', 'provider']);
assert.deepEqual(r('auto', null), ['codex', 'spark', 'provider']); // no hint → codex, not claude

// ---- INVARIANT 1: a subscription vendor never falls through to the OTHER vendor ----
for (const list of [r('auto', 'codex'), r('auto', 'claude'), r('codex'), r('claude')]) {
  assert.ok(!(list.includes('codex') && list.includes('claude')), 'no cross-vendor: ' + list);
}

// ---- INVARIANT 2: pinning local `spark` never crosses to cloud ----
assert.deepEqual(r('spark', null), ['spark']);
assert.deepEqual(r('spark', 'codex'), ['spark']); // even with a codex hint + codex authed
assert.deepEqual(r('spark', null, { spark: false }), []); // spark pinned but down → empty (→ 502), NOT cloud

// ---- explicit provider is a cloud choice ----
assert.deepEqual(r('provider', null), ['provider']);

// ---- pinned subscription still backs off to spark/provider (but never the other vendor) ----
assert.deepEqual(r('codex', 'claude'), ['codex', 'spark', 'provider']); // pref wins over hint
assert.deepEqual(r('claude', null), ['claude', 'spark', 'provider']);

// ---- unavailable/unbuilt sources are dropped, order preserved ----
assert.deepEqual(r('auto', 'claude', { ...ALL, claude: false }), ['spark', 'provider']); // pass-1 claude unbuilt
assert.deepEqual(r('auto', 'codex', { ...ALL, codex: false }), ['spark', 'provider']); // codex not authed
assert.deepEqual(r('auto', 'codex', { codex: true, claude: false, spark: false, provider: false }), ['codex']);
assert.deepEqual(r('auto', null, { codex: false, claude: false, spark: false, provider: false }), []); // nothing → 502

console.log('stt_source.test ok');
