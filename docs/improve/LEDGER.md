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
