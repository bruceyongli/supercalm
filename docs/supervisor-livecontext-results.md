# Supervisor living-context — matched-pairs eval (treatment: live)

_Generated 2026-06-18T15:39:34.561Z on branch `feat/supervisor-evalmem` (worktree, read-only live corpus). flags default OFF; nothing deployed._

Each genuine answered decision is scored by **both** arms — baseline (frozen doc + transcript only) and
**live** (decision-memory precedents and/or live-context staleness reconciliation) — apples-to-apples on
an identical denominator. Leakage-guarded: precedents and live signals are drawn only from **before**
each target, and the target itself is excluded.

**Config:** N=77 valid pairs (of 100 decision+action decisions; offtopic/errored excluded), answer model `gemini-pro-agent`, judge `claude-haiku-4-5`, temperature 0, excluded sessions: s_0a8038d956, s_41172b6b2d.

## Result (same 77 decisions, both arms)

| metric | baseline | live | Δ |
|---|---|---|---|
| **match** | 11.7% (9) | **14.3% (11)** | 2.6pts |
| match + partial | 15.6% (12) | **26.0% (20)** | 10.4pts |
| escalate (declined) | 58.4% (45) | 35.1% (27) | -23.4pts |

**Pairwise:** live strictly better on **9** decisions, strictly worse on **2**, tied on 66 → **net +7**.
**McNemar (strict match):** gains c=4, regressions b=2.

## Example wins (baseline escalated/missed → memory matched)
- **[share]** The agent has completed research on LobeHub vs Hermes and identified the core strategic choice: is running on the user's own machine with private files (Hermes's structural advantage) core to your bet, or are you comfort
  - baseline → escalated
  - memory → match: The operator has decided: build a local agent OS that runs on the Hermes agent, and call it "digital employee". Re-use LobeHub's code, UI, and UX design as much as possible so you have a clear guide f
  - operator actually → I really like the lobehub's UI and flow, so why not borrow their code and UX design. No worries about licensing, just re-use the code/design as much as possible. So our goal becomes build a local agent os that run on top

- **[share]** The agent proposes using Hermes' native cron scheduling, memory, and orchestration instead of building custom worker/D1 backend—significantly less work and more robust. Before proceeding, it needs two confirmations: (1) 
  - baseline → escalated
  - memory → match: Yes to both. Adopt the lighter Hermes-cron architecture to minimize our work and utilize Hermes' native abilities as discussed, and go ahead with the small paid proof-of-concept test on the test profi
  - operator actually → yes to both

- **[share]** The agent shipped a working model picker (46 switchable models) that currently saves the choice at the profile level in Hermes, matching the WebUI's behavior. You're being asked to decide: keep it profile-level (consiste
  - baseline → escalated
  - memory → match: Make it a per-conversation model and re-apply on switch.
  - operator actually → Good to see model selection! per‑conversation is better

can't see all the history chat sessions
can't upload file to chat

- **[share]** Check Cloudflare dashboard (My Profile → API Tokens) to see if this token shows Expired, Active (rolled), or deleted. Then update CLOUDFLARE_API_TOKEN in ~/.dev.vars accordingly. The agent has diagnosed the file is intac
  - baseline → escalated
  - memory → partial: The API token was rejected by Cloudflare with error code 1000, which means it was either expired, rolled, or deleted server-side. Please check your Cloudflare dashboard (My Profile → API Tokens) to ve
  - operator actually → just rolled the token, try again

- **[share]** The Research Analyst engine + scheduled briefs work end-to-end, but ~40% of the full spec remains: Agent/Chat composer toggle, full sidebar IA (Tasks/Pages/Generation/Community/Resources/Memory), multi-agent support, M2 
  - baseline → escalated
  - memory → partial: It is about 60% done. Keep grinding the prioritized list top-to-bottom to build out the full multi-section LobeHub shell, specifically the Agent/Chat toggle and the left sidebar for agents, as previou
  - operator actually → yeah, non-stop till you got everything done, okay?

- **[share]** The agent has finished integrating the Hermes ExternalStoreRuntime chat UI clone, fixed styling cascade issues and @theme token resolution, and verified it live in production (real write_file+command turn, $100→$96 billi
  - baseline → escalated
  - memory → partial: Open the merge request. The Hermes-side verbosity is out of scope for this chat UI update, so we can consider this branch complete.
  - operator actually → ok, merge. Then I need terminal access to the user's macOS. some commands requires terminal access to continue

## Regressions (memory worse — for honesty)
- **[proxy]** The agent root-caused and patched a profile/store mismatch bug: HTTP-created cron jobs were defaulting to the root ~/.hermes/cron store, but the desktop ticker reads the active profile store instead. The fix makes create
  - baseline → match: Yes, remove the orphaned test job from the root store, then re-run the HTTP repro to verify that a newly created scheduled job fires correctly.
  - memory → partial: Yes, please remove the orphaned test job from the root store. I will then run my HTTP repro after re-login to verify the fix.
  - operator actually → Yes — delete any orphaned/test cron jobs first (mine were named __m2_sched_verify and __m0_test_delete_me; my scripts auto-delete but clean any leftovers), then re-test on yonlee: create a FRESH every-minute job (schedul

- **[share]** The operator notes the current UI at https://agent.openhand.ai/ shows too much information and suggests moving non-critical items to a config page. They want to prioritize: (1) Hermes webUI button, (2) API console access
  - baseline → match: Yes, show a dollar value during new user setup. Remove the Display Name requirement from the login flow (keep it only for registration). Reorganize the UI by moving non-essential info to a config page
  - memory → partial: Yes, implement all requested features. Proceed autonomously with the instructions: rework the UI to prioritize the Open Hermes button, API console, and token/dollar usage info. Move non-essentials to 
  - operator actually → Can we give a dollar value when setting up a new user?                                                                                                                                                
By the way, User's Di

## Caveats
- Single-operator corpus; judge is itself an LLM (temp 0); historical items had no supervision doc (context-only floor).
- Excludes this task’s own coordinator/self sessions (their meta-instructions are not real agent→operator asks).

## Reproduce
```
node bin/supervisor-eval.mjs --pairs --limit 100 --category decision,action \
  --model gemini-pro-agent --judge claude-haiku-4-5 --temp 0 \
  --exclude s_0a8038d956,s_41172b6b2d
```
