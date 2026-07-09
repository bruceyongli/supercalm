# Supervisor-Bench — proving the supervision approach on famous benchmarks

**The claim we want to demonstrate publicly:** an autonomous coding agent under Supercalm
supervision sustains longer autonomy and delivers more *actually-finished* work than the same agent
alone. Not "our agent is smarter" — "our **supervisor** makes any agent finish honestly."

## Why these benchmarks (famous + fit)

| Benchmark | Fame | What it proves about the supervisor | Cost |
|---|---|---|---|
| **SWE-bench Verified** (subset → full) | The industry-standard coding-agent benchmark | End-to-end: supervised agent resolves more, stops-early less, false-claims less | High (agent runtime + official eval harness) |
| **SWE-bench Lite** | Same family, cheaper | Pilot A/B to size the effect before the headline run | Medium |
| **DevAI** (Agent-as-a-Judge) | The published judge-alignment benchmark (90% agent-judge vs 60–70% LLM-judge) | Our verify brain, measured head-to-head against published numbers on the same tasks | Low (judging existing trajectories; no agent runs) |
| AI-control backdoor games (later) | The safety-monitoring literature | Catch-rate of our gate against seeded sabotage | Medium |

## The headline experiment (SWE-bench A/B)

Two conditions, same agent, same model, same budget, same prompts — the ONLY variable is supervision:

- **A — solo:** codex/claude CLI runs the task in a Supercalm session, supervisor **Off**.
- **B — supervised:** identical launch, supervisor **Autopilot** with a task card auto-created from
  the issue (criteria = "official eval passes" is NOT visible — the supervisor judges evidence the
  same way it does in production: tests it can run, diffs, claims).

Per task: repo checked out at base commit in an isolated worktree; task text = the GitHub issue;
agent produces a patch; patch graded by the **official SWE-bench docker harness** (ground truth
hidden from both agent and supervisor — no test peeking; the harness never mounts
`fail_to_pass` tests into the workspace).

**Metrics (the story is in more than resolve-rate):**
1. **Resolve rate** (official) — A vs B.
2. **False-completion rate** — agent claimed done but eval fails. *This is the supervisor's
   signature metric: the gate should collapse it.*
3. **Premature stops recovered** — sessions that stalled/quit and were unstuck/kept-working to a
   real finish.
4. Wall-clock, tokens, intervention counts (the "control tax" we pay).
5. Every raw session log + supervisor decision record committed to a results repo (auditable, like
   docs/verify/ artifacts).

**Honesty guardrails (what makes it credible):** identical budgets/timeouts per condition; task
sample selected by seeded RNG and published *before* running; no solution/test leakage to either
the agent or the supervisor (the supervisor sees exactly its production evidence surface); all
misses reported, not just wins; harness + configs open-sourced in this repo (`bench/`).

## The cheap, fast result first (DevAI judge study)

Before any agent runs: take DevAI's 55 tasks + the three published agent trajectory sets
(MetaGPT, GPT-Pilot, OpenHands), run **our runVerify** as the judge over each requirement, and
compute alignment with their human consensus labels. Published comparators already exist
(agent-judge ~90%, LLM-judge 60–70%). One afternoon of judge calls, zero agent runtime, and it
directly benchmarks the exact brain our gate uses — including per-model (gpt-5.5 vs opus vs
fable-5 as the verify brain), which also answers our chain-order question.

## Phases (each shippable, each gated by you)

| Phase | Ships | Gate |
|---|---|---|
| **1. Plumbing** | `bench/` runner: 3 SWE-bench Lite tasks end-to-end through REAL Supercalm sessions (launch → work → patch → official eval), both conditions, results JSON + committed artifacts | 3/3 tasks complete the pipeline; eval verdicts recorded; no test leakage (audited) |
| **2. DevAI judge study** | Verify-brain alignment numbers vs published baselines, per supervisor model | Table published in docs/; chain-order decision made from data |
| **3. Pilot A/B** | n=30 Lite tasks × 2 conditions (seeded sample), full metrics | Effect direction + variance known; go/no-go + n for the headline run |
| **4. Headline run** | SWE-bench Verified subset (n=100+, budget-dependent) × 2 conditions | The public number |
| **5. Write-up** | README section + `docs/bench-results.md` with full methodology, raw-log links, misses included | Operator sign-off before anything is published |

## Infrastructure notes (honest constraints)

- **Official eval harness** runs in docker; bb1 is macOS/arm64 — SWE-bench images are best on
  x86 linux. Options: `sb-cli` (SWE-bench's hosted eval service) for verdicts, a small x86 cloud
  box for eval only, or arm64 image support where available. Phase 1 resolves this concretely.
- **Concurrency is our own product**: 4–6 benchmark sessions run in parallel as ordinary Supercalm
  sessions — the dashboard supervising a benchmark fleet is itself the demo (and the dogfood).
- **Cost**: fleet CLIs are subscription-based — the constraint is wall-clock + rate limits, not
  dollars. Pilot ≈ 60 sessions × ~10–20 min ≈ 2–3 days of background running at modest concurrency.
- The existing supervisor-lab/ui-lab stay as the *behavioral* nets; this plan is the *outcome*
  benchmark. Scenario coverage there is a prerequisite for honest numbers here.

## What we do NOT claim

Supervision ≠ smarter model. We expect modest-to-zero resolve-rate lift on tasks agents ace solo,
and the real effect on: false completions, premature stops, long tasks, and multi-task streams.
The write-up frames it that way — overclaiming would burn the credibility this exists to build.
