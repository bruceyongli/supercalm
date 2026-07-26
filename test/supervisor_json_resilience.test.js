import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIOS_DATA = mkdtempSync(join(tmpdir(), 'aios-supervisor-json-'));

const { __lab } = await import('../src/agents/supervisor.js');

function fakeCtx(responses, { vision = false } = {}) {
  const calls = [];
  return {
    calls,
    session: () => ({ tool: 'claude' }),
    visionRoute: () => vision,
    log: () => {},
    callModel: async (messages, opts) => {
      calls.push({ messages, opts });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { content: next, model: opts.model };
    },
  };
}

{
  const ctx = fakeCtx(['{"fit":"new","title":"Task","goal":"Ship it","reason":"substantive work"}']);
  const result = await __lab.callJson(
    ctx,
    { fallback_models: ['exact-model'] },
    'Return STRICT JSON only.',
    'Classify this boundary.',
  );
  assert.equal(ctx.calls.length, 1, 'valid JSON does not add a redundant model call');
  assert.match(ctx.calls[0].messages[0].content, /\bjson\b/, 'every JSON-mode call carries the lowercase provider contract');
  assert.match(ctx.calls[0].messages[1].content, /\bjson\b/, 'the lowercase contract is present in user input for Codex /responses');
  assert.equal(ctx.calls[0].opts.json, true);
  assert.equal(ctx.calls[0].opts.model, 'exact-model');
  assert.equal(result.parsed.fit, 'new');
}

{
  const ctx = fakeCtx(['', '{"verdict":"needs_attention"}']);
  const result = await __lab.callJson(
    ctx,
    { fallback_models: ['exact-model'] },
    'Return JSON only.',
    'Review this evidence.',
  );
  assert.equal(ctx.calls.length, 2, 'empty/unparseable model output receives one bounded retry');
  assert.equal(result.parsed.verdict, 'needs_attention');
  assert.equal(result.error, null);
}

{
  const ctx = fakeCtx(['', 'still not json']);
  const result = await __lab.callJson(
    ctx,
    { fallback_models: ['exact-model'] },
    'Return JSON only.',
    'Review this evidence.',
  );
  assert.equal(ctx.calls.length, 2, 'parse retry is bounded to one extra call');
  assert.equal(result.parsed, null);
  assert.match(result.error, /JSON object/i);
}

// ---------------------------------------------------------------------------
// Work-derived boundary fallback (fix for glm rep2 / scn12 `12-boundary-work-derived`).
// The between-tasks Path 2 stamps boundaryWorkTs BEFORE the classify call for cost-bounding, but the
// fingerprint (boundaryWorkFp) must be spent ONLY on a definitive outcome, or an unchanged uncarded
// commit stream is marked "judged" forever and silently vanishes. These are model-free: the model seam
// returns fixed strings / throws, so behavior is deterministic.

// (a) Pure title derivation: prefer the newest non-scaffold subject, strip the leading hash, and never
// let commit text reach a shell/prompt boundary.
{
  const { boundaryTitleFromCommits } = __lab;
  assert.equal(
    boundaryTitleFromCommits('a1b2c3d feat(reports): add CSV export\ne4f5a6b test(reports): cover it'),
    'feat(reports): add CSV export',
    'strips the shorthash and picks the newest substantive subject',
  );
  assert.equal(
    boundaryTitleFromCommits('a1b2c3d test: add tests\nb2c3d4e feat(core): real feature'),
    'feat(core): real feature',
    'skips scaffold (test/chore/docs/…) subjects in favour of real work',
  );
  assert.equal(
    boundaryTitleFromCommits('a1b2c3d chore: bump deps\nb2c3d4e docs: readme'),
    'chore: bump deps',
    'all-scaffold set still yields a title (newest subject) rather than nothing',
  );
  const unsafe = boundaryTitleFromCommits('a1b2c3d feat: add `rm -rf` $(whoami) <x>|y');
  assert.doesNotMatch(unsafe, /[`$<>|]/, 'shell/prompt metacharacters are stripped from derived titles');
  assert.ok(unsafe.startsWith('feat: add'), 'sanitization preserves the readable subject');
  assert.equal(boundaryTitleFromCommits(''), '', 'no commits → empty title (no suggestion downstream)');
  assert.equal(boundaryTitleFromCommits('   \n  '), '', 'blank lines → empty title');
}

// (b) End-to-end fallback wiring through maybeSuggestBoundary with a real (tmp) decision DB.
let boundarySeq = 0;
function boundaryCtx(responses) {
  let state = {};
  const emits = [];
  const calls = [];
  const ctx = {
    sessionId: 's_boundary_' + (boundarySeq++),
    __betweenTasks: true,
    __activeCard: null,
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; return state; },
    session: () => ({ tool: 'claude' }),
    visionRoute: () => false,
    emit: (kind, payload) => emits.push({ kind, payload }),
    log: () => {},
    callModel: async (messages, opts) => {
      calls.push({ messages, opts });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { content: next, model: opts.model };
    },
  };
  return { ctx, emits, calls, state: () => state };
}
const CFG = { fallback_models: ['exact-model'] };
const T = 1_000_000_000_000;
const COMMITS = 'a1b2c3d feat(reports): add CSV export to the report page\ne4f5a6b test(reports): cover CSV export';
const EV = { git: { commits_since_baseline: COMMITS } };

// empty/unparseable model output (both bounded attempts) → deterministic fallback suggestion + fp judged.
{
  const h = boundaryCtx(['', '']);
  await __lab.maybeSuggestBoundary(h.ctx, CFG, h.ctx.getState(), T, 0, EV);
  const s = h.state();
  assert.ok(s.pendingBoundary, 'empty model output still yields a boundary suggestion (no silent vanish)');
  assert.equal(s.pendingBoundary.fromWork, true, 'fallback is a work-derived suggestion');
  assert.equal(s.pendingBoundary.derived, true, 'fallback is flagged derived (model gave nothing usable)');
  assert.match(s.pendingBoundary.title, /CSV export/, 'title comes from the commit subjects');
  assert.ok(s.boundaryWorkFp, 'the fingerprint IS judged once a fallback is constructed');
  assert.equal(s.boundaryWorkTs, T, 'the cost-bound timestamp is stamped regardless');
  assert.ok(h.emits.some((e) => e.kind === 'review' && e.payload.verdict === 'suggested'), 'emits a suggested review');
}

// transport/model-chain failure (classify throws) → NO suggestion, and the fingerprint is left UNSPENT
// so the identical commit set is re-judged next window. Distinct, observable behavior from empty output.
{
  const h = boundaryCtx([new Error('router 502 upstream unavailable')]);
  await __lab.maybeSuggestBoundary(h.ctx, CFG, h.ctx.getState(), T, 0, EV);
  const s = h.state();
  assert.equal(s.pendingBoundary, undefined, 'a pure transport failure fabricates no boundary');
  assert.equal(s.boundaryWorkFp, undefined, 'the fingerprint is UNSPENT on transport failure (retry preserved)');
  assert.equal(s.boundaryWorkTs, T, 'boundaryWorkTs still bounds retry cost');
  assert.equal(h.emits.length, 0, 'no review emitted on transport failure');
}

// a valid model 'none' is respected: no suggestion, but the set IS judged (fingerprint spent) so it is
// not re-asked forever.
{
  const h = boundaryCtx(['{"fit":"none"}']);
  await __lab.maybeSuggestBoundary(h.ctx, CFG, h.ctx.getState(), T, 0, EV);
  const s = h.state();
  assert.equal(s.pendingBoundary, undefined, 'a valid model none creates no suggestion');
  assert.ok(s.boundaryWorkFp, 'a valid classification judges the fingerprint');
  assert.equal(h.emits.length, 0, 'no review emitted for none');
}

// a valid model 'new' with a concrete boundary → suggestion straight from the model (not derived).
{
  const h = boundaryCtx(['{"fit":"new","title":"Add spreadsheet export","goal":"CSV + XLSX on the report page"}']);
  await __lab.maybeSuggestBoundary(h.ctx, CFG, h.ctx.getState(), T, 0, EV);
  const s = h.state();
  assert.ok(s.pendingBoundary, 'a valid new classification yields a suggestion');
  assert.equal(s.pendingBoundary.title, 'Add spreadsheet export', 'title is the model title, verbatim (clamped)');
  assert.equal(s.pendingBoundary.fromWork, true, 'work-derived path marks fromWork');
  assert.notEqual(s.pendingBoundary.derived, true, 'a model classification is NOT flagged derived');
  assert.ok(s.boundaryWorkFp, 'the fingerprint is judged');
}

// a valid fit with no boundary (e.g. {"fit":"new"} without title/goal) → judged, no suggestion, no derive.
{
  const h = boundaryCtx(['{"fit":"new"}']);
  await __lab.maybeSuggestBoundary(h.ctx, CFG, h.ctx.getState(), T, 0, EV);
  const s = h.state();
  assert.equal(s.pendingBoundary, undefined, 'a classification without a concrete boundary makes no suggestion');
  assert.ok(s.boundaryWorkFp, 'but it is a real classification, so the fingerprint is judged');
}

// an OUT-OF-ENUM fit (e.g. "banana") is a hallucinated key, not a decision: it must NOT be trusted as a
// boundary even with a title, and must NOT burn the fingerprint on its own strength. It follows the
// replied-but-invalid fallback (derive from the commit subjects, not from the bogus model title).
{
  const h = boundaryCtx(['{"fit":"banana","title":"trust me"}']);
  await __lab.maybeSuggestBoundary(h.ctx, CFG, h.ctx.getState(), T, 0, EV);
  const s = h.state();
  assert.ok(s.pendingBoundary, 'an unusable fit still surfaces the uncarded work via the deterministic fallback');
  assert.equal(s.pendingBoundary.derived, true, 'the suggestion is derived, not taken from the malformed classification');
  assert.match(s.pendingBoundary.title, /CSV export/, 'title comes from commit subjects, NOT the hallucinated model title');
  assert.notEqual(s.pendingBoundary.title, 'trust me', 'the out-of-enum model title is never trusted');
}

// -------------------------------------------------------------------------------------------
// MULTIMODAL PAYLOAD PRESERVATION. runVerify builds userContent as content PARTS (EVIDENCE_JSON
// text + labelled screenshots) whenever the route can see. Appending the json contract by string
// concatenation coerced that array to "[object Object],[object Object]" — the evidence and the
// images never left this process, and the model produced a confident verdict about a codebase it
// invented (measured: 6 of 20 frozen-scenario calls). The contract must ride as its own part.
// -------------------------------------------------------------------------------------------
const EVIDENCE_PART = 'EVIDENCE_JSON:\n{"contract":"typing reaches the agent pane","git":{"diff":"+ flushTypeBuf();"}}';
const IMAGE_PART = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } };
const multimodalContent = () => [
  { type: 'text', text: EVIDENCE_PART },
  { type: 'text', text: 'preview screenshot: /session' },
  { ...IMAGE_PART },
];

{
  const ctx = fakeCtx(['{"verdict":"needs_attention"}'], { vision: true });
  const caller = multimodalContent();
  const result = await __lab.callJson(ctx, { fallback_models: ['exact-model'] }, 'Verify this session.', caller);
  const sent = ctx.calls[0].messages[1].content;
  assert.ok(Array.isArray(sent), 'a vision route receives content PARTS, not a coerced string');
  assert.doesNotMatch(JSON.stringify(sent), /\[object Object\]/, 'no part was stringified away');
  assert.equal(sent[0].text, EVIDENCE_PART, 'the evidence part reaches the model byte-for-byte');
  assert.deepEqual(sent[2], IMAGE_PART, 'the image_url part is passed through untouched');
  assert.equal(sent.filter((p) => p.type === 'image_url').length, 1, 'exactly the attached image, nothing dropped or duplicated');
  assert.match(sent.at(-1).text, /\bjson\b/, 'the lowercase json contract rides as its own trailing text part');
  assert.equal(result.parsed.verdict, 'needs_attention');
  assert.equal(caller.length, 3, "the caller's own parts array is not appended to");
  assert.deepEqual(caller[2], IMAGE_PART, "the caller's parts are not mutated in place");
}

{
  // Text-only fallback: the images cannot be sent, but every TEXT part must survive the flattening.
  const ctx = fakeCtx(['{"verdict":"needs_attention"}'], { vision: false });
  await __lab.callJson(ctx, { fallback_models: ['exact-model'] }, 'Verify this session.', multimodalContent());
  const sent = ctx.calls[0].messages[1].content;
  assert.equal(typeof sent, 'string', 'a text-only route receives flattened text');
  assert.doesNotMatch(sent, /\[object Object\]/, 'flattening never stringifies a part object');
  assert.ok(sent.includes(EVIDENCE_PART), 'the evidence survives the text-only path');
  assert.ok(sent.includes('preview screenshot: /session'), 'every text part survives, including labels');
  assert.match(sent, /\bjson\b/, 'the provider contract survives the text-only path');
}

console.log('supervisor_json_resilience.test ok');
process.exit(0); // store.js may hold timers; this test owns its process (run-tests has no child timeout)
