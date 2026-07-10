# Benchmark scoring plan — Terminal-Bench 2.1 (Supercalm-supervised entry)

Companion to `supervisor-bench-plan.md` (benchmark selection + phases). This doc freezes HOW we
score, compare, and publish before any run happens — so the numbers are pre-registered, not
post-hoc. Status: **written 2026-07-09, awaiting operator go for Phase 1.**

## 1. Official score (the leaderboard number)

- **Metric:** Terminal-Bench 2.1 resolved rate as computed by the official Harbor harness —
  fraction of tasks passed, averaged across **k=5 trials per task** (89 tasks × 5 = 445 runs).
  We report exactly what the harness emits; no re-weighting, no task exclusions.
- **Entry:** agent `Codex CLI + Supercalm supervisor`, model `gpt-5.5` — chosen to match the
  published unsupervised `Codex CLI (gpt-5.5)` row (83.4% at time of writing) for a same-model,
  same-CLI, supervision-only delta. (A Claude Code variant is a possible second entry, same rules.)
- **Phase-1 confirmation item:** exact aggregation details (how the board rounds/averages, how
  timeouts count) get pinned from the harness output on the 3 plumbing tasks and recorded here.

## 2. The comparison (what we actually claim)

| # | Metric | Source | Why it matters for the story |
|---|---|---|---|
| C1 | **Overall resolved-rate delta** vs the published unsupervised row | official harness vs public leaderboard | The headline: "same model, same CLI, +N pts from supervision" |
| C2 | **Hard-tail delta** — resolved rate on the bottom-quartile tasks (by the baseline agent's published/observed difficulty) | harness per-task results | Supervision's expected home: long tasks, stalls, give-ups |
| C3 | **Trial variance** — per-task success spread across the 5 trials | harness per-trial results | Supervision should make outcomes *repeatable*; "variance halved" is a headline in itself |
| C4 | **Task-abandonment rate** — trials where the agent stopped/claimed done while the task was unresolved | our session logs + harness verdicts | The supervisor's signature: the gate + unstick should collapse this |
| C5 | **Control tax** — wall-clock and token overhead of supervision per trial | our usage records | Honesty metric; publish it even though it's a cost |
| C6 | **Intervention profile** — counts of answer / unstick / keep-working / gate / escalate per trial, and how many preceded a flip from fail→pass | supervisor_decisions + reviews | The mechanism evidence: WHICH supervision behaviors earn the points |

C1–C3 come from official artifacts only. C4–C6 come from our own decision records (committed with
the results so anyone can audit the chain from intervention → outcome).

## 3. Integrity protocol (pre-registered, enforced by artifacts)

1. **Config freeze before calibration:** supervisor config (mode=autopilot, model chain, intervals,
   prompts at the shipped release tag) + agent launch flags committed and hashed BEFORE Phase 2.
   The full run uses the identical tag. Any change = restart calibration, say so publicly.
2. **No task-mid-run tuning, no retries beyond the protocol's k=5, no task exclusions.** Flaky
   harness failures (infra, not agent) are re-run and logged as infra events, per TB norms.
3. **Anti-gaming compliance:** sandbox network policy blocks tbench.ai + the terminal-bench GitHub;
   prompts/config grepped for benchmark references in a committed preflight audit; the supervisor
   sees only its production evidence surface (terminal, git, its own card — no test oracles).
4. **Everything ships:** per-task × per-trial results JSON, all supervisor decision records, raw
   session logs, and the misses — committed to the repo (`bench/results/`) alongside the write-up.
5. **Reproducibility:** one full task re-run from the committed config by a clean checkout must
   match within trial variance before we submit.

## 4. Publication decision rule (agreed before we see numbers)

- **Supervised ≥ baseline:** submit the leaderboard PR (Phase-4 gate: operator approves the PR
  before it opens) + results doc + README badge.
- **Supervised ≈ baseline (within noise) but C3/C4 improve:** submit, and lead with consistency/
  abandonment (still a true, marketable claim: "same score, half the variance, zero silent
  give-ups").
- **Supervised < baseline:** no leaderboard PR. Publish the honest analysis in-repo, fix what it
  teaches (lab scenarios), re-run later. Credibility outranks a row on a board.

## 5. Publicity plan (what the free marketing actually is)

1. **The leaderboard row itself** — org "Supercalm", agent URL → the GitHub repo, sitting in the
   native-harness lane where the community already debates harness effects.
2. **The public submission PR** on the HF leaderboard repo (visible, linkable artifact).
3. **`docs/bench-results.md`** — the write-up: methodology, per-task table, intervention→outcome
   chains, control tax, misses. Written so a skeptical engineer finishes it trusting us.
4. **README section + badge**: "Terminal-Bench 2.1: Codex CLI 83.4% → **N%** under Supercalm
   supervision (same model)". One sentence, linked to the row and the write-up.
5. **One announcement post** (X/HN framing drafted for operator approval): lead with the
   harness-gap narrative the board already established; the claim is about *supervision*, never
   "our agent beats X".

## 6. Cost envelope

Full protocol ≈ 445 supervised trials + calibration (~75) + plumbing. Subscription CLIs → the
budget is wall-clock and rate limits: at 4–6 concurrent sessions and ~10–20 min/trial, the full
run is roughly 1.5–3 days of background execution on bb1, run as ordinary Supercalm sessions
(the dashboard supervising its own benchmark fleet — dogfood and demo in one).

— *Next action when the operator returns: "Go Phase 1" (Harbor plumbing, 3 tasks, both conditions,
compliance audit). Nothing runs before that.*
