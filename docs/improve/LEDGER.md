# Improvement Ledger

Append-only record of improvement-loop runs (see [`LOOP.md`](LOOP.md)). Newest first.

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
- **Loop amendments:** *(step 7)*
