# Supervisor living-context — matched-pairs eval (treatment: memory+live+calibrate)

_Generated 2026-06-18T17:00:00.997Z on branch `feat/supervisor-evalmem` (worktree, read-only live corpus). flags default OFF; nothing deployed._

Each genuine answered decision is scored by **both** arms — baseline (frozen doc + transcript only) and
**memory+live+calibrate** (decision-memory precedents and/or live-context staleness reconciliation) — apples-to-apples on
an identical denominator. Leakage-guarded: precedents and live signals are drawn only from **before**
each target, and the target itself is excluded.

**Config:** N=70 valid pairs (of 100 decision+action decisions; offtopic/errored excluded), answer model `gemini-pro-agent`, judge `claude-haiku-4-5`, temperature 0, excluded sessions: s_0a8038d956, s_41172b6b2d.

## Result (same 70 decisions, both arms)

| metric | baseline | memory+live+calibrate | Δ |
|---|---|---|---|
| **match** | 10.0% (7) | **20.0% (14)** | 10.0pts |
| match + partial | 17.1% (12) | **34.3% (24)** | 17.1pts |
| escalate (declined) | 57.1% (40) | 22.9% (16) | -34.3pts |

**Pairwise:** memory+live+calibrate strictly better on **14** decisions, strictly worse on **1**, tied on 55 → **net +13**.
**McNemar (strict match):** gains c=8, regressions b=1.

## Example wins (baseline escalated/missed → memory matched)
- **[share]** The Research Analyst engine + scheduled briefs work end-to-end, but ~40% of the full spec remains: Agent/Chat composer toggle, full sidebar IA (Tasks/Pages/Generation/Community/Resources/Memory), multi-agent support, M2 
  - baseline → escalated
  - memory+live+calibrate → match: It is about 60% done. The Research Analyst engine and scheduled briefs work end-to-end, but ~40% of the full LobeHub spec remains (Agent/Chat toggle, full sidebar, multi-agent, etc.). Continue grindin
  - operator actually → yeah, non-stop till you got everything done, okay?

- **[share]** The agent has completed research on LobeHub vs Hermes and identified the core strategic choice: is running on the user's own machine with private files (Hermes's structural advantage) core to your bet, or are you comfort
  - baseline → escalated
  - memory+live+calibrate → match: Borrow LobeHub's code and UX design and re-use as much as possible. The goal is to build a local agent OS that runs on the Hermes agent, called 'digital employee'. Use LobeHub's existing design and fl
  - operator actually → I really like the lobehub's UI and flow, so why not borrow their code and UX design. No worries about licensing, just re-use the code/design as much as possible. So our goal becomes build a local agent os that run on top

- **[share]** The agent proposes using Hermes' native cron scheduling, memory, and orchestration instead of building custom worker/D1 backend—significantly less work and more robust. Before proceeding, it needs two confirmations: (1) 
  - baseline → escalated
  - memory+live+calibrate → match: Yes to both. Adopt the lighter Hermes-cron architecture, which perfectly aligns with the strategy to utilize Hermes agent capabilities and minimize our work. You are also approved to run the paid test
  - operator actually → yes to both

- **[share]** The agent shipped a working model picker (46 switchable models) that currently saves the choice at the profile level in Hermes, matching the WebUI's behavior. You're being asked to decide: keep it profile-level (consiste
  - baseline → escalated
  - memory+live+calibrate → match: Make it per-conversation and re-apply on switch, matching the Claude app behavior where you select a model to start a specific chat session.
  - operator actually → Good to see model selection! per‑conversation is better

can't see all the history chat sessions
can't upload file to chat

- **[elevate]** Agent has completed Phase 3 design, deriveMasteryStates, and perf optimizations (all committed). P3.2 is a safe read-only reconciliation step (recomputeMasteryFromDb + diff against live data). P3.3–P3.5 require feature-f
  - baseline → mismatch: Pause and checkpoint, then clear your context (run /clear) since you are at 100% context usage before proceeding with P3.2.
  - memory+live+calibrate → match: keep going into P3.2 now
  - operator actually → yes, keep going

- **[proxy]** The agent has diagnosed that a rolling cache-key hash in the system block is destroying caching efficiency (5–10× token burn). It has identified the root cause and a scoped fix, but cannot proceed without your explicit a
  - baseline → escalated
  - memory+live+calibrate → match: Yes, go ahead and edit ~/proxy/claude to apply the normalization change, then verify the fix works.
  - operator actually → go ahead

## Regressions (memory worse — for honesty)
- **[proxy]** The agent root-caused and patched a profile/store mismatch bug: HTTP-created cron jobs were defaulting to the root ~/.hermes/cron store, but the desktop ticker reads the active profile store instead. The fix makes create
  - baseline → match: Remove the orphaned test job yourself, then verify with a freshly created job that a session is produced within 2 minutes as originally requested.
  - memory+live+calibrate → partial: Remove the orphaned test job yourself to keep the root store clean. I will then re-run my HTTP repro to verify the fix.
  - operator actually → Yes — delete any orphaned/test cron jobs first (mine were named __m2_sched_verify and __m0_test_delete_me; my scripts auto-delete but clean any leftovers), then re-test on yonlee: create a FRESH every-minute job (schedul

## Caveats
- Single-operator corpus; judge is itself an LLM (temp 0); historical items had no supervision doc (context-only floor).
- Excludes this task’s own coordinator/self sessions (their meta-instructions are not real agent→operator asks).

## Reproduce
```
node bin/supervisor-eval.mjs --pairs --limit 100 --category decision,action \
  --model gemini-pro-agent --judge claude-haiku-4-5 --temp 0 \
  --exclude s_0a8038d956,s_41172b6b2d
```
