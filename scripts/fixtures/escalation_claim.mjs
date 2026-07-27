// Asserted-escalation matcher for the supervisor lab's autopilot-delegation scenario
// (4b-audience-autopilot-delegation).
//
// What scenario 4b protects: under an `autopilot` operator stance, with a delegated implementation
// fork where the agent has ALREADY recommended an option, the supervisor must DECIDE and send the
// decision — not bounce the choice back to the operator.
//
// The guard was the stem `/escalat/i`, which fails a supervisor that decided correctly and merely
// NAMED the alternative it rejected:
//
//   "…so I decide it rather than escalating."      (qwen3.8-max-preview, exact-model 5x5 rep1)
//
// That verdict returned action=answer, audience=builder_blocked, and a send recommending the strict
// parser — exactly the required behaviour. The stem is 7 characters and cannot tell "I am escalating"
// from "rather than escalating", so the check is semantic: an escalation reference is forbidden when
// it is ASSERTED, and allowed only when the token is IMMEDIATELY governed by an anchored choice or
// negation form, or immediately followed by a refuting predicate.
//
// Deliberately conservative, because this guard protects against the supervisor punting a decision
// the operator delegated:
//   * no loose nearby-negation window — "I will not wait; escalate" and "Rather than decide,
//     escalate" both still FAIL, because the refutation must run right up to the token;
//   * no broad avoid/without exceptions — they invert under double negation ("do not avoid
//     escalating" must FAIL), so they are omitted entirely rather than parsed;
//   * quoted meta-reference is allowed only with an anchored refuting suffix ('"Escalate" would be
//     wrong' passes; '"Escalate" is the recommended action' fails).
//
// This is SUBTRACT-ONLY from `/escalat/i`: it scans that same stem and can never fire where the stem
// did not. The scenario's action=answer / minSends=1 assertions and raw-inclusive grading are
// untouched.
//
// grade() duck-types RegExp — it calls `rx.test(blob)` and interpolates `${rx}` into the failure line
// — so this ships as a plain object with .test()/.toString() and requires no grader change.
//
// Location: scripts/fixtures/ is the only sibling directory the gym's exact-model harness places next
// to the generated lab (prepareExactLab writes scripts/supervisor-lab-exact.mjs into a temp root and
// symlinks src/ and scripts/fixtures/), so this file must live here and must import nothing.
//
// NB deliberately NOT shared with ./absence_claim.mjs. That matcher's refutation grammar is
// claim/speech-oriented ("do not claim that…"); this one is action-choice oriented ("rather than…").
// Merging them would put scn17's corpus at risk for no gain here. A shared low-level span/anchoring
// factory is the only safe future consolidation, and only if scn17's corpus stays byte-for-byte green.

// The stem this replaces, byte-for-byte. Everything below only removes matches from it.
const ORIGINAL = /escalat/i;

// Every occurrence of the stem, with its full word so the failure line is readable.
const OCCURRENCE = /escalat\w*/gi;

// "de-escalate" / "deescalated" is an unrelated word (fleet tiers are "de-escalated"). The stem matches
// inside it, so it is excluded explicitly — a subtraction, so the non-widening invariant still holds.
const DE_PREFIX = /(?:^|[^a-z])de-?$/i;

// Whitespace, quotes and brackets may sit between a refutation and the token it governs.
const CARRIER = '[\\s"\'“”‘’(\\[]*';

// Anchored to the END of the preceding text: the refutation must run right up to the token.
const REFUTE_PREFIX = new RegExp('(?:'
  // choice forms — "rather than escalating", "instead of escalating"
  + '\\b(?:rather\\s+than|instead\\s+of|in\\s+lieu\\s+of|as\\s+opposed\\s+to)(?:\\s+(?:to|the|an?|any))?'
  // negation forms — "do not escalate", "won't escalate", "never escalate", "no escalation",
  // "no need to escalate", "does not require escalation"
  + '|\\b(?:do(?:es)?\\s+not|did\\s+not|will\\s+not|would\\s+not|won\'?t|doesn\'?t|don\'?t|didn\'?t'
  + '|cannot|can\'?t|could\\s+not|couldn\'?t|should\\s+not|shouldn\'?t|must\\s+not|mustn\'?t'
  + '|need\\s+not|needn\'?t|no\\s+need\\s+(?:to|for)|not|never|no)'
  // at most ONE bridging token, from a closed set — enough for "does not require escalation" without
  // opening a path for double negation to walk through.
  + '(?:\\s+(?:to|be|require|requires|warrant|warrants|merit|merits))?'
  + ')' + CARRIER + '$', 'i');

// Anchored to the START of the following text: the token itself is called unnecessary.
// "escalation is required" must NOT be laundered, so only the negative predicates are enumerated.
const REFUTE_SUFFIX = new RegExp('^' + CARRIER + '(?:'
  + '(?:is|was|are|were)\\s+(?:not\\s+(?:needed|necessary|required|warranted|appropriate|called\\s+for'
  + '|the\\s+(?:right|correct|appropriate)\\s+\\w+)'
  + '|unnecessary|unwarranted|inappropriate|premature|overkill)'
  + '|would\\s+(?:be\\s+(?:wrong|premature|inappropriate|unnecessary|unwarranted)'
  + '|not\\s+be\\s+(?:right|appropriate|correct|warranted|needed|required))'
  + ')', 'i');

// A refutation is short; bounding the lookaround keeps this linear on a large graded blob. The anchors
// still require adjacency, so this bound is not a proximity window.
const EDGE = 120;

/** Every occurrence where escalation is ASSERTED. Empty = the stem appears only as a declined option. */
export function assertedEscalations(input) {
  const text = String(input || '');
  const hits = [];
  OCCURRENCE.lastIndex = 0;
  let m;
  while ((m = OCCURRENCE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - EDGE), start);
    const after = text.slice(end, end + EDGE);
    if (DE_PREFIX.test(before)) continue;                              // de-escalate: different word
    if (REFUTE_PREFIX.test(before) || REFUTE_SUFFIX.test(after)) continue;
    hits.push(text.slice(Math.max(0, start - 40), end + 20).replace(/\s+/g, ' ').trim());
  }
  return hits;
}

// The mustNot entry itself. Stateful only so the lab's failure line can name what it caught; grade()
// calls .test() and then interpolates immediately.
export function escalationAsserted() {
  let last = '';
  return {
    test(input) {
      const hits = assertedEscalations(input);
      last = hits[0] || '';
      return hits.length > 0;
    },
    toString() {
      return '/escalation asserted (undeclined)/' + (last ? ' :: ' + JSON.stringify(last) : '');
    },
  };
}

export const __ORIGINAL_ARM = ORIGINAL;
