# Improvement Ledger

Append-only record of improvement-loop runs (see [`LOOP.md`](LOOP.md)). Newest first.

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
- **Outcome:** pushed on `improve/doctrine-enforcement`, presented for merge.
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
- **Outcome:** shipped on branch `explore/self-improve-1`, presented to operator for merge (operator-
  facing behavior change ⇒ approval-gated per LOOP ground rules).
- **Loop amendments (applied this run):**
  1. Panel may run on INTERNAL signals as soon as they're harvested; fold research when it lands —
     re-panel only if research CONTRADICTS the choice (it complemented it here). Blocking the build on
     slow sweeps wastes the window.
  2. Step 2 gains a QUICK-WINS list (≤1h items from research); at most one rides along per run, rest
     queue to the backlog. (This run: none ridden — governor filled the window.)
  3. Measurement harnesses are repo artifacts (`scripts/measure/`), not throwaways — the same script
     must run pre-merge (estimate) and post-merge (actual).
