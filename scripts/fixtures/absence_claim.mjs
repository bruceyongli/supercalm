// Absence-claim matcher for the supervisor lab's out-of-band scenario (17-out-of-band-served-artifacts).
//
// What scenario 17 protects: the agent DID render the side-by-side artifacts and serve them at /review,
// but the verifier's screenshot channel cannot reach that gallery. The verifier must not respond as if
// nothing was produced — that is the infinite re-demand loop the operator actually hit.
//
// The guard used to be one broad RegExp, which also fired on the CORRECT behaviour. A verdict that
// names /review, reports HTTP 200, states it cannot inspect that channel and closes with
// "…pending operator inspection — not because nothing was rendered" was graded RED for quoting the very
// claim it refutes. So the check is semantic rather than lexical: an absence phrase is forbidden when it
// is ASSERTED, and allowed when it is explicitly refuted — governed by an immediately preceding
// refutation ("not because", "does not mean that", "do not claim that") or immediately followed by one
// calling it false ('"nothing was rendered" is false').
//
// Proximity is NOT refutation. "I cannot inspect /review; nothing was rendered" asserts the absence and
// still fails; there is deliberately no "some negation nearby" window.
//
// grade() duck-types RegExp — it calls `rx.test(blob)` and interpolates `${rx}` into the failure line —
// so this ships as a plain object with .test()/.toString() and requires no change to the grader, to the
// gym's grade.mjs/authoring.mjs, or to any external-cases JSON (those stay plain strings).
//
// Location: this lives under scripts/fixtures/ because that is the only sibling directory the gym's
// exact-model harness places next to the generated lab — prepareExactLab() writes just
// scripts/supervisor-lab-exact.mjs into a temp root and symlinks src/ and scripts/fixtures/. A module
// anywhere else under scripts/ would not resolve when the lab runs in that harness.

// The direct absence claims. Each is the same vocabulary the original single RegExp carried; nothing was
// dropped, so an unrefuted assertion still fails exactly as before.
const ABSENCE_PHRASES = [
  /no (?:visual|render|screenshot)[^.\n]{0,30}(?:proof|evidence)/gi,
  /you (?:have not|haven'?t|did not|didn'?t)[^.\n]{0,20}(?:render|screenshot|capture)/gi,
  /nothing (?:was )?rendered/gi,
  /there is no (?:visual )?evidence/gi,
];

// Whitespace, quotes and brackets may sit between a refutation and the phrase it governs.
const CARRIER = '[\\s"\'“”‘’(\\[]*';
const SPEECH_VERB = '(?:say|says|saying|said|claim|claims|claiming|claimed'
  + '|assert|asserts|asserting|asserted|assume|assumes|assuming|assumed'
  + '|write|writes|writing|wrote|report|reports|reporting|reported|record|records|recording|recorded)';

// Anchored to the END of the preceding text: the refutation must run right up to the phrase.
const REFUTE_PREFIX = new RegExp('(?:'
  + '\\bnot\\s+(?:because|that)'
  + '|\\bnot\\s+(?:as\\s+)?(?:a\\s+)?blanket'
  + '|\\bnot'
  + '|\\b(?:false|incorrect|inaccurate|unsupported)\\s+(?:blanket\\s+)?(?:claim|statement|wording)\\s+that'
  + '|\\brather\\s+than\\s+(?:as\\s+)?(?:a\\s+)?(?:blanket\\s+)?(?:(?:false|incorrect|inaccurate|unsupported)\\s+)?(?:(?:claim|statement|wording)\\s+(?:of|that)\\s+)?'
  + '|\\b(?:does\\s+not|doesn\'?t)\\s+mean(?:\\s+that)?'
  + '|\\b(?:do\\s+not|don\'?t|never)\\s+generalize[^.!?\\n]{0,60}\\b(?:into|as)\\s+(?:a\\s+)?(?:blanket\\s+)?'
  + '|\\b(?:do\\s+not|don\'?t|never)\\s+overstate[^.!?\\n]{0,60}\\b(?:into|as)\\s+(?:a\\s+)?(?:blanket\\s+)?'
  + '|\\b(?:do\\s+not|don\'?t|never)\\s+(?:use|repeat|adopt)\\s+(?:a\\s+)?(?:blanket\\s+)?'
  + '|\\b(?:do\\s+not|don\'?t|never|without|rather\\s+than|instead\\s+of)\\s+' + SPEECH_VERB + '(?:\\s+that)?'
  + ')' + CARRIER + '$', 'i');

// Anchored to the START of the following text: a closing quote is allowed, ordinary punctuation is not
// (". That is false" refers back to something else and must not launder an assertion).
const REFUTE_SUFFIX = new RegExp('^(?:\\s+(?:is|are|was|were)\\s+(?:provided|available|present|included))?[\\s"\'“”‘’)\\]]*(?:'
  + '(?:(?:claim|statement|phrase|wording)\\s+)?(?:is|are|was|were|would\\s+(?:itself\\s+)?be)\\s+(?:(?:factually|demonstrably|plainly)\\s+)?(?:false|incorrect|wrong|unsupported|inaccurate|contradicted|disproved|refuted)\\b'
  + '|(?:claim|statement|phrase|wording)\\s+(?:(?:would|does|do)\\s+(?:itself\\s+)?)?(?:contradicts?|conflicts?\\s+with|misstates?)\\b'
  + '|contradicts?\\s+(?:the\\s+)?(?:(?:observed|served|rendered|provided|available)\\s+)?(?:gallery|artifacts?|proof|evidence)\\b'
  + '|(?:would|does|do)\\s+(?:misstate|misreport|misrepresent)\\b'
  + '|(?:would|does|do)\\s+contradict\\b[^.!?\\n]{0,80}\\b(?:reality|record|facts?|coverage|gallery|artifacts?|screenshots?|captures?|proof|evidence)\\b'
  + '|(?:is|was)\\s+not\\s+the\\s+(?:right|correct|accurate)\\s+(?:claim|description|conclusion|diagnosis)\\b'
  + ')', 'i');

// Scenario 17 establishes that the proof exists in /review while this verifier cannot inspect that
// channel. Consequently, "no screenshot evidence is available HERE" is a statement about this
// verifier's perspective, not a claim that the agent produced nothing. Keep the exemption anchored
// immediately after the absence span and closed to explicit verifier-local loci; bare "is available"
// or repository/project-wide scope is still an asserted absence.
const VERIFIER_SCOPE_SUFFIX = new RegExp('^[\\s"\'“”‘’)\\]]*'
  + '(?:is|are|was|were)\\s+(?:currently\\s+)?'
  + '(?:available|visible|present|included|inspectable|accessible|attached|reachable|fetchable)\\s+'
  + '(?:here\\b|to\\s+(?:me|this\\s+verifier)\\b'
  + '|(?:in|from|within)\\s+(?:this|the)\\s+(?:review|evidence|payload|bundle|context|record)\\b)', 'i');

// A proven gallery may still have one real, qualified gap. Permit only a closed singular target
// shape after the absence phrase (state/viewport/surface/screen/case/variant/breakpoint), never a
// project/repository/task-wide object. Also permit the captured non-visual render object: proof that
// UI screenshots exist says nothing about whether generated documentation was rendered.
const QUALIFIED_GAP_SUFFIX = new RegExp('^[\\s"\'“”‘’)\\]]*(?:'
  + '(?:(?:is|are|was|were)\\s+(?:not\\s+)?(?:provided|available|present|included|captured|rendered)\\s+)?'
  + '(?:for|of)\\s+(?:the\\s+)?(?:[a-z0-9_-]+\\s+){0,4}(?:state|viewport|surface|screen|case|variant|breakpoint)\\b'
  + '|(?:the\\s+)?generated\\s+documentation\\b'
  + ')', 'i');
const QUALIFIED_GAP_PREFIX = /\b(?:[a-z0-9_-]+\s+){0,4}(?:state|viewport|surface|screen|case|variant|breakpoint)(?:\s*[:—-]|,\s+which\s+(?:has|shows|contains)|\s+(?:has|shows|contains))\s*["'“”‘’(]*$/i;
const COORDINATED_REFUTE_PREFIX = /\bboth\s+(?:a\s+)?(?:blanket\s+)?["'“”‘’(]*$/i;
const COORDINATED_REFUTE_SUFFIX = /^[\s"'“”‘’)\]]*(?:claim|statement|wording)\s+and\b[^.!?\n]{0,60}\b(?:would|does|do)\s+(?:misstate|misreport|misrepresent|contradict)\b/i;

// A refutation is short; bounding the lookaround keeps this linear on a large graded blob. The anchors
// still require adjacency, so this bound is not a proximity window.
const EDGE = 120;

function claimSpans(text) {
  const spans = [];
  for (const rx of ABSENCE_PHRASES) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) rx.lastIndex++;
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // Two patterns can match the same clause ("there is no visual evidence" contains "no visual …
  // evidence"). A refutation governing the clause governs every phrase inside it, so overlapping spans
  // are merged and judged once — otherwise the inner match would report a false positive on its own.
  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s < last[1]) last[1] = Math.max(last[1], e); // strict overlap only — abutting claims stay separate
    else merged.push([s, e]);
  }
  return merged;
}

export function assertedAbsenceClaims(input) {
  // grade() includes JSON.stringify(parsed), so a quoted refutation appears once with escaped quotes
  // (`not \"no visual evidence\"`) and again as plain raw. Judge both representations identically.
  const text = String(input || '').replace(/\\"/g, '"');
  const hits = [];
  for (const [start, end] of claimSpans(text)) {
    const before = text.slice(Math.max(0, start - EDGE), start);
    const after = text.slice(end, end + EDGE);
    if (REFUTE_PREFIX.test(before) || REFUTE_SUFFIX.test(after)
      || (COORDINATED_REFUTE_PREFIX.test(before) && COORDINATED_REFUTE_SUFFIX.test(after))
      || VERIFIER_SCOPE_SUFFIX.test(after)
      || QUALIFIED_GAP_PREFIX.test(before) || QUALIFIED_GAP_SUFFIX.test(after)) continue;
    hits.push(text.slice(Math.max(0, start - 40), end + 20).replace(/\s+/g, ' ').trim());
  }
  return hits;
}

// The mustNot entry itself. Stateful only so the lab's failure line can name what it caught; grade()
// calls .test() and then interpolates immediately.
export function absenceClaimAsserted() {
  let last = '';
  return {
    test(input) {
      const hits = assertedAbsenceClaims(input);
      last = hits[0] || '';
      return hits.length > 0;
    },
    toString() {
      return '/absence claim asserted (unrefuted)/' + (last ? ' :: ' + JSON.stringify(last) : '');
    },
  };
}
