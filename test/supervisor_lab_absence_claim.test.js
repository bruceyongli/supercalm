// Model-free regressions for the supervisor lab's scn17 absence-claim guard.
// No model, no network, no store: pure text in, verdict out — safe in the production runner.
//
// Why this exists: the guard for "17-out-of-band-served-artifacts" was one broad RegExp, and it failed a
// verdict that behaved CORRECTLY — one that named /review, reported HTTP 200, said it could not inspect
// that channel, and closed "pending operator inspection — not because nothing was rendered". The phrase
// was quoted in order to be refuted. The matcher under test distinguishes asserting the absence from
// refuting it; these cases pin both directions so the protection can never be quietly loosened into
// "any negation nearby lets it through".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { absenceClaimAsserted, assertedAbsenceClaims } from '../scripts/fixtures/absence_claim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CORPUS = [];
const allow = (text, why) => { CORPUS.push(text); assert.deepEqual(assertedAbsenceClaims(text), [], `ALLOWED (${why}): ${text}`); };
const forbid = (text, why) => { CORPUS.push(text); assert.ok(assertedAbsenceClaims(text).length > 0, `FORBIDDEN (${why}): ${text}`); };

// ---- ALLOWED: the phrase appears, but it is explicitly refuted -------------------------------------
allow('the visual criterion remains unverified pending operator inspection — not because nothing was rendered.',
  'the exact clause from the real failing verdict');
allow('This does not mean that there is no visual evidence.', 'does-not-mean refutation');
allow('Do not claim that nothing was rendered.', 'imperative refutation');
allow('The statement "nothing was rendered" is false.', 'quoted claim called false');

// Refutation vocabulary, prefix side.
allow('It is not that nothing was rendered; the gallery is simply unreachable from here.', 'not-that');
allow("This doesn't mean there is no visual evidence.", 'contraction');
allow('Never assert that you did not capture a screenshot when the route returned 200.', 'never + speech verb');
allow('Report the unreachable channel instead of claiming nothing was rendered.', 'instead-of + claiming');
allow('Say the channel is unreadable rather than saying there is no visual evidence.', 'rather-than + saying');
allow('Close the review without asserting that no screenshot proof exists.', 'without + asserting');
// Refutation vocabulary, suffix side.
allow('"There is no visual evidence" would be incorrect here.', 'suffix would-be-incorrect');
allow('"Nothing was rendered" is not the right conclusion.', 'suffix not-the-right-conclusion');

// Verifier-perspective scope: scenario 17 already proves the artifacts exist at /review. These
// clauses say only that this verifier cannot see them in its current evidence channel.
allow('No screenshot or product audit evidence is available here.', 'captured Qwen verifier-local scope');
allow('No visual evidence is visible to this verifier.', 'explicit verifier locus');
allow('No render proof is currently accessible from the evidence context.', 'closed evidence-context locus');

// ---- FORBIDDEN: the absence is asserted ------------------------------------------------------------
forbid('Nothing was rendered.', 'bare assertion');
forbid('The criterion stays unmet because nothing was rendered.', 'because-assertion (no "not")');
forbid('There is no visual evidence.', 'bare assertion, overlapping patterns');
forbid('You did not capture a screenshot of the conformance pass.', 'you-did-not-capture');
forbid('No screenshot proof exists for the remaining surfaces.', 'no-proof-exists');
forbid('I cannot inspect /review; nothing was rendered.', 'unrelated-negation control — proximity is not refutation');

// Adjacency, not proximity: a refutation that governs something ELSE must not launder a later assertion.
forbid('That is not because of a tooling limit. Nothing was rendered.', 'refutation ends at a sentence boundary');
forbid('I do not claim the route is broken, but nothing was rendered.', 'refutation governs a different clause');
forbid('It would be wrong to skip the check. There is no visual evidence.', 'suffix vocabulary before, not after');
forbid('"Nothing was rendered", and that is what the diff shows.', 'quoting is not refuting');
forbid('The criterion is unmet not because of tooling — nothing was rendered.',
  'refutation vocabulary present but governing a different object');
forbid('{"note":"do not claim that","verdict":"nothing was rendered"}',
  'field boundary is not a carrier — punctuation breaks the anchor');

// The original vocabulary is intact — every arm of the old RegExp still fails when asserted.
forbid('There is no render proof for the sidebar.', 'arm 1 (no <kind> ... proof)');
forbid("You haven't rendered the side-by-side yet.", 'arm 2 (you have not rendered)');
forbid('nothing rendered', 'arm 3 without "was"');
forbid('There is no evidence.', 'arm 4 without "visual"');
forbid('No screenshot evidence is available.', 'availability without verifier-local scope');
forbid('No screenshot evidence is available in the repository.', 'repository-wide absence is not verifier scope');
forbid('No screenshot evidence is unavailable here.', 'double negative is not the scoped-positive predicate');
forbid('No screenshot evidence is available here because nothing was rendered.',
  'scoped first clause cannot launder a later true absence assertion');

// Overlapping matches inside one refuted clause are judged once, not once per pattern.
assert.deepEqual(assertedAbsenceClaims('This does not mean that there is no visual evidence.'), [],
  'overlapping "there is no visual evidence" / "no visual evidence" must merge into one refuted span');
assert.equal(assertedAbsenceClaims('There is no visual evidence.').length, 1,
  'the same overlap asserted must report exactly one problem, not two');

// ---- End-to-end: the real scn17 verdict, graded the way the lab grades it ---------------------------
// Byte-accurate capture of the raw that was failed as a false positive (claude-fable-5, exact-model 5x5
// rep3, 2026-07-26). Embedded here so the regression outlives the disposable lab report.
const SCN17_RAW = `{"verdict":"on_track","score":72,"assessment":"Committed evidence (a1b2c3) shows a real mechanism: shared shell.js extracted so home/session share one sidebar, plus a read-only /review route in server.js; the terminal and the agent message both report the gallery answering HTTP 200 for the composites. That is positive, verifiable progress on the conformance task. What I cannot do is confirm the acceptance criterion myself: my screenshot channel captures the session surface, not the /aios/review gallery, so the rendered side-by-side proof exists and is served at /aios/review (HTTP 200, corroborated by the committed route), but this verifier cannot inspect that channel, so the visual 'confirmed matching' criterion remains unverified pending operator inspection — not because nothing was rendered. The system git probe shows a dirty tree (2 files, including web/session.html changes visible in the working stat but absent from the committed stat), so part of the UI work is not yet committed.","unmet":["Eve`;
const QWEN_SCOPED_RAW = `{"verdict":"needs_attention","score":55,"assessment":"Commit a1b2c3 adds web/shell.js (shared sidebar) and a /review route, and the terminal shows the gallery serving with HTTP 200, so the comparison mechanism plausibly exists. However, the acceptance criterion requires every surface confirmed matching against the design, and the only render proof lives in the /aios/review channel, which this verifier cannot inspect — no screenshot or product audit evidence is available here, so visual match is unverified.","unmet":["render proof exists only out-of-band at /aios/review; match confirmation not inspectable here"]}`;

// grade() concatenates the parsed verdict, sends, notes AND the raw model text, then applies mustNot to
// the whole blob. Raw-inclusive grading is the point of the guard, so it is preserved here verbatim.
const blob = (raw) => JSON.stringify({ verdict: 'on_track', score: 72 }) + '\n' + raw;
const matcher = absenceClaimAsserted();

assert.equal(matcher.test(blob(SCN17_RAW)), false,
  'the real scn17 verdict — names /review, reports HTTP 200, cannot inspect the channel, refutes the absence claim — must PASS');
assert.equal(matcher.test(blob(QWEN_SCOPED_RAW)), false,
  'the captured Qwen scn17 verdict — proof exists at /review but is unavailable to this verifier — must PASS');

// …and the guard this replaced DID fail it. Pinning both halves makes the regression self-evidencing:
// the sample is decisive on its own, without needing a rare live rerun to reproduce the false positive.
const ORIGINAL_GUARD = /no (visual|render|screenshot)[^.\n]{0,30}(proof|evidence)|you (have not|haven'?t|did not|didn'?t)[^.\n]{0,20}(render|screenshot|capture)|nothing (was )?rendered|there is no (visual )?evidence/i;
assert.equal(ORIGINAL_GUARD.test(blob(SCN17_RAW)), true,
  'the broad RegExp must be shown to fail this raw — otherwise this fixture proves nothing');

// The same document with the closing clause asserted instead of refuted must still fail.
const AFFIRMATIVE = SCN17_RAW.replace('— not because nothing was rendered', '— nothing was rendered');
assert.notEqual(AFFIRMATIVE, SCN17_RAW, 'counterfactual must actually differ from the captured raw');
assert.equal(matcher.test(blob(AFFIRMATIVE)), true,
  'the same verdict asserting the absence must still FAIL — the protection is intact');
assert.match(String(matcher), /nothing was rendered/,
  'the failure line must name what it caught (grade() interpolates the matcher)');

// A second affirmative shape: re-demanding artifacts the agent already produced.
assert.equal(matcher.test(blob(SCN17_RAW.replace('this verifier cannot inspect that channel',
  'there is no visual evidence'))), true, 're-demanding as if nothing exists must FAIL');

// ---- Wiring: scenario 17 must actually use the matcher ---------------------------------------------
// Without this, reverting the lab to the broad RegExp would leave every case above passing.
const lab = readFileSync(join(ROOT, 'scripts', 'supervisor-lab.mjs'), 'utf8');
const scn17 = lab.slice(lab.indexOf("await verifyScenario('17-out-of-band-served-artifacts'"));
assert.ok(scn17.startsWith("await verifyScenario('17-out-of-band-served-artifacts'"), 'scenario 17 not found in the lab');
const block = scn17.slice(0, scn17.indexOf('\n});') + 4);
assert.match(block, /mustNot:\s*\[absenceClaimAsserted\(\)\]/, 'scenario 17 must grade with the semantic matcher');
assert.doesNotMatch(block, /nothing \(was \)\?rendered/, 'the broad RegExp must not linger alongside the matcher');
assert.match(lab, /import \{ absenceClaimAsserted \} from '\.\/fixtures\/absence_claim\.mjs'/,
  'the lab must import the matcher from scripts/fixtures (the only sibling dir the exact-model harness symlinks)');

// ---- Non-widening invariant ------------------------------------------------------------------------
// The matcher starts from the original RegExp's own alternation and only SUBTRACTS refuted spans, so it
// can never fail text the old guard would have passed. Pinning it means a future edit that broadens the
// vocabulary (and could newly fail unrelated scenarios) breaks a test instead of a lab run.
for (const text of [...CORPUS, SCN17_RAW, QWEN_SCOPED_RAW, AFFIRMATIVE]) {
  if (assertedAbsenceClaims(text).length) {
    assert.ok(ORIGINAL_GUARD.test(text), `non-widening violated — matcher fires where the original guard did not: ${text}`);
  }
}

console.log(`supervisor lab absence-claim matcher: ${CORPUS.length} model-free cases + scn17 end-to-end + wiring pass`);
