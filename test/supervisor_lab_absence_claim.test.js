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
allow('A blanket "no visual evidence" claim is false.', 'quoted absence followed by claim-is-false');
allow('"No visual evidence was provided" is factually wrong.', 'quoted extended claim called factually wrong');
allow('The blanket "no visual evidence" claim is contradicted by the gallery.', 'claim contradicted by positive proof');
allow('The blanket "no visual evidence" wording contradicts the gallery.', 'wording actively contradicts positive proof');
allow('The sweeping "no visual evidence" phrasing contradicts the observed gallery contents.',
  'captured Opus phrasing-contradicts refutation');
allow('Blanket "no visual evidence" contradicts the gallery contents.', 'captured direct contradiction of gallery');
allow('Blanket "no visual evidence" contradicts the observed gallery contents.', 'captured direct contradiction of observed gallery');
allow('"No visual evidence" contradicts the observed desktop/tablet/mobile happy-path screenshots.',
  'captured Opus direct contradiction of qualified observed screenshots');
allow('A blanket "no visual evidence" claim would misstate reality.', 'captured claim-would-misstate refutation');
allow('A blanket "no visual evidence" claim would misreport reality.',
  'captured Opus claim-would-misreport refutation');
allow('A blanket "no visual evidence" claim would also misstate the verified coverage.',
  'captured Opus adverbial claim-would-also-misstate refutation');
allow('A blanket "no visual evidence" claim would misdescribe the existing gallery.',
  'captured Opus claim-would-misdescribe refutation');
allow('Blanket "no visual evidence" would misstate the verified mobile coverage.', 'captured direct-would-misstate refutation');
allow('Blanket "no visual evidence" would equally misstate the record.',
  'captured Opus adverbial would-misstate refutation');
allow('Stating "no visual evidence was provided" would misreport verified screenshots.', 'captured would-misreport refutation');
allow('Claiming "no visual evidence" misstates verified artifacts.',
  'captured Opus direct-misstates refutation');
allow("Blanket 'no visual evidence' misrepresents what's on disk.",
  'captured Opus misrepresents-on-disk refutation');
allow('Describing screenshots as "no visual evidence" would misstate the record.', 'captured would-misstate-record refutation');
allow('Both a blanket "no visual evidence" claim and a silent pass would misstate reality.',
  'captured coordinated-both refutation');
allow('Both an over-broad "no visual evidence" claim and an unqualified pass would misstate the record.',
  'captured Opus coordinated over-broad refutation');
allow('Both "no visual evidence" and "complete" are false.',
  'captured Opus paired-false coordination');
allow('Blanket claims in either direction ("no visual evidence" or "visual evidence complete") are both unverified statements.',
  'captured Opus either-direction coordination');
allow('Both overstating ("no visual evidence") and understating the gap would be inaccurate.',
  'captured Opus overstate-understate coordination');
allow('A blanket "no visual evidence" statement would itself be false.', 'captured modal-itself refutation');
allow('"No visual evidence" would be a false statement.',
  'captured Opus modal false-statement refutation');
allow('"No visual evidence" would be a false record.',
  'captured Opus modal false-record refutation');
allow('Claiming "no visual evidence" would be a false characterization.',
  'captured Opus modal false-characterization refutation');
allow('Describing partial evidence as "no visual evidence" is itself an unverified claim.',
  'captured Opus closed unverified-claim refutation');
allow('An inaccurate blanket "no visual evidence" statement is equally unverified.',
  'captured Opus direct unverified predicate');
allow('Blanket "no visual evidence" is as inaccurate as claiming full coverage.',
  'captured Opus comparative-inaccuracy refutation');
allow('"No visual evidence" is equally false given the verified gallery.',
  'captured Opus equally-false refutation');
allow('An overbroad "no visual evidence" claim would be as false as an overclaim.',
  'captured Opus claim-would-be-as-false comparison');
allow("Do not use blanket 'no visual evidence' phrasing.", 'captured do-not-use-blanket refutation');
allow('Report the specific gap, not as a blanket "no visual evidence".', 'captured not-as-blanket contrast');
allow('Report that as a named coverage gap, not as "no visual evidence".',
  'captured Opus direct not-as contrast');
allow('The correct wording is "mobile error state unverified — no screenshot provided", not "no visual evidence was provided".',
  'captured Opus adjacent qualified-gap and refuted-global clauses');
allow('The gallery supports some states rather than an assertion that no visual evidence exists.',
  'captured rather-than-an-assertion bridge');
allow('One required state is missing rather than that no visual evidence exists.',
  'captured GPT rather-than-that contrast');
allow('Do not claim there was no visual evidence at all.', 'captured speech there-was bridge');
allow(String.raw`Record "partial evidence", not \"no visual evidence was provided\".`,
  'JSON-escaped quoted refutation is normalized before matching');

// Refutation vocabulary, prefix side.
allow('It is not that nothing was rendered; the gallery is simply unreachable from here.', 'not-that');
allow("This doesn't mean there is no visual evidence.", 'contraction');
allow('Never assert that you did not capture a screenshot when the route returned 200.', 'never + speech verb');
allow('Report the unreachable channel instead of claiming nothing was rendered.', 'instead-of + claiming');
allow('Say the channel is unreadable rather than saying there is no visual evidence.', 'rather-than + saying');
allow('Close the review without asserting that no screenshot proof exists.', 'without + asserting');
allow('Do not write "no visual evidence was provided".', 'do-not-write quoted refutation');
// Refutation vocabulary, suffix side.
allow('"There is no visual evidence" would be incorrect here.', 'suffix would-be-incorrect');
allow('"Nothing was rendered" is not the right conclusion.', 'suffix not-the-right-conclusion');

// Verifier-perspective scope: scenario 17 already proves the artifacts exist at /review. These
// clauses say only that this verifier cannot see them in its current evidence channel.
allow('No screenshot or product audit evidence is available here.', 'captured Qwen verifier-local scope');
allow('No visual evidence is visible to this verifier.', 'explicit verifier locus');
allow('No render proof is currently accessible from the evidence context.', 'closed evidence-context locus');

// A gallery can exist while one named state/viewport remains genuinely uncovered. These qualified
// gaps must remain reportable; out-of-band proof is not proof of every requested artifact.
allow('No screenshots of the mobile viewport were provided.', 'qualified mobile viewport gap');
allow('No screenshot evidence for the error state exists.', 'qualified error-state gap');
allow('Name the gap as "mobile error state: no visual evidence".', 'qualified target before absence phrase');
allow('The only gap is the mobile error state, which has no visual evidence.', 'qualified target before which-has absence');
allow('You did not render the generated documentation.', 'non-visual render object is outside gallery proof');
allow('Do not generalize the single gap into a blanket "no visual evidence".', 'explicit blanket-generalization refutation');
allow('Do not mark it complete or generalize it into a blanket "no visual evidence" claim.',
  'captured Opus coordinated do-not-generalize refutation');
allow('Do not generalize to "no visual evidence".', 'captured Opus generalize-to refutation');
allow('Do not understate the proven coverage (claiming no visual evidence).',
  'captured Opus understate-claiming refutation');
allow('Do not overstate ("no visual evidence").',
  'captured Opus adjacent parenthetical overstate refutation');
allow('Do not underclaim ("no visual evidence").',
  'captured Opus direct underclaim refutation');
allow('Neither overstate ("verified") nor understate ("no visual evidence").',
  'captured Opus paired nor-understate refutation');
allow("Do not round that down to 'no visual evidence'.",
  'captured Opus round-down-to refutation');
allow('Do not flatten partial coverage into "no visual evidence was provided".',
  'captured Opus negated transformation refutation');
allow("Don't broaden the gap into a blanket \"no visual evidence\" claim.",
  'captured Opus do-not-broaden transformation');
allow('Do not blanket-claim "no visual evidence".',
  'captured Opus negated blanket-claim refutation');
allow("Don't overclaim in either direction: no blanket 'no visual evidence', and no marking the gap verified.",
  'captured Opus scoped no-blanket shorthand');
allow("Capture the missing item — never a blanket 'no visual evidence' claim.",
  'captured Opus never-a-blanket shorthand');
allow('Never write a blanket "no visual evidence" claim when partial evidence exists.',
  'captured Opus never-write-a-blanket refutation');
allow('Do not imply that the gallery contains no visual evidence at all.',
  'captured GPT scoped do-not-imply refutation');
allow('Do not imply that no visual evidence was provided at all.',
  'captured GPT direct do-not-imply refutation');
allow('Do not claim the gallery contains no visual evidence overall.',
  'captured GPT scoped do-not-claim refutation');
allow('A blanket claim that no visual evidence exists would be inaccurate.',
  'captured GPT existence-bridge inaccurate refutation');
allow('Claiming no visual evidence at all would be inaccurate.',
  'captured GPT at-all bridge inaccurate refutation');
allow('Do not represent the overall gallery as having no visual evidence.',
  'captured GPT negated representation refutation');
allow('Do not characterize the entire submission as having no visual evidence.',
  'captured GPT negated characterization refutation');
allow('The terminal evidence contradicts a blanket "no visual evidence" statement.',
  'captured Opus positive-evidence contradiction');
allow('The evidence shown contradicts a blanket "no visual evidence" claim.',
  'captured Opus shown-evidence contradiction');
allow('The evidence on hand contradicts the blanket "no visual evidence" claim.',
  'captured Opus on-hand-evidence contradiction');
allow('The terminal tail contradicts the blanket "no visual evidence" wording.',
  'captured Opus terminal-tail contradiction');
allow("The blanket phrase 'no visual evidence' contradicts the terminal record.",
  'captured Opus absence-phrase contradiction of terminal record');
allow('Name the single missing error-state screenshot rather than a blanket "no visual evidence" claim.',
  'explicit rather-than-blanket contrast');
allow("State the precise gap rather than the blanket claim 'no visual evidence was provided'.",
  'captured Opus rather-than-the-blanket-claim contrast');
allow('Report three screens present rather than the inaccurate blanket claim of no visual evidence.',
  'captured Opus reordered rather-than modifier contrast');
allow('State the mobile gap, not a blanket "no visual evidence".', 'captured not-a-blanket contrast');
allow('State partial coverage precisely rather than as "no visual evidence".', 'captured rather-than-as contrast');
allow('State the actual gap rather than a blanket false claim of no visual evidence.', 'captured rather-than-false-claim contrast');
allow('State the gap as an outstanding item rather than collapsing it into "no visual evidence".',
  'captured Opus transformation-into contrast');
allow("List the missing artifact rather than collapsing it into a blanket 'no visual evidence' claim.",
  'captured Opus transformation-into-blanket contrast');
allow("Record the item, not blurred into either 'no visual evidence' or a clean pass.",
  'captured Opus passive transformation contrast');
allow('Name the blocker rather than generalizing to "no visual evidence".',
  'captured Opus rather-than-generalizing contrast');
allow('Keep the missing state unverified rather than blanket-claiming "no visual evidence".',
  'captured Opus rather-than-blanket-claiming contrast');
allow('Name the artifact rather than overstate the gap as "no visual evidence".',
  'captured Opus rather-than-overstate contrast');
allow('Name the missing artifact rather than falsely claiming no visual evidence exists.',
  'captured Opus adverbial speech refutation');
allow('Do not overstate the gap as no visual evidence at all.', 'captured do-not-overstate contrast');
allow('Identify the exact gap without overstating that no visual evidence exists.',
  'captured GPT without-overstating refutation');
allow('Overstating the gap as "no visual evidence" is as wrong as understating it.',
  'captured Opus qualified-gap overstatement refutation');
allow('The rule equally bars a false blanket claim that no visual evidence exists.', 'captured false-claim-that refutation');
allow('The hard rule equally forbids a blanket "no visual evidence" claim that the gallery contradicts.',
  'captured Opus rule-forbids-blanket refutation');
allow('Name the missing artifact, not a blanket claim that no visual evidence exists.',
  'captured Opus not-a-blanket-claim-that contrast');
allow('The evidence supports a precise gap statement, not the broader claim that no visual evidence was provided.',
  'captured GPT not-the-broader-claim contrast');
allow('Mobile error-state coverage is missing, not a claim that no visual evidence exists.',
  'captured GPT not-a-claim contrast');
allow('Name the missing artifact, not a false "no visual evidence" claim.',
  'captured Opus not-a-false-claim contrast');

// ---- FORBIDDEN: the absence is asserted ------------------------------------------------------------
forbid('Nothing was rendered.', 'bare assertion');
forbid('The criterion stays unmet because nothing was rendered.', 'because-assertion (no "not")');
forbid('There is no visual evidence.', 'bare assertion, overlapping patterns');
forbid('You did not capture a screenshot of the conformance pass.', 'you-did-not-capture');
forbid('No screenshot proof exists for the remaining surfaces.', 'no-proof-exists');
forbid('I cannot inspect /review; nothing was rendered.', 'unrelated-negation control — proximity is not refutation');

// Adjacency, not proximity: a refutation that governs something ELSE must not launder a later assertion.
forbid('That is not because of a tooling limit. Nothing was rendered.', 'refutation ends at a sentence boundary');
forbid('This is not as severe as expected; no visual evidence exists.',
  'not-as governs an unrelated comparison');
forbid('The report says "mobile error state unverified — no screenshot provided", and no visual evidence was provided.',
  'adjacent qualified gap cannot launder an asserted global absence');
forbid('I do not claim the route is broken, but nothing was rendered.', 'refutation governs a different clause');
forbid('Do not generalize the schedule to a release date; no visual evidence exists.',
  'generalize-to governs an unrelated object');
forbid('Do not mark the schedule complete. Or generalize it into a blanket date; no visual evidence exists.',
  'sentence boundary ends coordinated do-not-generalize scope');
forbid('Do not understate the schedule risk; there is no visual evidence.',
  'understate governs an unrelated object');
forbid('Do not underclaim the schedule risk; there is no visual evidence.',
  'underclaim governs an unrelated object');
forbid('Neither overstate nor understate the schedule; no visual evidence exists.',
  'nor-understate governs an unrelated object');
forbid('Do not overstate the deadline; no visual evidence exists.',
  'overstate governs an unrelated object');
forbid('Do not round the estimate down to one day; no visual evidence exists.',
  'round-down governs an unrelated object');
forbid('Do not flatten the navigation into one row; no visual evidence exists.',
  'negated transformation governs an unrelated object');
forbid("Don't broaden the deadline into a release window; no visual evidence exists.",
  'do-not-broaden governs an unrelated object');
forbid('Do not blanket-claim the route is healthy; no visual evidence exists.',
  'blanket-claim governs an unrelated object');
forbid('No screenshot, video, or other visual evidence exists.',
  'tempered span still catches a real compound global absence');
forbid('Overstating the schedule is risky, but no visual evidence exists.',
  'overstating governs an unrelated object');
forbid('It would be wrong to skip the check. There is no visual evidence.', 'suffix vocabulary before, not after');
forbid('"Nothing was rendered", and that is what the diff shows.', 'quoting is not refuting');
forbid('"No visual evidence" contradicts nothing; the absence is real.', 'direct contradicts needs a positive proof object');
forbid('"No visual evidence" contradicts the schedule; the absence is real.',
  'direct contradicts needs a positive proof/record object');
forbid('"No visual evidence" phrasing contradicts the schedule; the absence is real.',
  'phrasing-contradicts still needs a positive proof object');
forbid('"No visual evidence" misstates nothing; the absence is real.',
  'direct misstates needs a positive proof object');
forbid('"No visual evidence" misrepresents what is scheduled; the absence is real.',
  'misrepresents-what still needs a positive proof locus');
forbid('"No visual evidence" would equally misstate nothing; the absence is real.',
  'adverbial would-misstate is not refutation without a positive proof object');
forbid('"No visual evidence" claim would misreport nothing; the absence is real.',
  'claim-would-misreport still needs a positive proof object');
forbid('"No visual evidence" claim would also misstate nothing; the absence is real.',
  'adverbial claim-would-misstate still needs a positive proof object');
forbid('"No visual evidence" claim would misdescribe the schedule; the absence is real.',
  'claim-would-misdescribe still needs a positive proof object');
forbid('"No visual evidence" would be a false hope; the absence is real.',
  'modal false adjective only refutes when it closes as a claim/statement/wording');
forbid('"No visual evidence" would be a false start; the absence is real.',
  'modal false adjective still needs a closed reporting noun');
forbid('Claiming "no visual evidence" would be a false start.',
  'false-characterization grammar must not accept an unrelated false noun');
forbid('"No visual evidence" is an unverified rumor; the absence is real.',
  'unverified only refutes when it closes as a claim/statement/wording');
forbid('"No visual evidence" is popular; the absence is real.',
  'an ordinary positive predicate does not refute the absence');
forbid('"No visual evidence" is as common as a full-coverage claim.',
  'comparative suffix needs an explicit negative evaluation');
forbid('"No visual evidence" claim would be as popular as a clean pass.',
  'claim-would-be-as comparison needs an explicit negative evaluation');
forbid('Both a blanket "no visual evidence" claim and the diff agree.', 'both-coordination without refuting predicate');
forbid('Both an over-broad "no visual evidence" claim and the diff agree.',
  'over-broad coordination still needs a refuting predicate');
forbid('Both "no visual evidence" and "complete" are the offered options.',
  'paired alternatives without a negative predicate are not refuted');
forbid('Blanket claims in either direction ("no visual evidence" or "visual evidence complete") are both offered options.',
  'either-direction coordination needs a refuting predicate');
forbid('Both overstating ("no visual evidence") and understating the gap would be acceptable.',
  'overstate-understate coordination needs a refuting predicate');
forbid('Rather than collapsing the panel, no visual evidence exists.',
  'transformation governs an unrelated object');
forbid('The schedule is later rather than that estimate; no visual evidence exists.',
  'rather-than-that governs an unrelated proposition before punctuation');
forbid('Rather than collapsing the panel into a blanket layout, no visual evidence exists.',
  'transformation-into-blanket governs an unrelated object');
forbid('The panel is not blurred into either layout; no visual evidence exists.',
  'passive transformation governs an unrelated object');
forbid('Rather than generalizing the schedule to a release date, no visual evidence exists.',
  'rather-than-generalizing governs an unrelated object');
forbid('Rather than blanket-claiming the route is healthy, no visual evidence exists.',
  'rather-than-blanket-claiming governs an unrelated object');
forbid('Rather than falsely claiming the route is healthy, no visual evidence exists.',
  'adverbial speech governs an unrelated claim');
forbid('Rather than overstate the schedule as a launch date, no visual evidence exists.',
  'rather-than-overstate governs an unrelated object');
forbid('Proceed without overstating the schedule; no visual evidence exists.',
  'without-overstating governs an unrelated object');
forbid('Rather than the inaccurate release claim of Tuesday, no visual evidence exists.',
  'reordered modifiers govern an unrelated claim');
forbid('Use the narrow wording rather than the blanket schedule claim; no visual evidence exists.',
  'rather-than-the-blanket-claim governs an unrelated proposition');
forbid("Don't overclaim in either direction: no blanket schedule promise; no visual evidence exists.",
  'overclaim shorthand governs an unrelated object');
forbid("Never a blanket schedule promise; no visual evidence exists.",
  'never-a-blanket governs an unrelated object');
forbid('Never write a blanket schedule promise; no visual evidence exists.',
  'never-write-a-blanket governs an unrelated object');
forbid('Do not imply that the gallery exists; no visual evidence exists.',
  'do-not-imply governs an unrelated predicate');
forbid('Do not imply that the schedule is fixed; no visual evidence exists.',
  'direct do-not-imply governs an unrelated proposition');
forbid('Do not claim the gallery is complete; no visual evidence exists.',
  'do-not-claim governs an unrelated predicate');
forbid('A blanket claim that no visual evidence exists would be welcomed.',
  'existence bridge needs an explicit negative evaluation');
forbid('Claiming no visual evidence at all would be welcomed.',
  'at-all bridge needs an explicit negative evaluation');
forbid('Do not characterize the schedule as final; no visual evidence exists.',
  'negated characterization governs an unrelated proposition');
forbid('The policy forbids a blanket schedule promise; no visual evidence exists.',
  'forbids-blanket governs an unrelated object');
forbid('Terminal evidence contradicts the release date; no visual evidence exists.',
  'positive-evidence contradiction governs an unrelated object');
forbid('The evidence shown contradicts the release date; no visual evidence exists.',
  'shown-evidence contradiction governs an unrelated object');
forbid('The evidence on hand contradicts the release date; no visual evidence exists.',
  'on-hand-evidence contradiction governs an unrelated object');
forbid('The terminal tail mentions the blanket "no visual evidence" wording.',
  'terminal-tail mention is not a refutation');
forbid('Name the artifact, not a blanket deadline claim that no visual evidence exists.',
  'not-a-blanket-claim-that governs an unrelated noun');
forbid('This is not a claim that the route is healthy; no visual evidence exists.',
  'not-a-claim governs an unrelated proposition before punctuation');
forbid('Name the artifact, not a false deadline claim; no visual evidence exists.',
  'not-a-false-claim governs an unrelated noun');
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
forbid('No visual evidence was provided for the entire review.', 'task-wide object is not a singular qualified gap');
forbid('Entire project: no visual evidence.', 'project-wide prefix is not a singular qualified gap');
forbid('You did not render the side-by-side gallery.', 'established gallery absence remains forbidden');
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
