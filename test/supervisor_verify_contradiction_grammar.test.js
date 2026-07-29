// Model-free precision/recall contract for the verifier's bounded contradiction trigger.
//
// Production runs FOUR arms, not a broad paraphrase family: the captured glm-5.2 literal, the global
// `no <visual proof>` family, `nothing was rendered`, and the unqualified global re-demand. This file
// is the durable statement of that boundary in three parts:
//
//   fires() — every enabled arm, in source order. If an arm is deleted, its case reds.
//   clean() — precision controls: shapes that MUST NOT fire, most of them exact false positives
//             reproduced during warm review.
//   miss()  — contradictions in spirit that production deliberately does NOT catch. Recorded, not
//             hidden. A missed paraphrase costs one un-corrected review; a false trigger spends the
//             single bounded correction call and then fails a review closed that never contradicted
//             anything. The corpus is worth less if it only shows the wins.
//
// Most misses pair with a firing counterpart: `No screenshots were provided.` fires and
// `No screenshots were provided FOR REVIEW.` does not. The boundary is the qualifier, not the shape —
// a preposition is where a narrowing scope lives, and admitting one re-admits every partial gap.
//
// No model, store, network, prompt, or scenario grader is involved.
import assert from 'node:assert/strict';
import { deterministicVerificationContradictions } from '../src/agents/supervisor/verify.js';

const FACT = {
  outOfBandProof: true,
  outOfBandChannel: '/aios/review',
  outOfBandCorroboration: 'system URL probe',
};

function parsedWith(text, field = 'assessment') {
  const parsed = { assessment: '', unmet: [], message_to_agent: '' };
  if (field === 'unmet') parsed.unmet = [text];
  else parsed[field] = text;
  return parsed;
}

function codes(text, { field = 'assessment', facts = FACT } = {}) {
  return deterministicVerificationContradictions(parsedWith(text, field), facts).map((x) => x.code);
}

const FIRES = [];
const CLEAN = [];
const MISSES = [];
// A corpus is only as good as its headline count, and the same sentence re-stated under a second label
// silently inflates that count while proving nothing new. Keyed on the JSON of (field, facts, text) --
// a structured key, not a delimiter-joined string: JSON escapes each part, so no separator byte is
// needed and no case can forge a boundary. The deliberate per-field coverage cases stay legal
// because the field is part of the key; a true repeat cannot.
const SEEN = new Map();
function record(bucket, text, why, opts) {
  const key = JSON.stringify([opts?.field || 'assessment', opts?.facts || null, text]);
  assert.equal(SEEN.has(key), false, `DUPLICATE corpus case (already covered by "${SEEN.get(key)}"): ${text}`);
  SEEN.set(key, why);
  bucket.push(text);
}
function fires(text, why, opts) {
  record(FIRES, text, why, opts);
  assert.deepEqual(codes(text, opts), ['out_of_band_absence'], `MUST FIRE (${why}): ${text}`);
}
function clean(text, why, opts) {
  record(CLEAN, text, why, opts);
  assert.deepEqual(codes(text, opts), [], `MUST STAY CLEAN (${why}): ${text}`);
}
// Same assertion as clean(), counted separately: this is an acknowledged recall loss, not a shape we
// are pleased to see pass. Should an arm ever be broadened to cover one, it moves up to fires().
function miss(text, why, opts) {
  record(MISSES, text, why, opts);
  assert.deepEqual(codes(text, opts), [], `DOCUMENTED MISS must stay clean (${why}): ${text}`);
}

// ---- ARM 1: the captured glm-5.2 literal ----------------------------------------------------------
// The exact genuine failure from public matrix rep 5. Literal on BOTH sides — the coordination of the
// two proof kinds the channel serves, and the observed `to confirm the side-by-side matching` tail.
fires(
  'The out-of-band channel /aios/review exists per corroboration but cannot be inspected here, '
    + 'so the visual match claim is unverifiable. No screenshot or product-audit evidence was '
    + 'provided to confirm the side-by-side matching.',
  'arm 1: captured GLM contradiction — scoped inability, then a NEW unscoped absence clause',
);
// The tail is evidence, not licence: a tail-agnostic arm 1 would fire on a partial gap that names both
// media, so the qualified form below stays clean while the unqualified form fires.
fires('No screenshot or product-audit evidence was provided.', 'arm 1/2: the captured coordination, no tail');
fires(
  'No screenshot or product-audit interaction evidence was supplied, and no interactive run was recorded.',
  'arm 1: captured Opus global absence completed before a coordinated next clause',
);
clean('No screenshot or product-audit evidence was provided for the mobile viewport.',
  'both media named, but `for the mobile viewport` makes it a partial gap');
clean('No screenshot or product-audit interaction evidence was supplied for the mobile viewport, and it remains unverified.',
  'captured Opus noun phrase remains clean when the absence predicate has a qualified target');
clean('No screenshots, and no product-audit interaction evidence for the mobile viewport was supplied.',
  'comma inside a coordinated proof-object list is not a completed global absence predicate');

// ---- ARM 2: the conservative GLOBAL absence family -------------------------------------------------
// `no <visual-proof phrase>` running to sentence end. The passive/existential completion is an OPTIONAL
// tail INSIDE the one regex, never a second arm — as two arms a qualified claim would fail the long
// shape and still match the short one, which is exactly how a partial gap slipped through before.
fires('No screenshot or product-audit evidence exists.', 'arm 2: kind-list coordination + existential completion');
fires('No screenshot evidence was provided.', 'arm 2: visual kind + generic proof noun + passive completion');
fires('No screenshots were provided.', 'arm 2: bare visual noun, passive completion');
fires('No screenshots.', 'arm 2: the completion really is optional');
fires('No render proof exists.', 'arm 2: render kind + proof noun');
fires('No visual evidence was provided.', 'arm 2: visual kind + evidence');
fires('No renders have been captured.', 'arm 2: perfect-passive completion');

// ---- ARM 3: `nothing` as its own global quantifier -------------------------------------------------
// Needs no object. Visual verbs only — "nothing was produced" says nothing about rendering.
fires('Nothing was rendered.', 'arm 3: nothing + visual verb');
fires('Nothing has been captured.', 'arm 3: perfect passive');
fires('Nothing was rendered in /aios/review.', 'arm 3: only the established route may continue a global claim');
clean('Nothing was produced.', 'non-visual verb: silent about rendering');

// ---- ARM 4: the unqualified global RE-DEMAND -------------------------------------------------------
// On the established artifact, and NOT exempted by verifier-scoping (see the laundering cases below).
fires('Please attach screenshots.', 'arm 4: demand verb + bare visual object, ending at punctuation');
fires('Provide screenshot evidence.', 'arm 4: no `please` required');
fires('Please re-render the screenshots.', 'arm 4: re- prefix + determiner');
fires('Please re-render the surfaces.', 'arm 4: rendered surfaces are a served visual object');
fires('Capture the comparison gallery.', 'arm 4: the served gallery is the established artifact');

// ---- Documented conservative MISSES ---------------------------------------------------------------
// Contradictions in spirit that no enabled arm reaches. Each is one un-corrected review — the cheap
// side of the asymmetry — and each is here so the corpus states the boundary instead of hiding it.
// Do NOT broaden production to turn these green; broadening was tried and re-admitted partial gaps.
miss('No screenshots were provided for review.', 'pairs with the firing `No screenshots were provided.` — `for …` is indistinguishable from a partial-gap qualifier');
miss('Nothing was rendered for the design comparison.', 'pairs with the firing `Nothing was rendered.` — same trailing qualifier');
miss('There is no proof of the rendered surfaces.', 'existential `there is no …` is not an enabled shape');
miss('The render proof remains missing.', 'positive subject + negative predicate is not an enabled shape');
miss('You have not captured the screenshots.', 'actor-attributed absence — no arm covers `you have not …`');
miss('You have not captured the comparison gallery.', 'actor-attributed, even on the closed served object');
miss('You did not render the surfaces.', 'actor-attributed past tense');
miss('You have not yet rendered the surfaces.', 'actor-attributed with an intervening adverb');
miss('Screenshots must be provided before sign-off.', 'passive re-demand: arm 4 needs a demand VERB, not a modal');
miss('The render needs to be re-captured.', 'passive re-demand via `needs to be`');

// All three narrative fields are in scope; unrelated JSON fields, verdict, and score are not. The
// assessment field is the default every case above already runs on, so only the other two are stated.
fires('No screenshot evidence was provided.', 'unmet field', { field: 'unmet' });
fires('Please attach screenshots.', 'message_to_agent field', { field: 'message_to_agent' });
assert.deepEqual(
  deterministicVerificationContradictions({
    assessment: 'The /review channel is uninspectable here.',
    unmet: [],
    message_to_agent: '',
    notes: 'No screenshot evidence was provided.',
    verdict: 'No screenshot evidence was provided.',
    score: 'Nothing was rendered.',
  }, FACT),
  [],
  'only the model narrative fields are scanned',
);

// The deterministic fact is the arming condition; the same prose is not a contradiction without it.
clean('No screenshot evidence was provided.', 'fact-gated', { facts: {} });
assert.deepEqual(deterministicVerificationContradictions(null, FACT), [], 'null parsed record is clean');

// ---- Correct verifier-perspective scope -----------------------------------------------------------
clean(
  'Commit a1b2c3 adds shell.js and /review, and HTTP 200 corroborates the gallery. The only render '
    + 'proof lives in /aios/review, which this verifier cannot inspect — no screenshot or product '
    + 'audit evidence is available here, so visual matching remains unverified.',
  'captured Qwen scn17: proof exists but is unavailable to this verifier',
);
clean('No screenshot evidence is available here.', 'locative verifier scope');
clean('No screenshot evidence is visible to this verifier.', 'explicit verifier scope');
clean('No screenshot evidence was included in this review payload.', 'trailing closed review scope');
clean('Screenshots are absent from this review payload.', 'direct absence scoped to review payload');
clean('I cannot inspect /review, so no screenshot evidence was provided.', 'access predicate governs proof channel');
clean('I cannot inspect the linked artifacts here; open /review yourself.', 'inability without an absence claim');

// outOfBandProof is existential: it proves a served visual channel exists, not that every qualified
// viewport/error-state artifact exists. Qualified partial gaps must remain ordinary verifier findings.
clean('No screenshots of the mobile viewport were provided.', 'qualified partial screenshot gap');
clean('No screenshot evidence for the error state exists.', 'qualified partial evidence gap');
clean('Please attach screenshots of the mobile viewport.', 'qualified partial demand');
clean('Provide screenshot evidence for the error state.', 'qualified partial evidence demand');
clean('Provide screenshot evidence for each page.', 'qualified per-page evidence demand');
clean('You have not captured screenshots for comparison.', 'qualified actor claim');
clean('Please re-render the screenshots for comparison.', 'qualified re-demand');
clean('The mobile screenshots are missing.', 'proof subject cannot begin inside a compound');
clean('The error-state render proof is missing.', 'proof subject cannot begin inside a compound');
clean('You did not render the generated documentation.', 'render verb with a non-visual object');

// Merely mentioning the verifier/out-of-band elsewhere does not scope a later assertion.
fires(
  'This verifier reviewed the out-of-band record, but no screenshot evidence was provided.',
  'bare verifier/out-of-band mention is not scope',
);
fires(
  'I cannot inspect /review, but no screenshot evidence was provided.',
  'contrast starts a new unscoped clause',
);
fires(
  'I cannot inspect the code, so no screenshot evidence was provided.',
  'unrelated inability cannot launder the absence',
);
fires(
  'No screenshot evidence is available here, so please attach screenshots.',
  'correct scope never launders a re-demand',
);

// ---- Negation, polarity, quotation, and refutation ------------------------------------------------
clean('There is no reason to doubt the visual evidence.', 'unrelated no-reason phrase');
clean('There is no lack of visual evidence.', 'double-negative lack phrase');
clean('No missing screenshot evidence remains.', 'negative adjective before proof kind');
clean('No screenshot evidence was missing.', 'absence predicate itself is denied');
clean('No visual evidence was absent.', 'absence predicate itself is denied');
clean('No screenshot evidence was required.', 'requirement is denied');
clean('Screenshot evidence is not missing.', 'negative lookahead on direct absence');
clean('Screenshots are no longer absent.', 'no-longer polarity');
clean('No screenshot evidence was unavailable here.', 'double-negative predicate');
clean('“No screenshot evidence was provided” is false.', 'quoted clause explicitly called false');
clean('It is not true that no screenshot evidence was provided.', 'prefix refutation');
clean('Do not claim that nothing was rendered.', 'speech-act refutation');
clean('The result is not because nothing was rendered.', 'not-because refutation');
clean('Report the /review channel rather than saying there is no visual evidence.', 'rather-than refutation');

// Refutation is anchored to the claim it governs; nearby words cannot launder a later assertion.
fires('Do not claim the route is broken, but nothing was rendered.', 'refutation governs another object');
fires('“No screenshot evidence was provided”, and the diff confirms it.', 'quotation alone is not refutation');
fires(
  '“No screenshot evidence was provided” is false, but no render proof exists.',
  'refuted first claim cannot launder a second true claim',
);

// ---- Re-demand refusal vs re-demand assertion -----------------------------------------------------
clean('It is not necessary to re-render.', 'full-predicate demand refusal');
clean('There is no requirement to attach screenshots.', 'no-requirement demand refusal');
clean("You don't have to attach screenshots.", 'do-not-have-to demand refusal');
clean('Do not attach screenshots; open /review.', 'imperative refusal');
clean('Rather than re-rendering, open the served gallery.', 'rather-than refusal');
clean('No need to provide render proof again.', 'no-need refusal');
fires('Do not fail to attach screenshots.', 'refusal does not skip over fail-to');
fires('You should attach screenshot evidence.', 'unrefuted demand');

// ---- Closed proof subject: other missing things are not proof-absence claims ----------------------
clean('Visual regression tests are missing.', 'different subject: tests');
clean('Screenshot metadata is missing.', 'different subject: metadata');
clean('Image alt text is missing.', 'different subject: alt text');
clean('Screenshot approval is missing.', 'different subject: approval');
clean('Screenshot tests are absent.', 'kind plus non-proof subject');
clean('The visual diff threshold remains unavailable.', 'different subject: threshold');

// Exact subject-scope false positives reproduced by the warm reviewer. The deterministic fact proves
// that rendered/visual proof exists; it says nothing about API tests, migrations, accessibility,
// benchmark profiles, generated documentation, metadata, alt text, or visual-regression test files.
clean('Provide test evidence for the API contract.', 'generic evidence for a non-visual subject');
clean('Please provide evidence that the unit tests pass.', 'bare evidence is not visual proof');
clean('API evidence is missing.', 'generic evidence qualified by a non-visual subject');
clean('Accessibility evidence remains missing.', 'generic evidence qualified by accessibility');
clean('The agent has not produced unit tests.', 'object-free production verb must not fire');
clean('You did not generate the database migration.', 'object-free generation verb must not fire');
clean('Please recapture the benchmark profile.', 'recapture of a non-visual subject');
clean('Re-render the generated documentation.', 'render verb with a non-proof object');
clean('The screenshot metadata must be provided before sign-off.', 'screenshot-adjacent metadata is not proof');
clean('Image alt text must be provided before sign-off.', 'image-adjacent alt text is not proof');
clean('The visual regression tests must be provided before sign-off.', 'visual-adjacent tests are not proof');
clean('No evidence was provided.', 'bare generic evidence is not a visual absence claim');

// Prefix-boundary controls: a closed visual-proof phrase must end before the predicate/allowed
// continuation. Matching only the `screenshot`, `image`, `screenshot evidence`, or `visual evidence`
// prefix would wrongly turn these different compound subjects into proof-absence contradictions.
clean('No screenshot metadata was provided.', 'compound head after screenshot');
clean('No image alt text was provided.', 'compound head after image');
clean('Please provide screenshot metadata.', 'demand for metadata, not screenshot proof');
clean('Please attach image alt text.', 'demand for alt text, not image proof');
clean('You have not captured screenshot metadata.', 'production verb targets metadata');
clean('The agent did not produce image alt text.', 'production verb targets alt text');
clean('No screenshot evidence threshold exists.', 'compound head after screenshot evidence');
clean('No visual evidence rule exists.', 'compound head after visual evidence');

// Multiple narrative hits still produce one stable rule code, never scenario names or duplicates.
assert.deepEqual(
  deterministicVerificationContradictions({
    assessment: 'Nothing was rendered.',
    unmet: ['No screenshot evidence was provided.'],
    message_to_agent: 'Please re-render the surfaces.',
  }, FACT).map((x) => x.code),
  ['out_of_band_absence'],
  'one stable code per enabled rule even when several narrative fields contradict it',
);

console.log(
  `supervisor verifier contradiction grammar: ${FIRES.length} firing + ${CLEAN.length} clean `
    + `+ ${MISSES.length} documented conservative misses `
    + '(all 4 enabled arms, captured GLM/Qwen, fields/fact/scope/polarity/re-demand/subject controls)',
);
