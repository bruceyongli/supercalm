# Project Memory — the supervision re-architecture plan

*(replaces the per-session Supervision Doc; panel-hardened over 3 review rounds — see
`docs/improve/research/2026-07-doc-refactor-*.md` for the full trail)*

## 0. The mission this serves

Supercalm supervises the most powerful coding CLIs (Codex CLI, Claude Code, agy). We never
become the coding agent — **we make the coding agents endure.**

The CLIs are sprinters: superhuman inside one session, but a *project* is a marathon of many
sessions over weeks. Between sessions they forget the goal, drift to stale goals, repeat failed
fixes, re-litigate settled decisions, and trip over each other in the same repo. Today our
supervisor inherits those weaknesses because its own memory — the Supervision Doc — is a
per-session prose file that rots.

**This plan gives the supervisor project-grade memory** so its judgment stays sharp for the
whole marathon: always pointed at the *current* goal, verifying against *standing* standards,
aware of what already happened and of the other sessions. That is what "prolong superhuman
autonomy" means concretely: fewer wrong-goal pushes, fewer repeated failures, fewer conflicts,
longer stretches where the CLI runs without you.

## 1. The new pieces, in plain words

| New piece | One sentence | Replaces |
|---|---|---|
| **Task card** | One unit of work: goal + acceptance criteria + constraints, with a status (active / paused / done / abandoned). A session works one *active* card at a time; finished cards are archived, not deleted. | The doc's `# title / ## Goal / ## Now / ## Acceptance criteria / ## Verification notes` |
| **Criteria (per card)** | Each acceptance criterion is its own record with a status (open / satisfied / superseded) and a link to the *evidence* that satisfied it. The gate checks these one by one. | The doc's checkbox list (which went stale as one blob) |
| **Project standards** | Recurring quality bars that apply to *every* task in the project ("UI changes need screenshots", "deploys need the smoke test"). Operator-approved, like doctrine. | The reusable half of `## Hard rules` |
| **Project history** | Small typed records ("task X done", "fix Y failed verification", "deploy", "rollback") written automatically. Looked up when relevant — never pasted wholesale into prompts. | `## Timeline`, `## Decisions & agreements`, `Resolved` |
| **Session runtime facts** | ~150 tokens of live session truth: branch, test command, ports, files being touched. | Nothing (these previously leaked into Hard rules) |
| **Conflict warnings** | When two live sessions touch the same files, both supervisors and you get warned. | Nothing (the 3-agent thrash incident had no defense) |
| **Pre-action gate** | Before the supervisor suggests an approach, it checks history: "this exact fix failed before" gets injected as a warning. | Nothing (the repeat-push loop had no defense) |
| **Repo projection** | The active card is also written into the repo as a *read-only* file (GOAL.md grown up), hash-pinned: if the builder edits it, that's detected and treated as tampering evidence, not as a goal change. | `write_goal_file` GOAL.md |

Storage: all of this lives in Supercalm's database (the supervisor's own, builder-unwritable
store — the judge's contract can't be editable by the judged). The repo projection is a
convenience copy, never the authority.

## 2. Before → after: every piece you know today

### The Supervision Doc & its maintainer

| Today | After | Why |
|---|---|---|
| One markdown doc per session, injected whole into every prompt | Gone. The **active task card** (small, structured) is injected instead | The doc carried 15 finished tasks into every prompt; the card carries one live task |
| `## Now` line (kept lagging reality) | Deleted — the active card *is* "now" | No line to lag |
| `## Hard rules` (4 species mixed) | Split by nature: your taste → **Doctrine** (exists) · recurring bars → **Project standards** (new) · task-only rules → card constraints · fossils/anti-staleness patches → archived | Each species gets the lifecycle it needs; the OpenHand negation line becomes unnecessary |
| `## Acceptance criteria` (stale blob) | Structured **criteria on the card**, each with evidence | The gate can verify item by item; finished criteria retire with their card |
| `## Timeline` / `## Decisions` / `Resolved` | **Project history** events, retrieval-only | History doesn't go stale — it goes *less relevant*; retrieval ranks it instead of injecting it |
| Doc-maintainer (rewrites prose) | **Card-maintainer**: advances card status, *suggests* boundaries ("this looks like a new task — start a card?") with one-tap Accept/Amend/Ignore; `/task` composer command for explicit control | Boundary changes are contract changes — suggested, never silently auto-applied (panel unanimous) |
| Doc templates | Unchanged (they're behavior templates, not docs) | Already decoupled |

### The Supervisor's other organs (mostly untouched)

| Module you know | What happens | Why |
|---|---|---|
| **Completion gate** | Same skeptical gate — but grills the **active card's criteria only**, and records which card version it judged | Kills the stale-goal incident class at the root (focusLine was a patch) |
| **Doctrine / Learning card** | Unchanged. Project standards flow through the *same* approve/triage queue you already use | One approval surface for everything policy-like |
| **Decision memory (precedents)** | Unchanged v1; later tagged with task ids | Already retrieval-only, already scoped right |
| **Attention governor (hot/warm/stale)** | Unchanged v1; later also reads task status (a `done` task never re-verifies) | Governor answers WHEN, cards answer WHAT — clean split |
| **Operator stance / stage awareness / send modes (Off·Observe·Co-pilot·Autopilot)** | Unchanged | Different axis (what you want · when to act · what may send) |
| **Policy decisions (the decide.js records in the panel)** | Same records, now stamped with task id + card version | An audit line must say *which contract* it enforced |
| **supervisor_reviews history** | Unchanged (and it seeds the pre-action gate on day one) | It already contains every past verify-fail |
| **~40 internal state keys (fingerprints, counters)** | Re-scoped from per-session to per-(session, task) | Invisible to you; prevents the old runaway classes (gate re-arm, repeat-push) from returning through the new seam — all 3 reviewers flagged this |
| **live_context** ("recent words beat the doc") | Becomes an **amendment suggestion**: your words that contradict the card produce a proposed card edit, not a silent override | The card is a contract; contracts change by amendment, with audit |

### The Knowledge agent (the line, drawn)

| Question | Answer |
|---|---|
| What does Knowledge own? | **Descriptive** truth: what the codebase *is* — architecture, conventions, how to run things (CONTEXT.md + wiki). Builder-writable, as today. |
| What does the Supervisor own? | **Normative** truth: what should be *accepted* — cards, criteria, standards, doctrine, evidence, history. Builder can never write it. |
| The test | *"Remove the current task — is it still true and useful?"* Yes → Knowledge. It's about a decision/verification/rule → Supervisor. |
| What changes? | The supervisor **starts reading Knowledge** (it can't today!) — via retrieval only, scoped to the active task. Facts it needs for verification (test command, build check) are **pinned onto the card at task start** with provenance, so a mid-task wiki edit can't move the goalposts. A knowledge fact that starts gating completions gets promoted into a project standard (through your approval queue). |

### What the supervisor sees each time it thinks (the context recipe)

- **Always** (~1.5–3k tokens): active task card + session runtime facts + your matched doctrine rules.
- **On demand**: project standards (verifying / drafting a card), history events + precedents + wiki (retrieved when relevant, each stamped with provenance, never allowed to override your words or the card).
- **Never again**: a 15-task scroll of stale prose. The contract is never truncated — if a card outgrows the budget, the gate retrieves criteria individually rather than judging a shortened copy (all 3 reviewers: a truncated contract silently false-passes).

## 3. Multi-session, same project

1. **Inheritance-on-open**: a fresh session on a known project starts with the project's standards, goals, and the open-task list ("resume card X or start new?"). No more from-scratch sessions that re-discover everything.
2. **Conflict warnings**: sessions record which files they touch (from the git diffs we already collect). Overlap between two live sessions → both supervisors warn, you get one escalation naming both sessions. This alone would have prevented the 3-agent thrash incident.
3. **Advisory claims**: a card notes which session is driving it; a second session picking the same card gets a warning (not a lock — hard locks with timeouts were rejected in review: a session running a 15-minute test suite must not lose its task).
4. **Deferred**: enforced worktree isolation (suggested after repeated conflicts, never forced), merge-simulation preflight, automatic autopilot→co-pilot downgrade on conflict.

## 4. Phases (each shippable, flag-gated, reversible)

| Phase | Ships | You'll see | Gate to next |
|---|---|---|---|
| **1. Foundation** (data only) | Tables: tasks, criteria, card versions, evidence, events, standards, session runtime. Repo projection writer + tamper detection. **No behavior change.** | Nothing (flag off) | Schema locks + unit tests green |
| **2. Rescoping** (data only) | Fingerprints/counters re-keyed per-(session, task); decide.js snapshot gains task id + card version; reviews stamped with card version | Nothing | Replay fixtures: old runaway classes stay dead |
| **3. The card goes live** | Card-maintainer; Supervision tab becomes the **Task card view** (active card + archive drawer); gate/answer read the card; boundary suggestions + `/task`; live_context→amendment flow | The panel's doc section becomes a card; suggestion chips appear | A/B on scratch sessions: no false gate-passes; card stays current where the doc lagged |
| **4. Project awareness** | Inheritance-on-open; conflict warnings; advisory claims; supervisor reads wiki via retrieval; verify_facts pinned at task start | New-session modal offers open tasks; conflict banners | Thrash-incident replay: warning fires |
| **5. History + pre-action gate** | Event write path; retrieval into card-drafting/verify; "previously failed" warnings (seeded from supervisor_reviews immediately) | "⚠ this approach failed on 07-03" lines in supervisor messages | Repeat-push replay: warning fires before 2nd identical push |
| **6. Lazy migration** | Touching an old session converts its doc: active card seeded from `## Now`+criteria; history → one archive event; hard-rules classified (≤3 doctrine candidates per **project bundle** in your triage queue; fossils discarded; the doc itself archived verbatim) | One-time "review this session's converted card" prompt per old session | Your existing 19-candidate queue must not flood — caps enforced |

Cut entirely from v1 (with reasons in the research docs): hard task locks/TTL claims, authority auto-downgrade, cross-project doctrine promotion, merge-tree preflight, builder-action boundary detector, eager migration sweep, `close_summary` prose fields.

## 5. How each piece prolongs autonomy (the mission map)

| Piece | Autonomy it buys |
|---|---|
| Task cards | The CLI is always pointed at the *current* goal — no more months-old goals pushed 6×/hour; long sessions stop degrading |
| Per-criterion evidence | "Done" means the same thing in week 4 as in hour 1 — sign-off quality doesn't decay |
| Project standards | Your quality bar applies to every future task automatically — you stop re-teaching it |
| History + pre-action gate | The fleet stops repeating failed fixes — wasted cycles become forward progress |
| Conflict warnings + inheritance | You can run *several* CLIs on one project — the supervisor scales you horizontally |
| Doctrine (unchanged) + standards funnel | Every reply you make compounds into standing judgment — the supervisor keeps growing more *you* |
| Clean context recipe | The supervisor's own model calls stay sharp and cheap — judgment quality is a context-quality problem (the research is unambiguous on this) |

The supervisor never writes code, never picks the CLI's approach, never merges. It holds the
contract, the history, and your taste — and keeps the sprinters running the marathon.

## 6. Risks & rollback

- Every phase behind a feature flag; the legacy doc is archived **verbatim** (event type `legacy_doc`) before any conversion — full restore possible.
- The gate rewire (phase 3) is the risk center: it ships only with the fingerprint rescoping (phase 2) already live, plus replay fixtures for the known runaway classes (gate re-arm, repeat-push, keepworking spam).
- The card-maintainer is a rewrite of the doc-maintainer, not a rename (structured field updates, not prose) — budgeted as such.
- Measurement (improvement-loop rules): prompt-size per review before/after; stale-goal incidents (target: zero); gate false-pass rate on replays; conflict warnings fired vs. real conflicts.
