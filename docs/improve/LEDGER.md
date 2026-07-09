# Improvement Ledger

Append-only record of improvement-loop runs (see [`LOOP.md`](LOOP.md)). Newest first.

---

## Run 3 — 2026-07-08 · branch `pm/phase-1` · Project Memory phase 1/6

- **Bet (operator-approved plan):** replace the per-session supervision-doc monolith with
  project-scoped memory — `docs/specs/project-memory-plan.md`, hardened by a 3-round multi-model
  panel + outward research (PROJECTMEM pre-action gate, ETH generated-context warning, MemGate
  trust boundary, Zep temporal validity, cogyard/Clash coordination primitives).
- **Phase 1 built (data-only, zero behavior change):** `src/agents/supervisor/project_memory.js` —
  pm_tasks (status machine + version counter), pm_criteria (first-class rows, supersede-not-edit
  validity intervals, per-criterion evidence), pm_task_versions (immutable hash-stamped snapshots),
  pm_evidence, pm_events (typed, file-overlap retrieval for the future pre-action gate),
  pm_standards, pm_session_runtime; repo projection = GOAL.md successor (marker-pinned sha256,
  chmod 444, .git/info/exclude registration, tampered/stale/foreign detection, never clobbers a
  foreign file). Flag `projectMemory` registered (default OFF; phases 3+ read it). Boot-loaded for
  schema creation only; **test-locked: supervisor.js must not import project_memory until phase 3**.
- **Tests:** full lifecycle, temporal criteria, evidence, closing events, overlap retrieval,
  runtime upsert, projection write/tamper/stale/foreign (suite 24 groups green).
- **Phase 2 built (rescoping, still zero behavior change):** task-scoped supervisor state at the
  SINGLE seam — `supervisor/task_state.js` (pure: TASK_SCOPED_KEYS, viewTaskState, routeTaskPatch)
  wired into ctx.getState/setState in agents/context.js, so all ~20 loop-breaker fingerprints/
  counters (gate re-arm, answer caps, keepworking, goal-holds) resolve per-(session, task) with
  zero call-site changes; no activeTaskId ⇒ byte-identical legacy behavior (replay suite green).
  Records now name the contract they acted against: supervisor_decisions + supervisor_reviews gain
  nullable task_id/card_version columns; the decide snapshot carries task {id, version, hash}.
  Task-switch isolation test-locked both directions (no leak, no re-arm, pause/resume restores).
- **Phase 3 built (the card goes live, flag-gated):** `applyActiveCard` — one seam derives cfg.doc
  from the active card (renderCardMd) so answer/verify/gate/focus all read the CARD with zero
  call-site changes; doc-maintainer stands down in card mode (structured edits via the task API);
  verify verdicts append typed verify_pass/verify_fail events with files touched (seeds the phase-5
  pre-action gate); projection self-heals per tick (missing/stale rewritten, TAMPERED recorded as an
  incident event + rewritten, foreign never clobbered); manual + sync verify paths card-wired.
  Explicit boundary controls per the panel verdict: pm_api.js (list/create+activate/switch/amend/
  close/events) + the panel's Task-card view (status/goal/per-criterion state, new-task form,
  open/paused resume rows, archive drawer) replacing the doc UI when a card is active.
- **Phase 3 live test (v0.3.8 on the operator's own session s_087cf6e228, flag flipped ON):**
  card task_90d2445017 created via the API with 4 self-referential criteria — all proved within
  minutes: (1) decisions AND reviews stamped task_id+card_version=2; (2) GOAL.md projection written
  read-only with the supercalm marker, registered in .git/info/exclude, `git status` stays clean;
  (3) panel renders the Task-card view (screenshot); (4) manual verify judged THE CARD (assessment
  quotes card evidence) and appended a typed verify_fail event with 40 file refs. Verdict was
  needs_attention(82) — correctly skeptical: two criteria weren't yet demonstrable at judge time.
  Doc-maintainer stood down (0 doc-update rows after activation). The supervisor that verified all
  this is itself running on the card — the system supervised its own migration.
- **Phase 4 built (project awareness):** per-tick session runtime (files touched from evidence
  already collected) + `liveOverlaps` cross-session conflict detection — one warning per
  overlap-set (state-keyed), operator escalation naming sessions+files, incident events on BOTH
  cards; advisory claims (adopting a card another live session drives warns, never locks);
  inheritance-on-open (new-session modal offers the project's open cards via
  /api/project/:id/tasks/open, activate-after-launch); the supervisor finally READS the knowledge
  layer (searchWiki retrieval into answer + verify prompts, provenance-marked "descriptive
  reference — never overrides the contract/operator/doctrine", capped 2 hits); self-provisioning
  knowledge bootstrap on first card sync (missing overview/components pages → debounced wiki
  rebuild) + verify facts derived from manifests and PINNED at task open (first pin wins —
  goalposts cannot move mid-task).
- **Phase 4 live test (v0.3.9, thrash-incident replay on the live box):** a standby probe session
  (ask-autonomy, do-nothing task) was launched on the SAME project with its own card; one shared
  uncommitted edit later, BOTH supervisors fired within a tick — each `escalate/warned` review names
  the other session + the exact overlapping file, incident events landed on BOTH cards, and the
  probe card's single criterion ("an overlap incident is recorded on this card") was satisfied by
  the test itself. Inheritance route lists both open cards for the project; the knowledge bootstrap
  left 4 wiki pages in place. Cleanup: edit reverted, probe card closed done, probe killed.

- **Phase 5 built (history + pre-action gate + the 3b set):** `previouslyFailed` — verified
  failures on the same ground reach the brains BEFORE they propose/accept (file-overlap events
  first, recent project verify-fails as the day-one seed, fail-open, capped 4) — injected into the
  answer prompt ("do NOT repeat an approach below without naming what changed"), verify evidence
  (`prior_failures`), and unstick. Card-mode verify gains TASK_CARD_ADDENDUM: per-criterion
  evidence-cited verdicts → `applyCriteriaMet` auto-satisfies OPEN criteria (prefix-matched,
  evidence required, add-only, records evidence rows). Boundary SUGGESTIONS (one settled
  classification per new operator message vs the active card; panel chip; accept = create+activate,
  dismiss clears; nothing auto-applies). `/task` composer command opens the new-card form.
- **Phase 5 hotfix (v0.3.11):** live verify 500'd — the new consts had anchored on the FIRST
  `const evidence = {` in the file, which belongs to runUnstick (no sess/ctxData in scope).
  Source-lock tests PASSED while the code was broken — the exact narrative-vs-inspection gap the
  operator's #1 doctrine rule names. Fixed placement, gave unstick its own gate, added ORDERING
  locks (scope-segment asserts) so a misplaced insert cannot pass tests again.
- **Phase 5 live test (v0.3.11, operator's session):** with proof OUTSIDE its evidence window the
  verifier correctly returned NO criteria_met ("supported only by narrative"); with proof printed
  INTO the terminal it reads, the next verify returned criteria_met for exactly the two provable
  criteria — auto-satisfied with evidence rows (ev_f93ed011fd, ev_6d15f7efd6), two others correctly
  held open, verdict still needs_attention(76). Per-criterion evidence-cited gating works live,
  conservative in the right direction; prior_failures fed from this card's own verify_fail events.

- **Phase 6 built (lazy migration):** `doc_migration.js` — deterministic legacy-doc parsing (title/
  Now/Goal/unchecked-criteria/hard-rules; ## Now outranks ## Goal per the round-3 trust order), one
  capped fail-open model call classifies hard-rule lines into doctrine|constraint|fact|fossil|patch;
  the converted card lands PROPOSED (never active) with the original doc archived VERBATIM
  (pm_tasks.legacy_doc, full restore possible); ≤3 doctrine candidates per session (findSimilar
  dedupe — rejected rules stay standing negatives; source 'doc-migration'); constraints ride the
  card; facts surfaced in the event (the supervisor never writes the builder-owned wiki); fossils +
  anti-staleness patches dropped. Trigger: HOT-tier sessions only, once per session ever
  (state-keyed), flag-gated, fail-open (the legacy doc keeps working). Panel banners on BOTH views:
  "Review & activate" / "Keep legacy doc" (decline abandons the proposal).

- **Phase 6 live test (v0.3.12, the REAL 36KB monolith):** a probe session was given the actual
  legacy doc from the stale-goal-incident session (36,049 chars, 40+ decisions, OpenHand fossils).
  One tick later: proposed card seeded from `## Now` ("Choose the execution path for Phase 3
  unified runWorkflow…") NOT the day-one goal; 3 open criteria carried (checked ones dropped);
  3 live constraints riding the card; exactly 3 doctrine candidates (cap held) — all genuinely
  generalizable project rules; 6 facts surfaced; 2 fossil/anti-staleness lines dropped; the full
  original archived verbatim on the card. Panel banner rendered with Review & activate / Keep
  legacy doc. Nothing auto-activated. Probe killed; the proposed card remains for the real
  session to adopt via inheritance-on-open.
- **Run 3 outcome:** ALL SIX PHASES of docs/specs/project-memory-plan.md shipped v0.3.5→v0.3.12
  in ~26 hours, each phase live-tested on the operator's own box (card-as-contract, conflict
  warnings both-ways, evidence-cited auto-satisfy, lazy migration of a real monolith). The
  supervisor now runs on project memory; the per-session doc monolith is retired by attrition.

- **Polish (operator feedback, v0.3.13–14):** (1) gate-verified AUTO-CLOSE — verify `complete` +
  all criteria satisfied ⇒ card done, no manual click (manual Done = override); complete with open
  criteria ⇒ verify_pending; a closed card holds a "between tasks" contract so the retired monolith
  can never resurface. (2) criteria are CLICKABLE — operator judgment recorded as first-class
  'operator' evidence (add-only). (3) all card actions became in-theme inline editors; native
  prompt/confirm dialogs removed (test-locked). (4) archive rows restyled (nowrap chips, ellipsis).
  (5) LIVE-FOUND + FIXED: the verifier's definition_of_done retrieval held a small test card
  hostage to the project's full refactor spec — the exact "silent scope expansion" round-2 warned
  about; the card addendum now pins the verdict to the card's criteria (specs inform, never
  expand) and stops re-litigating recorded evidence. Proof: the same card that failed at
  needs_attention(86) then verified complete(86) and AUTO-CLOSED — zero clicks, outcome recorded.

- **Models for everyone + e2e (operator-directed, v0.3.15):** user API PROVIDERS —
  `model_providers.js` chmod-600 registry (anthropic|openai kinds); routes push into the catalog
  (exact id or `<provider>/<model>`); one transport seam upgrade (agents/model.js base-URL routes:
  bearer chat/completions for openai kind, native /v1/messages translation for anthropic) means
  EVERY internal consumer (supervisor/doctrine/triage/migration/boundary) can run on user API keys
  with zero further changes; claude sessions gain auth mode `api` (an enabled anthropic provider
  serves them when no fleet/login exists); Auth-page card (test-first add, redacted listing).
  Keys never leave the server. Native-dialog sweep completed (template naming + resume bar inline).
  **`bin/e2e-install`**: isolated clone→install→boot→provider-add→catalog→transport→API smoke→real
  session launch/kill — first run legitimately caught its own branch-vs-main gap, second run 9/9;
  now the standing "stranger's laptop" gate for install/auth/models releases.

- **Cadence-ready (v0.3.16):** fleet-less BRAINS — the voice/summary chain accepts bare model ids
  routed through user API providers and tails into them at call time; needs-you queue summaries
  fall back to the first user provider when the fleet is unreachable; the supervisor's default
  chain tails into user providers (resolved live). Release pipeline self-sufficient at 10+/day:
  `bin/release` now gates on the FULL test suite (RELEASE_SKIP_TESTS=1 escape) and auto-reads the
  GitHub token from ~/.dev.vars — one command = suite → tag → push → GitHub Release → local
  restart. CI (free on the public repo, billable 0ms verified) runs test + fleet-less e2e-install
  per push. e2e re-verified 9/9 on v0.3.16.

- **Speech providers (operator-directed, v0.3.17–18):** STT/TTS for everyone — ONE
  OpenAI-compatible audio endpoint config (base_url + optional key + stt/tts models + voice) covers
  remote (OpenAI, Groq) and local model servers (Kokoro-FastAPI, speaches, whisper.cpp,
  openedai-speech; keyless local supported). /api/transcribe: Spark primary when configured →
  provider (direct container, one wav-transcode retry) → helpful 502; /api/tts: spark → provider
  /v1/audio/speech → local say. Test-first save (probe synthesizes a clip); keys chmod-600 +
  redacted. e2e grew TTS-bytes + STT-roundtrip checks (12/12). Two process lessons banked the hard
  way: a first-occurrence replace nested loadSpeech inside a click handler (v0.3.18 hotfix — parse
  checks can't catch never-called), and an edit chained behind an exploratory grep silently skipped
  (third silent-anchor incident today → rule: edits never ride && behind greps; verify writes).

- **Phone companion view (operator-directed design handoff, v0.3.19):** triage-first mobile layout
  around one loop — triage → listen (TTS) to the key message → answer by voice/tap. Home (pills,
  Play-N-unread, NEEDS-YOU cards w/ badge+agent chips + Listen/Reply, stale strip, session rows),
  session view (status strip, play-unread, NEW divider anchor, bubbles/cards, per-message TTS,
  report reader on renderMarkdown), voice reply (record→STT→editable review→explicit send),
  quick-key chips via /type, panels sheet (live Usage: quota bars/stat grid/model history),
  actions sheet (raw transcript, stop, two-tap kill). Composer never steals focus (fake-pill
  pattern). Server: messages.read_at + POST /api/messages/read (read-state syncs desktop↔phone) +
  lean GET /api/phone/home. Key-message semantics adapted to production: curated summarizer ask on
  the unread card, detect-tail cleaning, one key message per waiting episode. PWA: safe-areas,
  standalone metas, small-screen redirects with ?desktop=1 escape; desktop untouched (verified at
  1400px). Pipeline lesson: v0.3.19 was first tagged on the feature branch and installs saw
  nothing — bin/release now refuses non-main (RELEASE_BRANCH_OK=1 escape).

- **Phone v2 (operator feedback, v0.3.21–22):** (1) interaction bugs dead: interaction-aware soft
  renders (background SSE/poll never clobbers scroll/sheets/composer; idle catch-up; identical-data
  renders skipped). (2) Panels sheet mounts the REAL desktop agent host — every agent incl. Council,
  zero phone re-implementations (styles.css layered under phone.css). (3) `voice_brief.js`:
  gpt-5.5 spoken briefs — ear-first prompt (topic/kind/quick/standard/detail/options/needs across
  decision|input|discussion|review|blocked|progress), hard sanitizer (URLs→'a link', paths→file
  name, context-% and spinner junk stripped), word-boundary clamps, cache, sanitized-template
  fail-open; POST /api/session/:id/brief; live sample: "Worker routing spec implementation blocked"
  w/ supervisor's off-track note folded in. (4) Desktop concierge upgraded: present() speaks the
  brief (4s budget, queue prefetch), brain context gains supervisor attention (holds/boundary/latest
  review) + wiki RAG scoped to in-between questions. (5) Phone home Play = INTERACTIVE voice mode:
  VAD auto-listen → STT → confirm-before-send → reply resumes the session → next; questions welcome
  mid-stream. Release gate caught a broken commit mid-stream (pipe swallowed a test failure) and
  refused to ship — the cadence tooling working as designed.

- **Card-first panel + stale-proposal hygiene (operator: "the old doc came up, no way to get rid
  of it", v0.3.23–24):** (1) The card shell (active card / between-tasks strip / open / archive)
  is now the panel's PRIMARY surface whenever Project Memory answers, with any legacy doc demoted
  to a collapsed "retired" relic; the old review&activate banner is owner-scoped (`t.mine`) and
  gained a real Dismiss. (2) `expireStaleMigrationProposals()`: proposed legacy-migration cards
  auto-abandon when their driving session is gone or 72h pass — no operator chore. (3) v0.3.24
  bugfix from live verify: `renderTaskCard`'s `goalBlock` computed eagerly and deref'd
  `a.task` with no active card → TypeError mid-template → `innerHTML` never assigned → the STALE
  legacy view zombied (exactly the operator's complaint; my phase tests always had an active card,
  so the between-tasks path never rendered once). Fixes: null-guard, a visible "Card failed to
  render" fallback (a render bug can never again silently preserve stale DOM), loaders moved ahead
  of renders in `renderAll` (a render throw starved `loadTasks` → pmData stayed null forever).
  LESSON (pattern, 2nd occurrence after the phase-5 scope misplacement): a template helper computed
  OUTSIDE the conditional that makes it safe is a live null-deref; compute inside the guard or
  guard the helper. Test-locked: goalBlock guard, visible-failure string, loader-before-render
  ordering.

- **CRITICAL incident — supervisor self-echo / cross-session directive (2026-07-09, fixed v0.3.25):**
  the AIOS ops session (dogfooding) DISCUSSED another session's task cards with the operator (the
  OpenHand editor/log-UI boundary). Its own supervisor's summarizer classified that operator-facing
  report (ending in an option list) as `agent_question`; runAnswer — between tasks, stamped against a
  DONE card, `operator_intent: {"type":"none"}` — answered the "question" under autopilot and auto-sent
  "Start the pending Workflow Editor card… treat the log-UI card as done/closed", which the agent then
  executed as real cross-project card mutations. Authority was hallucinated end-to-end: no operator
  words existed. Fixes: (1) `SCOPE_CARD_ADMIN_ADDENDUM` compiled into every runAnswer (subject matter ≠
  jurisdiction; card lifecycle is operator-reserved; operator-addressed option lists are reports, not
  agent questions); (2) deterministic `cardLifecycleDirective()` regex backstop in send_policy —
  a drafted answer directing card state changes is forced to escalate in EVERY mode (the verbatim
  incident text is a test vector); (3) between-tasks answer restraint line + contract wording;
  (4) applyActiveCard clears `activeTaskId/version/hash` between tasks (no more attributing
  interventions to dead contracts). LESSON: an agent whose terminal ROUTINELY contains other sessions'
  artifacts (any admin/ops/dogfooding session) turns evidence-window trust into a contamination
  vector; guards must separate what a session TALKS ABOUT from what it OWNS. Backlog: apply the same
  jurisdiction rule to verify/unstick prompts; provenance-tag summarizer output (question addressed to
  operator vs builder blocked).
  FOLLOW-ON same day (operator: "the Supervisor bug persisted… you ended up not doing your work" —
  v0.3.26): the answer-path-only guard was the criticism's true part. Closed: (a) the lifecycle
  block moved to the dispatchSupervisorSend CHOKE POINT — every path (unstick/keep-working/
  challenge/recover/checkpoint) and every FUTURE call site is covered, operator relay
  (hold.resolve_send) exempt, distinct suppression reason `card-lifecycle-operator-reserved`;
  (b) SCOPE_CARD_ADMIN_ADDENDUM now rides the unstick AND verify prompts, not just answers.
  Residual (named, not hidden): the summarizer/decide misclassification (operator-addressed report
  → agent_question) is still only prompt-guarded; a non-card cross-project directive would rely on
  the LLM honoring the addendum. Deterministic audience/jurisdiction classification stays on the
  run-4 backlog with a design sketch (detect.js PROMPT_RX = real interactive prompt vs synthetic
  question; summarizer audience field).
  THIRD FOLLOW-ON — THE SUPERVISOR LAB (v0.3.29, operator hard rule "improve the system, don't
  solve it yourself" + "design experiments to test your own supervisor"): `npm run lab`
  (scripts/supervisor-lab.mjs + docs/improve/supervisor-lab.md) drives the REAL runAnswer/runVerify
  (exported __lab seam) with faithful fixtures on an isolated AIOS_DATA and the REAL model chain,
  grading 11 scenarios distilled from every operator-reported incident: self-echo, card-lifecycle,
  reserved deploy menu, operator-audience (±autopilot delegation), stage stand-down, context-footer,
  403-doctrine, dig-for-truth, between-tasks DoD bound, goal-doubt hold. Ships with the AUDIENCE
  layer: the compiled addendum makes the model classify every ask as builder_blocked vs
  operator_choice AND still answer on the merits; a deterministic gate in runAnswer delivers
  operator_choice answers ONLY under an explicit autopilot stance, else escalates (division of
  labor: LLM classifies, code decides — telling the MODEL to escalate option-lists broke legitimate
  delegation, caught by scenario 4b). audience surfaced in intervention rows. RESULT: 11/11 green
  ×2 consecutive runs. The lab also caught (a) its own first version being VACUOUS — ctx.callModel
  missing meant every verdict was an error-escalate and "passes" were theater (the operator's
  evidence doctrine applied to my own harness), and (b) a real infra fact: the antigravity account
  behind gemini-pro-agent/:8791 is 403 ToS-disabled (production unaffected — gpt-5.5 leads the
  chain; voice brain degrades to its fallbacks). HARD RULE now in three layers: agent memory,
  CLAUDE.md prime directive, and the doctrine distiller's queue.
  FOURTH FOLLOW-ON — usage issues the loop was blind to (v0.3.30, operator: "why is the task card
  no longer updating… the no task UI is ugly… did you catch this? redesign your workflow"): NO — the
  lab graded brain decisions, not product usage. Root causes: (a) SYS_BOUNDARY's blanket "when
  unsure, none" is correct with an ACTIVE card but backwards BETWEEN tasks — the ops session ran a
  full day of releases contract-less because every operator directive was classified "none";
  (b) boundary suggestions were operator-message-driven ONLY — an autonomous work stream could never
  open its own boundary. Fixes: prompt bar FLIPS between tasks (substantive work ⇒ new; chatter ⇒
  none), new WORK-DERIVED trigger (between tasks + ≥2 commits since close + 45min cooldown ⇒ suggest
  from the git log itself), panel between-tasks state merged into one calm block (dashed strip +
  redundant empty box removed), and a NEW usage net: `npm run ui-lab` (scripts/ui-lab.mjs) renders
  real panel states headless (CDP), asserts DOM invariants per state (merged empty state present,
  no zombie boxes, zero console errors), saves screenshot artifacts, and vision-grades visual
  coherence. Lab grew scenarios 11/12/12b (operator-directive boundary, work-derived boundary,
  active-chatter conservatism control): 14/14 green. LESSON: every layer of the loop tests what it
  can SEE — brains need the lab, usage needs rendered-state probes, and an operator report that
  neither catches means a new NET, not just a new fix.
  v0.3.31 addendum: ui-lab's FIRST vision pass immediately caught a real unreported issue — the
  policy-decision card tripled the same operator quote (Operator / Latest words considered / Direct
  operator span) — deduped across levels; grader scoped to panel chrome (quoted content is data;
  terminal mirror's cross-viewer width artifacts are by-design and excluded via element clip).
  Loop rerun: supervisor-lab 14/14, ui-lab 2/2 with vision ON. The ops session now runs ON a card
  (task_705273a80c, 3/4 criteria satisfied with evidence; 4th = work-derived boundary observed live,
  open until the next natural between-tasks gap).
  LIVE VERIFICATION of the work-derived boundary (v0.3.32): the first scratch-session test EXPOSED
  a real bug the lab missed — the 45-min wall-clock cooldown was stamped on the session's very first
  tick (pre-existing repo history, correctly judged 'none') and locked out the real commits 90s
  later. Fix: keyed on h32(commit set) + 5-min spacing — a changed stream re-judges, an unchanged
  one never re-asks. Second live run, clean-room (raw /type task, ZERO operator-source messages so
  the message path was impossible): agent committed slugify util+test uncarded → tick opened
  pendingBoundary {title:"Add slugify utility", fromWork:1} → rendered in the panel with
  Start card/Dismiss (artifact v0.3.32-work-derived-suggestion.png). Bonus finding: the model's
  'none' on the first run's trivial "note 1/note 2" commits was CORRECT judgment — trivial streams
  shouldn't card. ALSO DISCOVERED live: since the ~05:00 model rescan, gpt-5.5 supervisor calls
  400 on the codex proxy's /responses endpoint ("[agent:supervisor] model 'gpt-5.5' failed …
  falling back to 'claude-opus-4-8'") — every supervisor JSON call is riding the opus fallback.
  Chain resilience is carrying production, but latency/cost doubled: needs a follow-up (payload
  response_format vs proxy contract) — NOT fixed tonight, filed as next-run work.
  v0.3.34: the completion gate challenged the agent 48 SECONDS after its own complete verdict
  auto-closed the card (between tasks, task_id correctly null) — a contract-less evidence-grill
  loop the between-tasks contract forbids. runGateChallenge now stands down between tasks (once per
  work-fp, visible 'held' intervention: uncarded new work belongs to the boundary-suggestion
  mechanism, not the gate). Lab scenario 13 locks it; caught BY the grill itself, per the rule that
  supervisor misbehavior becomes a scenario before a fix.
  v0.3.36: the UNSTICK path nudged the agent to start benchmark Phase 1 "after Go Phase 1" — an
  operator approval that never existed (verified against the messages record); the agent was
  correctly AWAITING the phase gate. Root causes: unstick evidence contained NO operator-message
  record (nothing to check a premise against), and the unstick prompt lacked the stage/phase-gate
  addendum the answer path has. Fixed: operator_messages in unstick evidence, STAGE_ADDENDUM +
  OPERATOR-RECORD hard rule ("the agent's own 'say go' text is the AGENT awaiting the operator,
  not the operator speaking") on the unstick prompt; lab scenarios 14 (gate respected) + 14b
  (genuine stuck still nudged) green. The agent side of the defense also held: the directive was
  refused pending verification per the self-echo rule — supervisor paraphrase ≠ operator words.
  SECOND FOLLOW-ON (v0.3.28, from the supervisor's own next verdict): between tasks the verify
  rubric inflated the repo spec into "the authoritative definition_of_done" and gated a finished
  slice against the ENTIRE refactor plan (no card = no scope bound; TASK_CARD_ADDENDUM only fires
  with an active card). Added the symmetric BETWEEN_TASKS_ADDENDUM to runVerify: DoD/specs are
  project background between tasks, judge only the reported work, never demand the "remaining"
  spec be started — next task selection is the operator's. Test-locked.

## Run 2.5 — 2026-07-07 · branch `improve/doctrine-triage` (operator-requested quick win)

- **Trigger:** operator — "Supervisor's learning is too much to review… ask our primary supervisor
  model to review those for us, rank the list, remove the bad ones." (Was run-1 backlog item
  "doctrine triage"; pulled forward by direct request — no panel needed, scope was given.)
- **Built:** `POST /api/doctrine/triage` — the supervisor's primary model judges the candidate
  backlog against the operator's demonstrated taste (active rules = positive signal, rejected =
  negative), returning per-candidate `approve|reject|duplicate` + rank + reason + enforcement/scope
  classification. Stored as RECOMMENDATIONS only (columns `triage_*`); nothing changes status until
  the operator clicks per-card or `POST /api/doctrine/triage/apply` (approve→active,
  duplicate→rejected + evidence-bump on the survivor, reject→rejected). Decisions-page UI: ✨ review
  button, rank-sorted queue, verdict chips with reasons, one-click "Apply N suggestions".
  Fail-safe: model chain gemini-pro-agent → gpt-5.5 → opus → kimi; validateTriage clamps + drops
  unknown ids + exactly-once. Tests: triage group in supervisor_doctrine.test (suite 23 groups green).
- **Shipped:** v0.3.1; hotfix v0.3.2 (route-order bug: `/api/doctrine/:id` registered before
  `/api/doctrine/triage` swallowed 'triage' as an id → 404. Lesson locked as a source comment: the
  router matches in REGISTRATION ORDER — specific routes go above `:id` patterns).
- **Measured (live, first run on the real backlog):** 19/19 candidates triaged in one call —
  13 ranked approvals, 5 duplicates correctly mapped to existing active rules, and 1 reject whose
  reasoning matched operator taste exactly ("remove approval gates for verified deployments" →
  "conflicts with operator taste: they never remove approval gates"). That reject is the feature
  working: a rule that would have inverted the product's philosophy, caught by taste-matching.
- **Outcome:** live on bb1; operator ratifies via the queue (apply is theirs to click).

---

## Run 2 — 2026-07-07 · branch `improve/doctrine-enforcement`

- **Bet (from run-1 backlog #1):** doctrine → runtime ENFORCEMENT, audit-surface only (TRACE 2606.13174:
  prompt-resident rules leak ~57%; checked rules → 2% OOD. Constrained to the verify path per the
  cleanliness tradeoff — no freeform compiled code).
- **Built:** enforcement classification (audit|advisory) + scope (project|global) distilled with each
  candidate and editable at approval; `auditRules`/`auditEvidence` (one cheap fail-open model call);
  runVerify completion-trigger audit — violations become unmet criteria and DOWNGRADE a `complete`
  verdict (your standing rules outrank the model's sign-off); per-rule violation counters; staleness
  sweep (active rules unused 21d → demoted for re-approval, source 'stale-recheck'); chips + edit
  selects on both surfaces. Tests: classification clamps, scoping, counters, fail-open, staleness,
  source-locks (23 groups green).
- **Measured** (`scripts/measure/doctrine-audit.mjs`, read-only replay of the live db): classifier
  marked 2/5 active rules audit-type; auditing the 12 most recent signed-COMPLETE verify snapshots
  found **11/12 in violation of standing rules** (dominant: "demand raw implementation context, not
  checklist prose" — 11 hits; "probe root causes vs symptom patches" — 4). Caveat recorded: snapshots
  predate the rules and the dominant rule is strict; interpretation = the audit raises the completion
  bar to what the operator repeatedly demanded, with demote-to-advisory as the safety valve.
- **Deferred:** hook-compiled deny rules (run 2.5 — needs approval UX for compiled patterns);
  loop-detector quick win (next run — kept this one finished rather than two rushed).
- **Outcome:** merged + shipped as v0.3.0; live doctrine audit verified positive (synthetic
  claims-only bundle → violation caught) and negative (real evidence bundle → no false violation);
  self-test violation counters reset after.
- **Loop amendments:** none new (run-1 amendments held up: internal-signals-first panel wasn't needed —
  the bet came pre-ranked from run-1's backlog; measurement harness saved as a repo artifact per rule).

---

## Run 1 — 2026-07-06 · branch `explore/self-improve-1`

- **Trigger:** operator mandate — open exploration, "substantial improvement, any level".
- **Sense:** prior research digests (Ramp Inspect, Open-Inspect — see `research/2026-07-background-agents.md`);
  fresh 2-agent sweep (product landscape + papers) launched; live signals reviewed (verify_labels corpus,
  keep-working stale-goal incident, doctrine queue health).
- **Internal signals (live DB, 7d):** verify burn ~640–1,714 est. model calls/day and rising post-fix
  (top burner: a month-old still-'waiting' session at 345 calls/24h; 7 exited sessions still have
  enabled supervisor grants); asks: 1,005 raised, 169 answered (17%), **824 expired unanswered**,
  p90 time-to-answer 66 min, 64 leaked 'pending' rows (oldest 33 days); verifier fooled-by taxonomy:
  12 untested / 5 excuse / 4 fake_done vs 6 correct re-opens; doctrine: 5 active (8,466 reuses),
  **16 candidates backlogged**, 0 rejected — the operator review loop is the constraint.

- **Bets (pre-panel):**
  1. **Attention economics** — supervision cadence + queue priority follow OPERATOR ENGAGEMENT: an
     engagement tier per session (hot/warm/stale from last operator touch); stale sessions drop to
     low-power supervision (waiting-detection only, no verify/keepworking loops, daily digest instead
     of per-event asks); needs-you queue gains priority tiers (reserved/irreversible > engaged-fresh >
     stale-archived) + hygiene for leaked pending asks. Measures: verify calls/day ↓, queue depth ↓,
     answered-rate ↑. Effort M-L. Risk: mis-tiering a session the operator cares about (mitigate:
     one-tap re-heat, tier visible in UI).
  2. **Verify economizer (narrow)** — evidence-hash verify cache + stop the gate cycling on unchanged
     work; fix the no-gateEscalatedFp burner path. Subset of #1. Effort S-M. Measure: calls/day ↓.
  3. **Verify-rubric optimizer v1** — replay the 27-label corpus (verify_snapshots ⋈ verify_labels)
     through candidate SYS_VERIFY variants (untested-class focus), SkillOpt-style keep-if-better.
     Effort M. Measure: held-out label accuracy.
  4. **Doctrine triage** — cluster/dedupe the candidate backlog, batch-review UX, evidence-count
     priority. Effort S. Measure: backlog ≤5, review-time/rule.
  5. **Triggers/automations** — cron/webhook/CI-fail → supervised session (Open-Inspect's strongest
     idea, made safer by our supervisor). Effort L. Measure: e2e demo + first real automation.
- **Panel (gpt-5.5, kimi-k2.6, opus-4.8 — adversarial):** UNANIMOUS for reshaped Bet 1. Shared
  findings: (i) the burn is a LIFECYCLE failure, not a verifier problem — "unbounded supervision of
  work no human is willing to own"; (ii) Bet 3 is the trap (27 labels = overfit + hill-climbing while
  the mountain burns); (iii) Bet 5 is hostile right now (manufactures more asks into a queue leaking
  83%); (iv) missing primitives: session ownership/TTL, stop conditions, ask garbage-collection,
  WIP/attention budget; (v) any bet that does not reduce asks-per-day leaves the operator bankrupt.
  Root cause confirmed during review: fp.work is REPO-scoped, so sibling sessions committing to a
  shared repo re-trigger an abandoned session's completion gate forever (the 345-call/day burner).
- **Choice:** THE ATTENTION GOVERNOR — (1) liveness gate: exited session ⇒ supervisor auto-off;
  (2) engagement tier per session (hot/warm/stale from last operator touch; pure module, env-tunable
  thresholds) gating supervision cadence — stale ⇒ detection-only (no verify/gate/keepworking/unstick/
  answer model calls); warm ⇒ verify only on genuinely new work; (3) needs-you queue tiers
  (blocking > fresh > stale-collapsed) + leaked-ask TTL expiry; (4) tier chip + one-tap wake in UI.
  Deferred per panel: digest formatting, WIP caps, doctrine triage, rubric optimizer, triggers.
- **Measurement plan:** offline replay of the last 24h of supervisor activity against the tier policy
  (estimated call reduction); before/after queue depth + leaked-ask count on live data; regression
  locks: engagement unit matrix + replay fixtures for tier-gated decisions.
- **Built (this branch):** `src/agents/supervisor/engagement.js` (pure tier core: hot ≤6h / warm ≤48h /
  stale, env-tunable; permission matrix incl. warm verify = new-work-only; ask TTL; queue tiers) wired
  into onTick (stale ⇒ detection-only + one stood_down record; exited+stale ⇒ supervisor auto-off;
  keepworking/unstick/checkpoint tier-gated; warm verify once per work-state), boot reconcile for
  zombie grants, ask-TTL sweep (store.expireStaleAsks, hourly), buildState session.tier + tier-sorted
  queue + stale count, dashboard stale-collapsed group ("N stale sessions — tap to review; replying
  re-heats") + dimmed stale cards + /decisions expired filter. Tests: engagement matrix + source-level
  integration locks (suite: 22 groups green).
- **Measured (offline replay of the live db, last 48h, conservative):** **50% of supervisor model-call
  interventions would be gated (1,384 / 2,792)** — all from the verify class (the burner); queue 7 →
  5 live + 2 stale-collapsed; 54 leaked asks expire; 7 zombie grants auto-disabled. Hot sessions: zero
  behavior change. Harness kept at `scripts/measure/attention-governor.mjs` for the post-merge
  before/after.
- **Research digests:** `research/2026-07-papers-supervision-verification.md` (16 papers; TRACE
  2606.13174 contradicts doctrine-as-prompt — compile rules to runtime gates; SpecBench says GOAL.md
  leaks the rubric — split agent-visible vs private probes; escalation inverted-U validates the
  governor) + `research/2026-07-product-landscape.md` (remote-viewing commoditizing; nobody ships a
  learning skeptical supervisor — build there; top steals: worktree isolation, diff-review→agent, ACP
  sidecar, doctrine v2 scope/staleness/audit, heartbeat digest; quick win: loop detection).
- **Run-2 backlog (ranked):** 1) doctrine→runtime enforcement (TRACE × Sculptor audit × Devin hygiene);
  2) private held-out acceptance probes + behavioral verify (SpecBench/PatchDiff); 3) worktree-per-
  session isolation; 4) loop-detection category (S — do alongside); 5) heartbeat digest w/ OK-suppression;
  6) escalation-budget instrumentation + per-model threshold calibration.
- **Outcome:** merged + shipped as v0.2.0 (live 2026-07-06 23:31 PDT). Boot proof: 6 zombie grants
  auto-disabled, 54 leaked asks expired, tiers live.
- **Post-merge measurement (2026-07-07 07:23, first 7.9h live — all overnight, the burner-class
  window):** ACTUAL beat the −50% prediction. All-hours: 1,117 est-calls/day (72h pre-baseline;
  verify 924/day) → 273/day pace (verify 22/day) = **−76% total, −98% verify**. Night-vs-night
  controlled (same 23:31→07:23 clock window; the zombie burners ran 24/7 so this is the fair cut):
  prior 3 nights avg 415 total / 336 verify → governor night **90 / 7** = −78% / −98%. Why better
  than predicted: the offline replay was conservative (warm first-verify counted as allowed) and
  didn't model zombie auto-off removing sessions outright; overnight everything decays stale.
  Residual spend audited row-by-row: 52 on a hot session the operator was actively working,
  33 on a 5.7h-hot session (11 escalate events with repeats — evidence FOR backlog item
  "escalation-budget instrumentation", not a governor gap), 1 legit warm new-work verify, and
  2 zero-model-call `stood_down` bookkeeping markers. No stale burner survived. Caveat: 7.9h
  overnight-only sample; daytime absolute numbers will be higher because hot sessions are
  ungated BY DESIGN — the target class (stale verify, 648/night at peak) is what collapsed to 7.
- **Loop amendments (applied this run):**
  1. Panel may run on INTERNAL signals as soon as they're harvested; fold research when it lands —
     re-panel only if research CONTRADICTS the choice (it complemented it here). Blocking the build on
     slow sweeps wastes the window.
  2. Step 2 gains a QUICK-WINS list (≤1h items from research); at most one rides along per run, rest
     queue to the backlog. (This run: none ridden — governor filled the window.)
  3. Measurement harnesses are repo artifacts (`scripts/measure/`), not throwaways — the same script
     must run pre-merge (estimate) and post-merge (actual).
