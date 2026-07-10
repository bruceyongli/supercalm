# Benchmarking the supervisor on EXISTING famous benchmarks (no custom benchmark)

**Operator direction (2026-07-09):** do not build our own benchmark. Pick suitable, famous,
*existing* LLM benchmarks — mission-fit (supervising coding agents in terminals), with public
leaderboards so a good result is real, free marketing. (Reference point: skillopt used
SearchQA/Sheet/Office/DocVQA/LiveMath/ALFWorld — generalist-agent boards; we go mission-focused.)

## The pick

| Priority | Benchmark | Why it's the one | Marketing surface |
|---|---|---|---|
| **1** | **Terminal-Bench 2.1** (tbench.ai) | Mission-identical: agents doing real work in a terminal — literally what Supercalm supervises. The leaderboard's own narrative is "the harness matters more than the model" (Codex CLI @ GPT-5.5: **83.4%**; same model under Terminus-2 harness: **76.4%**). A supervision entry competes in exactly that lane. **The unsupervised baseline is already on the board** — we only run our condition. | Public leaderboard row: "Codex CLI + Supercalm supervisor" with org + repo URL; submission is a public HF PR; the harness-gap story is pre-sold |
| **2** | **SWE-bench Verified** | The most famous coding-agent benchmark, period. Heavier infra (docker eval, x86), more saturated board — do it after TB proves the effect | Leaderboard + the standard citation everyone recognizes |
| (internal) | DevAI judge-alignment | Not marketing (niche) — kept only as a cheap internal check of the verify brain if we want it; NOT a headline | — |

## Terminal-Bench entry — how it works

- **What we submit:** agent = `Codex CLI under Supercalm supervision` (and/or Claude Code variant),
  model = gpt-5.5 (matching the published unsupervised row for a clean same-model comparison).
- **Harness integration (the Phase-1 plumbing):** Terminal-Bench 2.1 runs via the **Harbor**
  framework; tasks execute in docker sandboxes. Our custom Harbor agent launches the CLI inside the
  sandbox's tmux and runs the supervisor loop against that tmux (supervisor sidecar in-container, or
  host Supercalm reaching the sandbox tmux socket; model calls to the fleet via host networking).
  The supervisor sees exactly its production evidence surface — terminal, git, its own card.
- **Rules compliance:** ≥5 trials per task (`-k 5`); the agent must not access tbench.ai or the
  terminal-bench GitHub (anti-gaming) — enforce via the sandbox's network policy + a preflight
  grep of our prompts; submission PR to the HF leaderboard repo with `metadata.yaml`
  (agent URL = github.com/bruceyongli/supercalm, org = Supercalm, models listed).
- **The claim we can honestly chase:** same model, same CLI, supervision as the only delta.
  Expected effect concentrates in the hard tail (long tasks, stalls, premature give-ups) — TB 2.1's
  89 tasks × 5 trials gives per-task variance to show it.

## Phases (operator-gated, as always)

| Phase | Ships | Gate |
|---|---|---|
| **1. Harbor plumbing** | Harbor + terminal-bench-2-1 running locally; our custom agent wrapper runs Codex CLI in-sandbox WITH the supervisor attached, end-to-end on 2–3 tasks; rules-compliance audit (no benchmark-site access; evidence surface unchanged) | 3 tasks complete under both bare-CLI and supervised runs; artifacts committed |
| **2. Calibration run** | ~15-task subset × 5 trials, supervised; compare per-task vs the published Codex CLI row; tune nothing mid-run (config frozen & committed first) | Effect size + variance known; go/no-go |
| **3. Full run** | All 89 tasks × 5 trials, supervised | The number |
| **4. Submission + write-up** | HF leaderboard PR; README/results doc with per-task breakdown, all misses included, raw logs archived | **Operator approves the public submission before the PR opens** |
| (5. later) | SWE-bench Verified, same pattern | separate gate |

## Cost & constraints (honest)

- 89 tasks × 5 trials ≈ 445 codex runs for the full board (plus plumbing/calibration). Fleet CLIs
  are subscription — the budget is wall-clock + rate limits; run as parallel Supercalm sessions
  (the dashboard supervising the benchmark fleet is itself the dogfood demo).
- Harbor sandboxes are docker; bb1 is arm64 macOS — TB tasks are generally arch-agnostic
  containers, but Phase 1 verifies before we commit to the full run.
- Risk stated up front: supervision may move short tasks very little; the honest result may be
  "flat median, big tail effect + fewer premature stops." We publish whatever it is — a flat
  result with a credible methodology still buys more trust than an overclaimed one.

## What we do NOT do

No custom benchmark. No cherry-picked task subsets in anything public. No tuning between
calibration and the full run. No submission without the operator's explicit approval of the PR.
