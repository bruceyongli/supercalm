// Model-free EXECUTION coverage for the bounded same-model verifier-contradiction correction.
//
// The branch under test lives in runVerify (src/agents/supervisor.js): when the verifier's own prose
// asserts the opposite of a fact this system established deterministically (measured: glm-5.2 wrote
// "No screenshot or product-audit evidence was provided" about proof the supervisor had itself probed
// and confirmed served), the review is re-asked ONCE, pinned to the same model, with the fact stated.
// If that correction does not resolve cleanly it FAILS CLOSED — no verdict accepted, nothing sent.
//
// Everything here runs against the REAL runVerify with a canned ctx.callModel: no fleet, no network.
//
// HONESTY — what is execution-tested vs source-asserted:
//   * EXECUTION on runVerify (§1–§6, real runVerify + canned model): trigger/non-trigger, the one-call
//     same-model pin with retries=0, the correction addendum's contents, every fail-closed path
//     (transport / parse / schema / identity / repeated contradiction), acceptance, and the audit
//     envelope's accuracy, scrubbing and 12k bound.
//   * EXECUTION on the model-call plumbing (§7): the correction is pinned to the model that actually
//     ANSWERED after a chain fallback (A fails → B answers → B corrects, C never called), and a vision
//     route's multimodal user content survives the correction intact with caller-owned inputs frozen.
//   * EXECUTION through the real onTick (§8): a double contradiction driven through the live
//     completion and checkpoint branches — one held row persisted, nothing sent, and the
//     verdict-DEPENDENT state (reopen label, sign-off, active card, verify ledger) untouched. Each is
//     paired with a positive control on the same fixture, so "nothing happened" is proved to be the
//     hold rather than an inert setup.
//   * SOURCE CONTRACT (§9): what no single tick can reach — the CENSUS (every runVerify result site
//     and every raw-bearing logIntervention site persists `auditRaw || raw`, including the sync,
//     question-only and goal-conflict branches §8 does not drive), and the ORDERING invariants (no
//     state-consuming statement appears before the hold branch; the correction is ctx.callModel and
//     never callChain/callJson). Pinned by reading the source, and stated as such.
//   * REVISION + HERMETICITY (§10–§11): the prompt revision moved for the addendum while the evidence
//     revision did not, and §8's real ticks armed no timer and left no temp data behind.
//
// What §8 deliberately does NOT claim: the cost/dedupe state applied BEFORE the model call
// (challengedWorkFp, tierVerifiedFp, lastActionAt, lastCheckpointAt) legitimately moves on a hold —
// the tick really did spend a verify on this work-state. Asserting "no state changed" would be false
// and would freeze a behaviour that must not change.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aios-verify-correction-'));
process.env.AIOS_DATA = DATA_DIR;
process.env.AIOS_SUPERVISOR_CITED_SOURCES = process.env.AIOS_SUPERVISOR_CITED_SOURCES || '0';
// §8 needs a real active card to prove the card guard is not vacuous. Set before the supervisor
// imports so flagOn('projectMemory') sees it. §1–§7 are unaffected: they call runVerify directly with
// no runtime row, so applyActiveCard never runs and ctx.__activeCard stays undefined.
process.env.AIOS_PROJECT_MEMORY = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { __lab } = await import('../src/agents/supervisor.js');
const { db } = await import('../src/store.js');
const { recentVerifications } = await import('../src/agents/verify_ledger.js');
const pm = await import('../src/agents/supervisor/project_memory.js');
const {
  VERIFY_ATTEMPTS_SCHEMA,
  VERIFY_PROMPT_VERSION,
  buildVerifyAttemptsAudit,
  contradictionFailClosedResult,
  deterministicVerificationContradictions,
  exposedModelMismatch,
  isVerifierShaped,
  verificationCorrectionAddendum,
} = await import('../src/agents/supervisor/verify.js');

// Cleanup on EXIT, not at the end of the happy path: `check` rethrows, so a single failing assertion
// would otherwise leak a sqlite dir into /tmp on every red run.
process.on('exit', () => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });
// The import graph arms its own timers, and they are PRE-EXISTING import behaviour outside this
// patch's scope — not something this test may claim to be harmless. Two of them are load-bearing here:
//   • decision_records' import-time `setImmediate` — pending at this line, so it must be allowed to
//     settle before a baseline is taken, or it vanishes mid-test and a later exact compare reds out
//     on work this test never did.
//   • doctrine.js:487 `setTimeout(() => sweepStaleDoctrine(), 45_000)` — NOT unref'd, so a bare
//     `node test/…` genuinely lingers ~45s after the last check. That is the module's behaviour; this
//     bounded correction does not touch a production timer to make its own test exit sooner.
// So the contract is narrow and honest: TIMER-CLASS handles must not GROW past the settled baseline —
// §8 drives real ticks and must add no timer of its own. Non-timer classes (FSReqPromise, PipeWrap)
// float with in-flight stdout/sqlite I/O at the sampling instant and are deliberately not asserted.
await new Promise(setImmediate);
await new Promise(setImmediate);
const TIMER_KINDS = ['Timeout', 'Immediate'];
const timerHandles = () => process.getActiveResourcesInfo().filter((h) => TIMER_KINDS.includes(h)).sort();
const HANDLE_BASELINE = timerHandles();

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name, '\n   ', e?.message || e);
    throw e;
  }
}

const MODEL = 'glm-5.2';

// ── Evidence that makes the deterministic fact TRUE ────────────────────────────────────────────────
// detectOutOfBandEvidence needs: a production verb, a channel, a served/200 signal, and corroboration
// (here a live URL probe). deriveVerificationFacts then sets outOfBandProof — the ONLY fact that arms
// this correction.
const TERMINAL = 'Rendered the comparison gallery and served it at /aios/review — HTTP 200 OK\n> ';
const PROBES = [{ type: 'url', result: { ok: true, status: 200 } }];

const verdict = (o = {}) => JSON.stringify({
  verdict: 'needs_attention', score: 40, assessment: 'Assessment.', unmet: ['visual match unproven'],
  goal_conflict: false, unverifiable: 'none', message_to_agent: 'Keep going.', ...o,
});
// Asserts absence of proof the system proved exists → contradiction. This is the VERBATIM sentence a
// production verifier (glm-5.2, public exact-model matrix rep 5) returned about proof this same
// supervisor had rendered, served and probed — the failure the whole seam exists for. Every trigger
// case below runs on the captured text rather than a paraphrase, so the suite cannot drift into
// testing a grammar the production models never actually produced.
const CAPTURED_CONTRADICTION = 'The out-of-band channel /aios/review exists per corroboration but '
  + 'cannot be inspected here, so the visual match claim is unverifiable. No screenshot or '
  + 'product-audit evidence was provided to confirm the side-by-side matching.';
const CONTRADICTION_EXCERPT = 'No screenshot or product-audit evidence was provided';
const CONTRADICTING = verdict({ assessment: CAPTURED_CONTRADICTION });
// Correctly names the uninspectable channel → clean.
const CLEAN = verdict({
  assessment: 'Rendered proof exists out-of-band at /aios/review; the operator should open it.',
  unverifiable: 'out_of_band',
});

function makeCtx({ responses, sid = 's_vc_' + Math.random().toString(16).slice(2, 10), images = [], vision = false }) {
  const calls = [];
  let st = {};
  return {
    sessionId: sid,
    calls,
    session: () => ({ id: sid, tool: 'claude', status: 'waiting', autonomy: 'full' }),
    project: () => null,
    getState: () => ({ ...st }),
    setState: (patch) => { st = { ...st, ...patch }; return { ...st }; },
    getConfig: () => ({}),
    setConfig: () => {},
    getEvidence: async () => ({
      images, terminal_tail: TERMINAL, recent_messages: [],
      git: { stat: '', diff: '', committed_diff: '', commits_since_baseline: '' },
    }),
    runProbes: async () => PROBES,
    visionRoute: () => vision,
    hasCap: () => true,
    notifyOperator: () => {},
    emit: () => {},
    log: () => {},
    sendToAgent: async () => { throw new Error('runVerify must never send to the agent'); },
    callModel: async (messages, opts = {}) => {
      calls.push({ messages, opts, model: opts.model });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      const r = typeof next === 'function' ? next(calls.length) : next;
      if (r instanceof Error) throw r;
      if (typeof r === 'string') return { content: r, model: opts.model, route: { model: opts.model }, canSee: false };
      return { content: r.content, model: r.model ?? opts.model, route: { model: r.routeModel ?? opts.model }, canSee: false };
    },
  };
}

const CRITERION = 'The session sidebar matches the design.';
const CFG = { model: MODEL, mode: 'observe', doc: `# Task\n\n## Goal\nMatch the redesign.\n\n## Acceptance criteria\n- [ ] ${CRITERION}\n` };
const run = (ctx) => __lab.runVerify(ctx, CFG, 'manual', 'fp_test');
const runWith = (ctx, extra) => __lab.runVerify(ctx, { ...CFG, ...extra }, 'manual', 'fp_test');

// Only the correction call carries retries:0 — the discriminator used throughout.
const corrections = (ctx) => ctx.calls.filter((c) => c.opts?.retries === 0);
const audit = (auditRaw) => JSON.parse(auditRaw);

console.log('\n1. trigger / non-trigger');

await check('clean verifier output → exactly ONE call, no correction, no audit envelope', async () => {
  const ctx = makeCtx({ responses: [CLEAN] });
  const { parsed, auditRaw, raw } = await run(ctx);
  assert.equal(ctx.calls.length, 1, 'a non-contradicting verdict must not spend a second call');
  assert.equal(corrections(ctx).length, 0);
  assert.equal(auditRaw, null, 'no correction attempted → no attempts envelope (raw stays the plain verdict)');
  assert.ok(!parsed.hold, 'clean output is not held');
  assert.equal(raw, CLEAN);
});

await check('contradicting output WITHOUT the fact → no correction (the fact is what arms it)', async () => {
  // Same contradicting prose, but evidence with no out-of-band channel → outOfBandProof false.
  const ctx = makeCtx({ responses: [CONTRADICTING] });
  ctx.getEvidence = async () => ({ images: [], terminal_tail: 'Ran the tests.\n> ', recent_messages: [], git: {} });
  ctx.runProbes = async () => [];
  const { parsed, auditRaw } = await run(ctx);
  assert.equal(ctx.calls.length, 1, 'absent the deterministic fact there is nothing to contradict');
  assert.equal(auditRaw, null);
  assert.ok(!parsed.hold);
});

await check('contradicting output WITH the fact → exactly one correction, same requested model, retries:0', async () => {
  const ctx = makeCtx({ responses: [CONTRADICTING, CLEAN] });
  const { parsed, auditRaw } = await run(ctx);
  assert.equal(ctx.calls.length, 2, 'exactly one bounded correction — never two');
  const c = corrections(ctx);
  assert.equal(c.length, 1, 'exactly one call carries retries:0');
  assert.equal(c[0].opts.model, MODEL, 'the correction is PINNED to the model that answered (A,B,B — never a chain fallback)');
  assert.equal(c[0].opts.retries, 0, 'retries:0 — a retry here would silently spend a second correction call');
  assert.equal(c[0].opts.json, true);
  assert.ok(!parsed.hold, 'a resolved correction is not a hold');
  assert.ok(auditRaw, 'a correction always produces the provenance envelope');
});

console.log('\n2. the correction addendum');

await check('addendum states code + fact only, never quotes the first raw back', async () => {
  const ctx = makeCtx({ responses: [CONTRADICTING, CLEAN] });
  await run(ctx);
  const sys = String(corrections(ctx)[0].messages.find((m) => m.role === 'system')?.content || '');
  assert.match(sys, /DETERMINISTIC_CORRECTION \(out_of_band_absence\)/, 'carries the stable code');
  assert.match(sys, /\/aios\/review/, 'states the channel the system established');
  assert.match(sys, /system URL probe/, 'states the ACTUAL corroboration path, not a stronger one');
  assert.ok(!sys.includes(CONTRADICTION_EXCERPT),
    'the first raw is NOT quoted back — echoing the bad sentence invites the model to defend it');
  const user = corrections(ctx)[0].messages.find((m) => m.role === 'user')?.content;
  const firstUser = ctx.calls[0].messages.find((m) => m.role === 'user')?.content;
  assert.deepEqual(user, firstUser, 'the correction re-asks the SAME question — same evidence bytes, not a rebuilt approximation');
});

console.log('\n3. fail-closed paths (each: exactly one correction, then stop)');

const FAIL_CLOSED = [
  ['transport error', [CONTRADICTING, new Error('ECONNRESET upstream')], 'transport_error'],
  ['unusable json', [CONTRADICTING, 'not json at all'], 'parse_error'],
  // Route stays the pinned one; the EFFECTIVE id comes back as a different model. (A mismatched
  // route_model would be legitimate — that is the route the pin resolved to — so it is not the case.)
  ['identity mismatch', [CONTRADICTING, { content: CLEAN, model: 'glm-5.2-preview', routeModel: MODEL }], 'identity_mismatch'],
  ['schema-invalid {}', [CONTRADICTING, '{}'], 'schema_invalid'],
  ['schema-invalid verdict-only', [CONTRADICTING, '{"verdict":"complete"}'], 'schema_invalid'],
  ['repeated contradiction', [CONTRADICTING, CONTRADICTING], 'contradiction'],
];

for (const [label, responses, wantStatus] of FAIL_CLOSED) {
  await check(`${label} → held, no third call, nothing sent`, async () => {
    const ctx = makeCtx({ responses });
    const { parsed, auditRaw, raw } = await run(ctx);
    assert.equal(ctx.calls.length, 2, 'no third call — the correction budget is exactly one');
    assert.equal(parsed.hold, 'verifier_contradiction', 'the review is HELD');
    assert.deepEqual(parsed.contradictions, ['out_of_band_absence'], 'contradictions is an ARRAY of stable codes');
    assert.doesNotThrow(() => [].concat(parsed.contradictions).join(', '), 'callers .join() it — the shape must never be a bare string');
    assert.equal(parsed.verdict, 'needs_attention', 'a held review never signs off');
    assert.equal(parsed.score, null, 'no score is asserted from an output that was not accepted');
    assert.equal(parsed.message, '', 'a review whose own output could not be trusted must not speak to the agent');
    assert.equal(parsed.unverifiable, 'none', 'a hold is not blindness — it must not consume the blind-escalation budget');
    assert.match(parsed.assessment, /Held:/, 'the assessment leads with why the review was thrown away');
    const a = audit(auditRaw);
    assert.equal(a.accepted_effective_attempt, 0, 'NO verdict was accepted');
    assert.equal(a.attempts[1].status, wantStatus, `attempt 2 status is ${wantStatus}`);
    assert.equal(a.attempts.length, 2, 'both attempts are retained');
    assert.ok(String(raw || '').length > 0, 'a final bad raw stays visible to the operator');
  });
}

await check('transport failure keeps the FIRST raw (the second produced none)', async () => {
  const ctx = makeCtx({ responses: [CONTRADICTING, new Error('ECONNRESET upstream')] });
  const { auditRaw, raw } = await run(ctx);
  assert.equal(raw, CONTRADICTING, 'nothing came back from attempt 2, so attempt 1 remains what is displayed');
  assert.equal(audit(auditRaw).final_raw_attempt, 1);
});

await check('a bad SECOND raw becomes the displayed raw, first survives in the audit', async () => {
  const ctx = makeCtx({ responses: [CONTRADICTING, 'not json at all'] });
  const { auditRaw, raw } = await run(ctx);
  assert.equal(raw, 'not json at all', 'the final bad raw is what the operator sees');
  const a = audit(auditRaw);
  assert.equal(a.final_raw_attempt, 2);
  assert.equal(a.accepted_effective_attempt, 0, 'displayed ≠ accepted — the two facts are never collapsed');
  assert.ok(a.attempts[0].output.includes(CONTRADICTION_EXCERPT), 'the first raw is retained for audit');
});

console.log('\n4. acceptance');

await check('accepted correction is effective for BOTH record and raw; first is audit-only', async () => {
  const ctx = makeCtx({ responses: [CONTRADICTING, CLEAN] });
  const { parsed, raw, auditRaw, error } = await run(ctx);
  assert.equal(raw, CLEAN, 'the accepted second output is this review\'s answer');
  assert.equal(error, null, 'the first attempt\'s contradiction is not carried forward as an error');
  assert.ok(!parsed.hold);
  assert.equal(parsed.unverifiable, 'out_of_band', 'the corrected verdict is the one that lands');
  const a = audit(auditRaw);
  assert.equal(a.accepted_effective_attempt, 2);
  assert.equal(a.final_raw_attempt, 2);
  assert.equal(a.attempts[0].status, 'contradiction');
  assert.deepEqual(a.attempts[0].codes, ['out_of_band_absence']);
  assert.equal(a.attempts[1].status, 'ok');
  assert.ok(a.attempts[0].output.includes(CONTRADICTION_EXCERPT),
    'the rejected first output is still retained — never presented as the answer, never lost');
});

console.log('\n5. the audit envelope');

await check('envelope carries all three ids per attempt and the v1 schema', async () => {
  const ctx = makeCtx({ responses: [CONTRADICTING, CLEAN] });
  const { auditRaw } = await run(ctx);
  const a = audit(auditRaw);
  assert.equal(a.schema, VERIFY_ATTEMPTS_SCHEMA);
  assert.equal(a.schema, 'supervisor.verify-attempts/v1');
  for (const row of a.attempts) {
    for (const k of ['n', 'requested_model', 'route_model', 'effective_model', 'status', 'output']) {
      assert.ok(k in row, `attempt row carries ${k}`);
    }
    assert.equal(row.requested_model, MODEL, 'both attempts requested the same pinned model');
  }
});

await check('envelope never carries the prompt, the evidence or the images', async () => {
  const ctx = makeCtx({ responses: [CONTRADICTING, CLEAN] });
  const { auditRaw } = await run(ctx);
  assert.ok(!auditRaw.includes('EVIDENCE_JSON'), 'no evidence payload');
  assert.ok(!auditRaw.includes('skeptical VERIFIER'), 'no system prompt');
  assert.ok(!auditRaw.includes('DETERMINISTIC_CORRECTION'), 'no addendum');
  assert.ok(!auditRaw.includes(TERMINAL.trim()), 'no terminal tail');
});

await check('outputs and transport errors are both scrubbed of credentials/data-uris', async () => {
  const leaky = verdict({ assessment: 'No screenshot evidence was provided. token sk-abcdefghijklmnop0123 Bearer aaaaaaaaaaaaaaaaaaaa data:image/png;base64,' + 'A'.repeat(40) });
  const ctx = makeCtx({ responses: [leaky, new Error('upstream 401 for ghp_abcdefghijklmnop0123456789')] });
  const { auditRaw } = await run(ctx);
  assert.ok(!/sk-abcdefghijklmnop0123/.test(auditRaw), 'api key scrubbed from output');
  assert.ok(!/ghp_abcdefghijklmnop/.test(auditRaw), 'token scrubbed from the transport ERROR too, not just output');
  assert.ok(!/base64,A{16,}/.test(auditRaw), 'inlined image scrubbed');
  assert.match(auditRaw, /\[redacted-key\]/);
  assert.match(auditRaw, /\[redacted-data-uri\]/);
});

await check('envelope stays ≤12000 chars (the supervisor_reviews.raw bound) and keeps BOTH attempts parseable', async () => {
  const huge = (tag) => verdict({ assessment: `No screenshot evidence was provided. ${tag} ${'x'.repeat(30000)}` });
  const built = buildVerifyAttemptsAudit({
    attempts: [
      { n: 1, requestedModel: MODEL, routeModel: MODEL, returnedModel: MODEL, status: 'contradiction', codes: ['out_of_band_absence'], output: huge('FIRST') },
      { n: 2, requestedModel: MODEL, routeModel: MODEL, returnedModel: MODEL, status: 'contradiction', codes: ['out_of_band_absence'], output: huge('SECOND') },
    ],
    acceptedAttempt: 0,
    finalRawAttempt: 2,
  });
  assert.ok(built.length <= 12000, `envelope is ${built.length} chars — must fit the 12k row bound after escaping`);
  const a = JSON.parse(built);
  assert.equal(a.attempts.length, 2, 'shrink outputs evenly — never drop an attempt');
  assert.ok(a.attempts[0].output.includes('FIRST'), 'the HEAD of each verdict survives (verdict/score/assessment come first)');
  assert.ok(a.attempts[1].output.includes('SECOND'));
  assert.equal(a.accepted_effective_attempt, 0);
});

console.log('\n6. the pure helpers the branch is built on');

await check('isVerifierShaped: schema-closed, and typed — no Number() coercion', async () => {
  const full = { verdict: 'unknown', score: 0, assessment: 'a', unmet: [], goal_conflict: false, unverifiable: 'none', message_to_agent: '' };
  assert.equal(isVerifierShaped(full), true, 'a fully shaped `unknown` is valid');
  assert.equal(isVerifierShaped({ ...full, verdict: 'complete', score: 100 }), true);
  for (const [why, bad] of [
    ['empty object', {}],
    ['verdict-only complete', { verdict: 'complete' }],
    ['verdict-only unknown', { verdict: 'unknown' }],
    ['unknown verdict value', { ...full, verdict: 'looks_fine' }],
    ['missing assessment', { ...full, assessment: undefined }],
    ['blank assessment', { ...full, assessment: '   ' }],
    ['missing unmet', { ...full, unmet: undefined }],
    ['unmet not an array', { ...full, unmet: 'none' }],
    ['unmet of non-strings', { ...full, unmet: [{ text: 'x' }] }],
    ['goal_conflict not boolean', { ...full, goal_conflict: 'false' }],
    ['unverifiable off-enum', { ...full, unverifiable: 'maybe' }],
    ['message not a string', { ...full, message_to_agent: 12 }],
    ['score null', { ...full, score: null }],
    ['score empty string', { ...full, score: '' }],
    ['score numeric string', { ...full, score: '50' }],
    ['score false', { ...full, score: false }],
    ['score true', { ...full, score: true }],
    ['score NaN', { ...full, score: NaN }],
    ['score out of range', { ...full, score: 101 }],
    ['score negative', { ...full, score: -1 }],
    ['array', []],
    ['null', null],
    ['string', 'complete'],
  ]) {
    assert.equal(isVerifierShaped(bad), false, `must REJECT: ${why}`);
  }
});

await check('exposedModelMismatch: exact equality, absent id passes', async () => {
  assert.equal(exposedModelMismatch(MODEL, '', ''), false, 'nothing exposed → nothing to check');
  assert.equal(exposedModelMismatch(MODEL, MODEL, MODEL), false);
  assert.equal(exposedModelMismatch(MODEL, 'models/' + MODEL, ''), false, 'provider prefix normalized');
  assert.equal(exposedModelMismatch(MODEL, 'route-id', 'route-id'), false, 'the route the pin resolved to is legitimate');
  assert.equal(exposedModelMismatch(MODEL, MODEL + '-preview', ''), true, 'a dated/suffixed variant is a DIFFERENT model — fails closed');
  assert.equal(exposedModelMismatch(MODEL, 'gpt-5.6-sol', ''), true);
});

await check('deterministicVerificationContradictions is fact-gated and returns stable codes', async () => {
  const bad = { assessment: 'No screenshot evidence was provided.', unmet: [], message: '' };
  assert.deepEqual(deterministicVerificationContradictions(bad, {}), [], 'no fact → no contradiction');
  assert.deepEqual(deterministicVerificationContradictions(null, { outOfBandProof: true }), [], 'no parsed record → nothing to check');
  const hit = deterministicVerificationContradictions(bad, { outOfBandProof: true });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].code, 'out_of_band_absence', 'a stable CODE, never a scenario name');
  assert.equal(verificationCorrectionAddendum([], {}), '', 'no codes → no addendum');
});

await check('contradictionFailClosedResult always returns an array of codes', async () => {
  const r = contradictionFailClosedResult([{ code: 'out_of_band_absence' }], { reason: 'correction call failed' });
  assert.ok(Array.isArray(r.contradictions), 'ARRAY — a string here would make callers .join() throw');
  assert.deepEqual(r.contradictions, ['out_of_band_absence']);
  assert.deepEqual(contradictionFailClosedResult([], {}).contradictions, ['unknown'], 'never empty, never undefined');
  assert.equal(contradictionFailClosedResult([{ code: 'x' }, { code: 'x' }], {}).contradictions.length, 1, 'deduped');
});

console.log('\n7. model-chain and multimodal execution');

await check('a chain fallback pins the correction to the model that ANSWERED, not the head', async () => {
  // A is dead, B answers with the captured contradiction, B's correction comes back clean. The
  // correction must re-ask B — the model whose output was wrong. Re-entering the chain would either
  // re-ask the dead A or hand the question to C, and "a DIFFERENT model disagreed" is not the same
  // evidence as "this model, told the fact, withdrew it".
  const ctx = makeCtx({ responses: [new Error('ECONNRESET A'), CONTRADICTING, CLEAN] });
  const { parsed, auditRaw } = await runWith(ctx, { fallback_models: ['model-a', MODEL, 'model-c'] });
  assert.deepEqual(ctx.calls.map((c) => c.opts.model), ['model-a', MODEL, MODEL],
    'exactly A, B, B — the correction re-asks the answering model');
  assert.equal(ctx.calls.filter((c) => c.opts.model === 'model-c').length, 0,
    'C must NEVER be called: the correction is a pin, not a chain re-entry');
  assert.equal(corrections(ctx).length, 1, 'still exactly one correction');
  assert.equal(ctx.calls[2].opts.retries, 0, 'and it is still the pinned, retry-less call');
  assert.ok(!parsed.hold, 'the clean correction is accepted');
  assert.deepEqual(audit(auditRaw).attempts.map((a) => a.requested_model), [MODEL, MODEL],
    'the audit attributes both attempts to B — A never produced an output to audit');
});

await check('a vision route keeps the multimodal user content intact across the correction', async () => {
  // The correction re-sends `first.user` verbatim. On a vision route that is an ARRAY of content
  // parts; anything that rebuilt or re-wrapped it would drop the image or append a second JSON
  // contract, and the model would be correcting a different question than the one it answered.
  const image = Object.freeze({ kind: 'preview', label: 'preview: /aios/review', dataUrl: 'data:image/png;base64,' + 'A'.repeat(24), rel: 'shot.png' });
  const images = Object.freeze([image]);
  const before = JSON.stringify(images);
  const ctx = makeCtx({ responses: [CONTRADICTING, CLEAN], images, vision: true });
  const { screenshot } = await run(ctx);
  assert.equal(screenshot, 'shot.png', 'the screenshot really was attached — the case is not vacuous');
  const userOf = (i) => ctx.calls[i].messages.find((m) => m.role === 'user').content;
  const [first, correction] = [userOf(0), userOf(1)];
  assert.ok(Array.isArray(first), 'a vision route sends content PARTS, not a coerced string');
  assert.deepEqual(first.map((p) => p.type), ['text', 'text', 'image_url', 'text'],
    'evidence text, image label, the image itself, then the JSON contract');
  assert.equal(first[2].image_url.url, image.dataUrl, 'the image survives as the exact data URL');
  assert.deepEqual(correction, first, 'byte-for-byte the same question is re-asked');
  assert.equal(first.filter((p) => p.text === 'Return the result as one valid json object.').length, 1,
    'exactly one JSON contract part');
  assert.equal(correction.filter((p) => p.text === 'Return the result as one valid json object.').length, 1,
    'and the correction does not append a second one');
  // Caller-owned inputs are frozen: a mutation would have THROWN in the module's strict mode. This
  // asserts the weaker observable too, so the contract survives an unfrozen caller.
  assert.equal(JSON.stringify(images), before, 'the evidence images array the caller owns is unchanged');
  const sys = ctx.calls[1].messages.find((m) => m.role === 'system').content;
  assert.match(sys, /DETERMINISTIC_CORRECTION/, 'only the SYSTEM side carries the addendum');
  assert.ok(!JSON.stringify(correction).includes('DETERMINISTIC_CORRECTION'), 'never the user side');
});

console.log('\n8. real execution through onTick (completion + checkpoint)');

// A tick-capable ctx: onTick reads more of the session than runVerify does, and records rather than
// throws on send so "nothing was sent" is an observation instead of an absence of evidence.
function makeTickCtx({ responses, status, category, state = {}, cfg = {}, projectId = null }) {
  const sid = 's_tick_' + Math.random().toString(16).slice(2, 10);
  const calls = []; const sends = []; const logs = [];
  let st = { ...state };
  const config = {
    ...CFG, completion_gate: true, self_maintaining_doc: false,
    doc_settle_sec: 0, stop_interval_sec: 0, checkpoint: false, ...cfg,
  };
  return {
    sessionId: sid, calls, sends, logs,
    session: () => ({ id: sid, tool: 'claude', status, category, autonomy: 'full', started_at: Date.now(), last_activity: Date.now(), summary: '', question: '', title: 'T', project_id: projectId }),
    // path:null keeps the card in the DB only — no repo projection, no GOAL.md, no derived facts.
    project: () => (projectId ? { id: projectId, name: 'P', path: null } : null),
    getState: () => ({ ...st }),
    setState: (patch) => { st = { ...st, ...patch }; return { ...st }; },
    getConfig: () => config,
    setConfig: () => {},
    gitHead: async () => 'deadbeef',
    paneSig: () => 'pane-1',
    getEvidence: async () => ({
      images: [], terminal_tail: TERMINAL, recent_messages: [],
      git: { stat: '', diff: '', committed_diff: '', commits_since_baseline: '' },
    }),
    runProbes: async () => PROBES,
    visionRoute: () => false,
    hasCap: () => true,
    notifyOperator: (...a) => { sends.push({ kind: 'notifyOperator', a }); },
    emit: () => {},
    log: (...a) => { logs.push(a.join(' ')); },
    sendToAgent: async (text) => { sends.push({ kind: 'sendToAgent', text }); return { sent: true }; },
    resumeSession: async () => {},
    callModel: async (messages, opts = {}) => {
      calls.push({ messages, opts, model: opts.model });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      const r = typeof next === 'function' ? next(calls.length) : next;
      if (r instanceof Error) throw r;
      return { content: r, model: opts.model, route: { model: opts.model }, canSee: false };
    },
  };
}

const reviewRows = (sid) => db.prepare(
  'select kind, trigger, verdict, score, assessment, message, sent, raw from supervisor_reviews where session_id = ? order by id',
).all(sid);
// Everything the card owns, including exact event IDs — "no NEW events" cannot be faked by the
// creation events that were already there.
const cardSnapshot = (pid, tid) => JSON.stringify({
  task: pm.getTask(tid),
  criteria: pm.listCriteria(tid, { includeInactive: true }),
  events: pm.listEvents({ projectId: pid, taskId: tid, limit: 200 }).map((e) => [e.id, e.type, e.summary]),
});
function seedCard(pid) {
  const { task } = pm.createTask({ projectId: pid, title: 'Redesign', goal: 'Match the redesign', criteria: [CRITERION], actor: 'operator' });
  pm.setTaskStatus(task.id, 'active', { actor: 'operator' });
  return pm.taskCard(task.id);
}
// The state a re-open leaves behind: verifiedWorkFp/verifiedAt cleared, the prior sign-off retained as
// the label's ground truth, reopenPending armed and waiting for the next ACCEPTED review. Pre-syncing
// the card ids keeps applyActiveCard side-effect-free (no first-sync knowledge bootstrap).
const reopenedState = (card) => ({
  lastActionAt: 0, migrationProposedAt: 1,
  activeTaskId: card.task.id, activeCardVersion: card.task.version, activeCardHash: card.hash,
  outOfBandEscalatedAt: 5,
  signoff: { score: 90, assessment: 'prior sign-off', at: 1 },
  reopenPending: { at: 1, reason: 'operator', score: 90, assessment: 'prior sign-off', workFp: 'old' },
});
// What a HELD row's envelope must say, in full. `attempts.length === 2` alone also passes on an
// ACCEPTED correction (attempt 1 contradiction, attempt 2 ok) — so the two facts that distinguish a
// hold from a rescue, and the status of BOTH attempts, are asserted explicitly.
function assertHeldAudit(raw) {
  const a = audit(raw);
  assert.equal(a.schema, VERIFY_ATTEMPTS_SCHEMA, 'the persisted envelope is the v1 schema');
  assert.equal(a.attempts.length, 2, 'both attempts are persisted for the operator');
  assert.equal(a.accepted_effective_attempt, 0, 'NO verdict was accepted — the review failed closed');
  assert.equal(a.final_raw_attempt, 2, 'the SECOND raw is the displayed one; the first survives in the audit');
  assert.deepEqual(a.attempts.map((x) => x.status), ['contradiction', 'contradiction'],
    'both attempts are recorded as contradictions — not one contradiction and one rescue');
  for (const row of a.attempts) assert.deepEqual(row.codes, ['out_of_band_absence'], 'each with the deterministic code');
}
// criteria_met is what makes the card assertion non-vacuous: without the hold this ticks the
// criterion and appends a verify_fail event (proved by the control below).
const MET = [{ text_prefix: CRITERION, evidence: 'the gallery render is served at /aios/review' }];
const TICK_CONTRADICTING = verdict({ assessment: CAPTURED_CONTRADICTION, criteria_met: MET });
const TICK_CLEAN = verdict({
  assessment: 'Rendered proof exists out-of-band at /aios/review; the operator should open it.',
  unverifiable: 'out_of_band', criteria_met: MET,
});

await check('completion: a double contradiction holds — one row, no send, no verdict-dependent state', async () => {
  const pid = 'p_held';
  const card = seedCard(pid);
  const seeded = reopenedState(card);
  // Deep CLONES, not references: makeTickCtx shallow-copies `state`, so comparing the final state to
  // `seeded.reopenPending` would move with an in-place mutation and pass vacuously.
  const wantReopen = structuredClone(seeded.reopenPending);
  const wantSignoff = structuredClone(seeded.signoff);
  const ctx = makeTickCtx({ responses: [TICK_CONTRADICTING, TICK_CONTRADICTING], status: 'waiting', category: 'review', projectId: pid, state: seeded });
  pm.upsertRuntime(ctx.sessionId, { project_id: pid, active_task_id: card.task.id });
  const cardBefore = cardSnapshot(pid, card.task.id);
  assert.equal(recentVerifications(ctx.sessionId, 6).length, 0, 'ledger starts empty');

  await __lab.onTick(ctx);

  assert.equal(ctx.__activeCard?.task?.id, card.task.id,
    'the card really was bound — a legacy-doc fallback would make the card assertions vacuous');
  assert.equal(ctx.calls.length, 2, 'the verify plus exactly one correction — the bounded budget');
  assert.deepEqual(ctx.sends, [], 'a held review sends nothing to the agent and escalates nothing');

  const rows = reviewRows(ctx.sessionId);
  assert.equal(rows.length, 1, 'exactly one persisted review row');
  assert.equal(rows[0].kind, 'verify');
  assert.equal(rows[0].trigger, 'completion');
  assert.equal(rows[0].verdict, 'needs_attention');
  assert.equal(rows[0].score, null, 'a held review carries NO score — nothing was judged');
  assert.equal(rows[0].sent, 0);
  assert.equal(rows[0].message, '', 'no message to the agent survives into the record');
  assert.match(rows[0].assessment, /^Held: /);
  assertHeldAudit(rows[0].raw);

  assert.equal(cardSnapshot(pid, card.task.id), cardBefore,
    'the active card is untouched: no criterion ticked, no status change, no new event');
  assert.equal(recentVerifications(ctx.sessionId, 6).length, 0, 'and nothing entered the verify ledger');

  const st = ctx.getState();
  assert.deepEqual(st.reopenPending, wantReopen, 'reopenPending stays ARMED, byte-for-byte, so the next accepted review still labels it');
  assert.deepEqual(st.signoff, wantSignoff, 'the prior sign-off is preserved unchanged as that label\'s ground truth');
  assert.equal(st.verifiedWorkFp, undefined, 'a held review never signs anything off');
  assert.equal(st.outOfBandEscalatedAt, 5, 'the standing out-of-band escalation is neither re-armed nor cleared');
  assert.match(ctx.logs.join('\n'), /completion verify held \(out_of_band_absence\) — no verdict accepted, no send, no verdict-dependent state consumed/);
  // The cost/dedupe state applied BEFORE the call legitimately moved: the tick really did spend a
  // verify on this work-state. This is asserted, not glossed over, so the claim above stays honest.
  assert.equal(st.tierVerifiedFp != null, true, 'the work-state was marked verified-for-this-tier (cost state)');
  assert.ok(st.lastActionAt > 0, 'and the tick recorded that it acted');
});

await check('completion CONTROL: the same fixture, accepted, DOES consume the card and the reopen label', async () => {
  const pid = 'p_ctrl';
  const card = seedCard(pid);
  const ctx = makeTickCtx({ responses: [TICK_CLEAN], status: 'waiting', category: 'review', projectId: pid, state: reopenedState(card) });
  pm.upsertRuntime(ctx.sessionId, { project_id: pid, active_task_id: card.task.id });
  const cardBefore = cardSnapshot(pid, card.task.id);

  await __lab.onTick(ctx);

  assert.equal(ctx.calls.length, 1, 'a clean verifier output needs no correction');
  assert.notEqual(cardSnapshot(pid, card.task.id), cardBefore, 'an ACCEPTED verdict does reach the card');
  assert.deepEqual(pm.listCriteria(card.task.id).map((c) => c.status), ['satisfied'],
    'the criterion is ticked from criteria_met — exactly what the held run must not do');
  assert.ok(pm.listEvents({ projectId: pid, taskId: card.task.id, limit: 50 }).some((e) => e.type === 'verify_fail'),
    'and the verdict enters the card history — the held run wrote no such event');
  assert.equal(ctx.getState().reopenPending, null, 'the reopen label is consumed by an accepted review');
});

await check('checkpoint: a double contradiction holds — row persisted, nothing pushed', async () => {
  const ctx = makeTickCtx({
    responses: [TICK_CONTRADICTING, TICK_CONTRADICTING], status: 'working', category: 'working',
    // A large stuck_timeout keeps the unstick branch out of the way; the interval makes this tick due.
    cfg: { checkpoint: true, checkpoint_interval_sec: 1, stuck_timeout_sec: 100000 },
    state: { lastActionAt: 0, lastCheckpointAt: 0, migrationProposedAt: 1 },
  });

  await __lab.onTick(ctx);

  assert.equal(ctx.calls.length, 2, 'verify plus one correction');
  assert.deepEqual(ctx.sends, [], 'the periodic corrective push is suppressed by the hold');
  const rows = reviewRows(ctx.sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'checkpoint');
  assert.equal(rows[0].trigger, 'checkpoint');
  assert.equal(rows[0].sent, 0);
  assert.equal(rows[0].message, '', 'shouldPush is false, so no checkpoint gap text is even composed');
  assertHeldAudit(rows[0].raw);
  assert.ok(ctx.getState().lastCheckpointAt > 0, 'the checkpoint budget was spent (cost state moves)');
});

await check('checkpoint CONTROL: the same fixture, accepted, DOES compose a corrective push', async () => {
  const ctx = makeTickCtx({
    responses: [TICK_CLEAN], status: 'working', category: 'working',
    cfg: { checkpoint: true, checkpoint_interval_sec: 1, stuck_timeout_sec: 100000 },
    state: { lastActionAt: 0, lastCheckpointAt: 0, migrationProposedAt: 1 },
  });

  await __lab.onTick(ctx);

  assert.equal(ctx.calls.length, 1);
  const rows = reviewRows(ctx.sessionId);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].message, '', 'an accepted needs_attention DOES compose the checkpoint gap');
  assert.equal(rows[0].sent, 0, 'observe mode still cannot deliver it — the contrast is composition, not delivery');
});

console.log('\n9. downstream wiring (SOURCE CONTRACT — see the honesty note in the header)');

const SRC = readFileSync(join(ROOT, 'src', 'agents', 'supervisor.js'), 'utf8');

// Enumerated globally rather than by slicing between runVerify calls. A destructure-to-destructure
// region is NOT the lexical scope of `auditRaw` — kind:'l3-review' (which persists `r?.content` from
// its own separate model call, and never sees auditRaw) sits inside one such region and would fail a
// region test that is actually correct about it. So: every raw-bearing logIntervention site in the
// file is accounted for, and the only non-audit one is named. A new site of either kind fails here.
const RAW_LOG_SITES = (SRC.match(/logIntervention\(ctx, \{[\s\S]*?\}\);/g) || [])
  .filter((s) => /\braw:/.test(s))
  .map((s) => ({
    kind: s.match(/kind:\s*'([^']+)'/)?.[1] || '?',
    raw: s.match(/raw:\s*([^,\n]+)/)?.[1]?.trim() || '?',
    site: s,
  }));

await check('every runVerify result site persists `auditRaw || raw`', async () => {
  assert.equal([...SRC.matchAll(/=\s*await runVerify\(/g)].length, 5,
    'five runVerify call sites: question-only, completion, checkpoint, manual, sync');
  const audited = RAW_LOG_SITES.filter((s) => /^auditRaw \|\| raw$/.test(s.raw));
  const other = RAW_LOG_SITES.filter((s) => !/^auditRaw \|\| raw$/.test(s.raw));
  assert.equal(RAW_LOG_SITES.length, 10, `expected 10 raw-bearing logIntervention sites, found ${RAW_LOG_SITES.length}`);
  assert.equal(audited.length, 9, `expected 9 audit-persisting sites, found ${audited.length}`);
  assert.deepEqual(other.map((s) => s.kind), ['l3-review'],
    `the ONLY raw-bearing site outside the verify contract is l3-review; found: ${other.map((s) => `${s.kind}(${s.raw})`).join(', ')}`);
  assert.match(other[0].raw, /^r\?\.content/, 'l3-review persists its own call result, not a verify raw');
});

await check('the runVerify site census is exact — an omitted trigger fails', async () => {
  // From the per-site split above. A regex that scans FORWARD to `raw: auditRaw || raw` would run
  // across intervening logIntervention calls and report their triggers instead.
  const census = RAW_LOG_SITES.filter((s) => /^auditRaw \|\| raw$/.test(s.raw))
    .map((s) => s.site.match(/trigger:\s*'([^']+)'/)?.[1] || 'unknown').sort();
  assert.deepEqual(census, [
    'checkpoint', 'completion', 'completion', 'completion', 'completion',
    'manual', 'question-only', 'sync', 'unverifiable',
  ], 'the exact set of audit-persisting verify sites (4 completion: hold, complete, goal-conflict, final)');
});

await check('completion branches on parsed.hold IMMEDIATELY after runVerify', async () => {
  const i = SRC.indexOf("await runVerify(ctx, cfg, 'completion', fp.work)");
  assert.ok(i > 0, 'the completion runVerify call site exists');
  const after = SRC.slice(i, i + 3000);
  const hold = after.indexOf('if (parsed.hold) {');
  assert.ok(hold > 0, 'a hold branch follows the completion verify');
  // Nothing that consumes state or signs off may appear before it.
  for (const consumer of ['st.reopenPending', 'recordReopenLabel', "verdict === 'complete'", 'goal_conflict', 'outOfBandStanding', 'dispatchSupervisorSend']) {
    const at = after.indexOf(consumer);
    assert.ok(at === -1 || at > hold,
      `'${consumer}' is reachable BEFORE the hold branch — a held verdict could consume state`);
  }
  // The block itself, not a magic-number window: the `if (parsed.hold) {` body sits at four-space
  // indent, so it closes at the first `\n    }`. A fixed slice silently truncates when a message
  // inside the block grows (it did) and turns a real contract into a length test.
  const end = after.indexOf('\n    }', hold);
  assert.ok(end > hold, 'the hold block is closed');
  const holdBlock = after.slice(hold, end);
  assert.match(holdBlock, /sent:\s*0/, 'the hold logs sent:0');
  assert.match(holdBlock, /message:\s*''/, 'the hold sends no message');
  assert.match(holdBlock, /raw:\s*auditRaw \|\| raw/, 'the hold persists both attempts');
  assert.match(holdBlock, /return;/, 'the hold RETURNS — nothing downstream runs');
});

await check('checkpoint cannot push on a hold', async () => {
  assert.match(SRC, /const shouldPush = !parsed\.hold && \['needs_attention', 'off_track'\]\.includes\(parsed\.verdict\)/,
    'the checkpoint push gate must exclude held reviews');
});

await check('doctrine audit and active-card mutation are gated on !parsed.hold inside runVerify', async () => {
  assert.match(SRC, /if \(trigger === 'completion' && !parsed\.hold\) \{/,
    'the doctrine audit must not run on a held verdict');
  assert.match(SRC, /if \(ctx\.__activeCard && !parsed\.hold\) \{/,
    'a held review must not tick criteria, change status, or write a verify_fail card event');
});

await check('the correction is pinned via ctx.callModel — never callChain/callJson', async () => {
  const i = SRC.indexOf('const addendum = verificationCorrectionAddendum(');
  const block = SRC.slice(i, SRC.indexOf('const auditRaw =', i));
  assert.match(block, /await ctx\.callModel\(/, 'the correction calls the model directly');
  assert.ok(!/callChain\(/.test(block), 'callChain would restart the fallback chain — a DIFFERENT model is not this model correcting itself');
  assert.ok(!/callJson\(/.test(block), 'callJson would add a parse retry, making the bounded one-call budget two');
  assert.match(block, /retries: 0/);
});

console.log('\n10. prompt version contract');

await check('VERIFY_PROMPT_VERSION was bumped for the correction addendum', async () => {
  assert.equal(VERIFY_PROMPT_VERSION, 'supervisor.verify.2026-07-26.1',
    'the addendum changes verifier prompt behaviour, so the prompt revision moves (package version untouched)');
  const replay = readFileSync(join(ROOT, 'test', 'supervisor_replay.test.js'), 'utf8');
  assert.match(replay, /VERIFY_PROMPT_VERSION, 'supervisor\.verify\.2026-07-26\.1'/,
    'the replay contract must pin the same revision');
  assert.match(replay, /VERIFY_EVIDENCE_VERSION, 'supervisor\.evidence\.2026-07-23\.2'/,
    'evidence composition is unchanged, so the evidence version must NOT move');
});

console.log('\n11. hermeticity');

await check('the real onTick runs leave no timer and no temp data behind', async () => {
  const now = timerHandles();
  assert.ok(now.length <= HANDLE_BASELINE.length,
    `the ticks armed no timer of their own (baseline ${HANDLE_BASELINE.join(',') || 'none'} → now ${now.join(',') || 'none'})`);
  for (const kind of TIMER_KINDS) {
    const before = HANDLE_BASELINE.filter((h) => h === kind).length;
    assert.ok(now.filter((h) => h === kind).length <= before, `no new ${kind} was armed by the ticks`);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  assert.equal(existsSync(DATA_DIR), false, 'the temp AIOS_DATA dir is removed (the exit hook is the backstop)');
});

console.log(`\nsupervisor_verify_correction.test ok (${passed} checks)`);
