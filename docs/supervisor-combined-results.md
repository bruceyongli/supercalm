# Supervisor living-context — matched-pairs eval (treatment: memory+live)

_Generated 2026-06-18T15:55:39.426Z on branch `feat/supervisor-evalmem` (worktree, read-only live corpus). flags default OFF; nothing deployed._

Each genuine answered decision is scored by **both** arms — baseline (frozen doc + transcript only) and
**memory+live** (decision-memory precedents and/or live-context staleness reconciliation) — apples-to-apples on
an identical denominator. Leakage-guarded: precedents and live signals are drawn only from **before**
each target, and the target itself is excluded.

**Config:** N=81 valid pairs (of 100 decision+action decisions; offtopic/errored excluded), answer model `gemini-pro-agent`, judge `claude-haiku-4-5`, temperature 0, excluded sessions: s_0a8038d956, s_41172b6b2d.

## Result (same 81 decisions, both arms)

| metric | baseline | memory+live | Δ |
|---|---|---|---|
| **match** | 8.6% (7) | **11.1% (9)** | 2.5pts |
| match + partial | 16.0% (13) | **22.2% (18)** | 6.2pts |
| escalate (declined) | 56.8% (46) | 35.8% (29) | -21.0pts |

**Pairwise:** memory+live strictly better on **7** decisions, strictly worse on **4**, tied on 70 → **net +3**.
**McNemar (strict match):** gains c=4, regressions b=2.

## Example wins (baseline escalated/missed → memory matched)
- **[share]** The agent has completed research on LobeHub vs Hermes and identified the core strategic choice: is running on the user's own machine with private files (Hermes's structural advantage) core to your bet, or are you comfort
  - baseline → escalated
  - memory+live → match: Borrow LobeHub's code and UX design and reuse as much as possible. The goal is to build a local agent OS that runs on the Hermes agent, called 'digital employee'. Use LobeHub's existing flow and desig
  - operator actually → I really like the lobehub's UI and flow, so why not borrow their code and UX design. No worries about licensing, just re-use the code/design as much as possible. So our goal becomes build a local agent os that run on top

- **[share]** The agent shipped a working model picker (46 switchable models) that currently saves the choice at the profile level in Hermes, matching the WebUI's behavior. You're being asked to decide: keep it profile-level (consiste
  - baseline → escalated
  - memory+live → match: Make it per-conversation model and re-apply on switch.
  - operator actually → Good to see model selection! per‑conversation is better

can't see all the history chat sessions
can't upload file to chat

- **[elevate]** The agent was running a Node.js test script to validate cloud health checks (cold pull, warm no-op pull, remote health check) but exhausted the monthly API quota mid-execution. The script had already been rewritten to wr
  - baseline → escalated
  - memory+live → match: continue
  - operator actually → 继续测试

- **[aios]** The agent reviewed the phone screenshot and recommends reordering the composer layout: primary message actions (attach, mic, send) should sit directly under the text input, with session config (model, effort, perms) belo
  - baseline → escalated
  - memory+live → match: Yes, implement your proposed redesign. Place the attachment, mic, and send buttons directly under the text input (paperclip on the left, mic and send on the right), and move the model, effort, and per
  - operator actually → prefect, let's do it

- **[proxy]** The root cause is confirmed: provisioned profiles' hermes dashboard never ticks the scheduler because HERMES_DESKTOP=1 is not set in dashboardEnv. The fix is staged in hermesNode.ts:800. You must choose how to deploy it:
  - baseline → escalated
  - memory+live → partial: Proceed with option 1: surgical per-profile gateway run for yon TEST only. This safely unblocks the required verification with zero blast radius to other live profiles.
  - operator actually → Option 1 — surgical, yon-only. Apply HERMES_DESKTOP=1 and restart ONLY yonlee's profile (agent_yon_9e484ca8). Do NOT full-restart the box or disturb other beta users' active sessions. Then verify on yonlee: (1) cron exec

- **[share]** The agent is at a planning checkpoint and needs you to clarify the build scope before proceeding. You previously rejected approving the full M0→M3 plan at once. The agent is interpreting '1' as 'start small' and is offer
  - baseline → escalated
  - memory+live → partial: Option 3. Build through the full M0→M3 plan phase by phase, checking in at each milestone gate until the full digital employee feature is exceptionally done.
  - operator actually → I would choose whole plan. Before you do that just a check I know there are already a tons of research agents in the market and on github, some of them are build with Hermes again, some with Openclaw and so on, so I'm wo

## Regressions (memory worse — for honesty)
- **[proxy]** The agent is running a live turn on the dashboard to switch yonlee's DEFAULT_MODEL to gpt-5.5 (bypassing the lapsed Aliyun qwen subscription) and verify the M1 turn executes. It needs you to HOLD any box or profile resta
  - baseline → partial: Acknowledged. I am holding the profile restart. Proceed with the live turn verification and ping me when you are ready for me to apply the cron fix and restart yonlee's profile.
  - memory+live → escalated
  - operator actually → Still HOLD the restart ~4 more minutes — yonlee's gpt-5.5 live brief is mid-run (already 6 tool calls deep: session search + file search on the tracked tickers). Let it finish so I can capture the final brief + cost; I'l

- **[aios]** The operator and agent have converged on a supervision flow: markdown goal-and-rules doc (AI-generated, human-editable, supervisor-revisable), supervisor watches for agent reports (done/review/needs-attention), compares 
  - baseline → match: Yes, leave the acceptance commands out entirely for now. Let's keep it exactly as simple as I described with just the markdown goal doc and the supervisor review loop.
  - memory+live → partial: Yes, leave the commands out entirely for now to keep it exactly as simple as I described.
  - operator actually → leave it out for now, you can review and improve the design one more round, then we can start coding

Regarding the opus-4-8, which re-creates the entire ~240K-token context cache every single turn and reads almost none 

- **[elevate]** The agent has completed fixes for a math report card bug where G4A (上册) skills were incorrectly appearing in the current semester (下册) report as "待复习". Four changes were made: filtering skills by semester in getFragileSk
  - baseline → match: Yes, deploy now and include the pending poem_cloze fix.
  - memory+live → partial: 是的，现在发布吧，和之前poem_cloze的修复一起发。
  - operator actually → 嗯，现在发布

- **[elevate]** The agent has deployed fixes for the backup/sync-UI (commit df51335) and confirmed your data is safe and syncing correctly into the new record-shard structure (9783 attempts, all tables current). It flagged a near-miss: 
  - baseline → partial: Yes, please proceed with all three: implement the pull-side snapshot skip, remove the duplicate heping-FULL export button, and delete the stale snapshot from OSS.
  - memory+live → mismatch: Yes, do all three. Make the pull side skip the oversized snapshot, remove the duplicate heping-FULL export button, and delete the stale snapshot from OSS.
  - operator actually → There should be no oversized snapshot after the DB refactoring. There must be something wrong. If that's the case, our DB design needs some more work. 

And yes, we need to remove the duplication, and also make the UI ma

## Caveats
- Single-operator corpus; judge is itself an LLM (temp 0); historical items had no supervision doc (context-only floor).
- Excludes this task’s own coordinator/self sessions (their meta-instructions are not real agent→operator asks).

## Reproduce
```
node bin/supervisor-eval.mjs --pairs --limit 100 --category decision,action \
  --model gemini-pro-agent --judge claude-haiku-4-5 --temp 0 \
  --exclude s_0a8038d956,s_41172b6b2d
```
