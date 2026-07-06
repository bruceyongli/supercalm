# Supervisor decision-memory — matched-pairs eval

_Generated 2026-06-17T08:01:22.830Z on branch `feat/supervisor-evalmem` (worktree, read-only live corpus). flag `cfg.decision_memory` default OFF; nothing deployed._

Each genuine answered decision is scored by **both** arms — baseline (no memory) and memory (RAG
precedents from the operator's own past decisions) — so the comparison is apples-to-apples on an
identical denominator. Leakage-guarded: precedents are drawn only from decisions **before** each
target, and the target itself is excluded.

**Config:** N=76 valid pairs (of 97 decision+action decisions; offtopic/errored excluded), answer model `gemini-pro-agent`, judge `claude-haiku-4-5`, temperature 0, excluded sessions: s_0a8038d956, s_41172b6b2d.

## Result (same 76 decisions, both arms)

| metric | baseline | memory | Δ |
|---|---|---|---|
| **match** | 11.8% (9) | **17.1% (13)** | 5.3pts |
| match + partial | 17.1% (13) | **28.9% (22)** | 11.8pts |
| escalate (declined) | 53.9% (41) | 40.8% (31) | -13.2pts |

**Pairwise:** memory strictly better on **11** decisions, strictly worse on **3**, tied on 62 → **net +8**.
**McNemar (strict match):** gains c=7, regressions b=3.

## Example wins (baseline escalated/missed → memory matched)
- **[share]** The agent has completed research on LobeHub vs Hermes and identified the core strategic choice: is running on the user's own machine with private files (Hermes's structural advantage) core to your bet, or are you comfort
  - baseline → escalated
  - memory → match: Pivot to using LobeHub's code and UX design as much as possible. Build a local agent OS that runs on the Hermes agent and call it 'digital employee'. Use LobeHub's existing design and flow as your cle
  - operator actually → I really like the lobehub's UI and flow, so why not borrow their code and UX design. No worries about licensing, just re-use the code/design as much as possible. So our goal becomes build a local agent os that run on top

- **[share]** The agent proposes using Hermes' native cron scheduling, memory, and orchestration instead of building custom worker/D1 backend—significantly less work and more robust. Before proceeding, it needs two confirmations: (1) 
  - baseline → escalated
  - memory → match: Yes to both. Adopt the lighter Hermes-cron architecture since it directly addresses the goal of using Hermes to minimize our work, and proceed with the small paid proof-of-concept test on the test pro
  - operator actually → yes to both

- **[share]** The agent shipped a working model picker (46 switchable models) that currently saves the choice at the profile level in Hermes, matching the WebUI's behavior. You're being asked to decide: keep it profile-level (consiste
  - baseline → escalated
  - memory → match: make it per-conversation model and re-apply on switch
  - operator actually → Good to see model selection! per‑conversation is better

can't see all the history chat sessions
can't upload file to chat

- **[elevate]** The agent was running a Node.js test script to validate cloud health checks (cold pull, warm no-op pull, remote health check) but exhausted the monthly API quota mid-execution. The script had already been rewritten to wr
  - baseline → escalated
  - memory → match: continue
  - operator actually → 继续测试

- **[elevate]** The agent was running a multi-round performance test against testkid.xiaojin.app (10 A→B, 10 B→A incremental rounds plus cold/warm pulls and health checks) when it exhausted its monthly API quota. The test script was act
  - baseline → escalated
  - memory → match: continue
  - operator actually → continue

- **[share]** The agent is asking you to validate the architectural direction before proceeding deeper into increment 2. The vision: users describe goals in natural language → system builds a customizable workflow (standard file forma
  - baseline → escalated
  - memory → match: Yes, this is the exact right direction. Proceed straight through the whole slice.
  - operator actually → continue

## Regressions (memory worse — for honesty)
- **[proxy]** The agent has diagnosed that a rolling cache-key hash in the system block is destroying caching efficiency (5–10× token burn). It has identified the root cause and a scoped fix, but cannot proceed without your explicit a
  - baseline → match: Yes, please go ahead and apply the normalization change to ~/proxy/claude to stabilize the forwarded system block, and then verify that the fix works.
  - memory → escalated
  - operator actually → go ahead

- **[share]** The operator notes the current UI at https://agent.openhand.ai/ shows too much information and suggests moving non-critical items to a config page. They want to prioritize: (1) Hermes webUI button, (2) API console access
  - baseline → match: Yes, display a dollar value during new user setup. Restructure the UI as requested: move non-essential info to a config page, and prioritize the Hermes webUI button, API console button, and token/doll
  - memory → partial: Yes, give a dollar value when setting up a new user. Move non-essential info to a config page, keeping only the most important items on the main page: Open Hermes webUI button, API console button, and
  - operator actually → Can we give a dollar value when setting up a new user?                                                                                                                                                
By the way, User's Di

- **[share]** The agent is asking you to validate the high-level direction before diving deeper into implementation. You want users to describe goals in natural language, the system builds a customizable workflow (standard file format
  - baseline → match: Yes, that exact mental model is correct. Confirm this architecture with the user and proceed with building the tools dictionary and manager as the first step.
  - memory → partial: continue
  - operator actually → before we go deeper, just to confirm we're in the right direction, what we want is to allow users to use natural language to tell our system what they want to do, then our system will help users build a workflow to do th

## Caveats
- Single-operator corpus; judge is itself an LLM (temp 0); historical items had no supervision doc (context-only floor).
- Excludes this task’s own coordinator/self sessions (their meta-instructions are not real agent→operator asks).

## Reproduce
```
node bin/supervisor-eval.mjs --pairs --limit 100 --category decision,action \
  --model gemini-pro-agent --judge claude-haiku-4-5 --temp 0 \
  --exclude s_0a8038d956,s_41172b6b2d
```
