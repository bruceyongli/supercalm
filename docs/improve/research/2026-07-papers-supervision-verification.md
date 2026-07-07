# Research digest — supervision, verification, rule-learning papers (2026-07 sweep)

Full agent report distilled; arxiv ids verified by the sweep. Ranked for Supercalm.

## Contradicts / refines our current designs
1. **Doctrine-as-prompt is insufficient** — TRACE (2606.13174): 57.5% of applicable preference checks
   violated even WITH memory retrieval; compiling corrections into runtime-enforced checks → 37.6% ID /
   **2.0% OOD** violations, no task-cost. PrefEval (2502.09597): <10% preference adherence past ~10
   turns. ⇒ At approval time classify each doctrine rule enforceable-vs-advisory; compile enforceable
   ones into deterministic gates (PreToolUse denies / send_policy checks / pre-completion checks).
2. **GOAL.md leaks the grading rubric to the graded agent** — SpecBench (2605.21384): agents saturate
   visible tests while hacking persists (gap grows ~28pp per 10× code size); weak-to-strong (2508.19461):
   agent awareness of monitoring degrades it. ⇒ Split supervision doc: agent-visible goal +
   supervisor-PRIVATE held-out acceptance probes; scale review frequency with diff size.
3. **"Tests pass" is weak done-evidence** — PatchDiff (2503.15223): ~30% of plausible SWE-bench patches
   behaviorally diverge from ground truth. ⇒ verify rubric: tests = necessary-not-sufficient; prefer
   behavioral probes of the changed surface.
4. **Consistency ≠ validity for LLM judges** — 2606.19544 (541k judgments): kappa 33–41pp below raw
   agreement; stable judges can be systematically biased. ⇒ validate supervisor verdicts vs operator
   overrides with chance-corrected kappa, per model.
5. **Self-confidence isn't portable** — Act-or-Escalate (2604.08588): act-vs-escalate thresholds are
   model-idiosyncratic. ⇒ characterize each supervisor model's threshold on held-out operator decisions
   before granting send authority; co-pilot's 0.8 gate is per-model, not universal.
6. **More escalation ≠ safer** — Oversight-has-Capacity (2606.08919): inverted-U in escalation rate with
   a fatiguing human; load-aware policies resist escalation flooding. ⇒ instrument escalations/hour +
   act-vs-dismiss precision; bound queue load (the Attention Governor's telemetry).
7. **Late goal questions are worse than never asking** — Ask-Early (2605.07937): goal clarifications
   lose value after ~10% of trajectory; >50% = harmful. ⇒ goal doubts mid-run → HOLD, never a goal
   question to the agent (validates stage-awareness + goal-doubt hold).

## Validations of our shape
- Agent-as-a-Judge (2410.10934): evidence-gathering judges ≈ human reliability vs ~70% for screen-only
  LLM judging — our verify path; argues for read-only TOOL access for the verifier ("dig for truth",
  published form).
- Weak-to-strong (2508.19461): scaffolding > monitor-model capability; pre-flagged human review = +15%
  TPR — the needs-you queue's justification.
- Oversight-in-practice (2606.05391): our four surfaces (preflight/council, dashboard, verify) match
  documented practitioner oversight forms; "tests as guarantees" is the operator blind spot to offset.
- MAST (2503.13657): 14-mode multi-agent failure taxonomy — vocabulary for fleet supervision; their
  LLM-annotator pattern fits auto-labeling our session traces.
- Who&When (2505.00212): automated blame attribution ≈53% agent / 14% step accuracy — fleet root-cause
  automation must stay hypothesis-only for the human.
- GEPA (2507.19457): reflective prompt evolution beats RL with 35× fewer rollouts — the engine for
  optimizing SYS_REVIEW against our verify-failure labels (Bet-2 playbook, research-backed).
- CapCode (2606.07379): "implausibly good" completions are themselves a fake_done signal — cheap rubric line.

## Ranked backlog for future runs
1. Compile doctrine → runtime enforcement (TRACE). 2. Private held-out acceptance probes + behavioral
verification (SpecBench/PatchDiff). 3. Escalation-budget instrumentation + per-model threshold
calibration (2606.08919/2604.08588). 4. GEPA loop on SYS_REVIEW vs labels, kappa-validated.
5. Clarification-timing policy hardening (mid-run = input/constraint only).
