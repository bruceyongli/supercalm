# The Improvement Loop

**Audience: an autonomous agent (Claude Code / Codex) improving Supercalm — including itself.**
This is a repeatable, self-amending workflow. Run it top to bottom; log every run in
[`LEDGER.md`](LEDGER.md); step 7 requires you to propose amendments to THIS file. The loop is data-first:
bets must cite evidence from the signal sources below, not vibes.

## Ground rules (non-negotiable)

- Work on a **branch in a checkout that is NOT the live service's working tree** (the live server runs
  its checkout's files directly — switching branches there changes production).
- Every behavior change ships with a **regression lock**: a replay fixture (`test/fixtures/…`) or a pure
  unit test. Pure decision logic stays in dependency-free modules so the harness can run it without
  models or the server.
- **Operator-facing behavior changes are approval-gated** (the doctrine pattern: candidate → operator
  approves → live). Infrastructure changes ship dark or behind config.
- `node scripts/scan-secrets.mjs` + full `npm test` green before any push.
- Prefer **one substantial, finished, measured improvement** per run over several half-done ones.

## Step 1 — SENSE: harvest the signals

Evidence of weakness lives here (query, don't guess):

| Signal | Where | What it tells you |
|---|---|---|
| Verify failures | `verify_labels` table (`false_complete`: fake_done/untested/excuse/partial) | where the verifier gets fooled |
| Suppressed/failed sends | `supervisor_decisions` (suppression_reason ≠ ''), `supervisor_reviews` sent=0 escalations | where the supervisor wanted to act but couldn't/shouldn't |
| Operator overrides | `decisions` rows where the operator answered AFTER a supervisor draft diverged; rejected doctrine (`supervisor_doctrine` status=rejected) | where the supervisor thinks unlike the operator |
| Stall/loop patterns | repeated identical interventions in `supervisor_reviews` (dedup `repeat` counts) | templated paths going dumb (see the keep-working incident) |
| Incidents | `docs/wiki/incident-*.md`, agent-memory | root-caused failures with fixes pending |
| Research | this repo's `docs/improve/research/` digests + fresh sweeps | outside ideas, ranked for OUR mission |

Fresh research sweep (when the ledger's last sweep is >2 weeks old): 2 parallel subagents — product
landscape + papers — each ending with a ranked TOP-5 for Supercalm specifically. Store digests under
`docs/improve/research/YYYY-MM-<topic>.md`. **Don't block on the sweep**: harvest internal signals and
run the panel as soon as they're ready; fold research when it lands and re-panel only if it CONTRADICTS
the chosen bet (amendment, run 1).

## Step 2 — RANK: form bets

Write 3–6 candidate bets as: *problem (with signal citations) → proposed change → expected effect →
how it will be MEASURED → effort (S/M/L) → risk*. A bet without a measurement plan is not a bet.
Also list **quick wins** (≤1h, from research/signals); at most ONE rides along with the main bet per
run, the rest go to the ledger backlog (amendment, run 1).

## Step 3 — PANEL: adversarial multi-model review

Send the bets + mission context to ≥2 different frontier models on the local proxy fleet
(`src/model_catalog.js` routes; e.g. gpt-5.5 + kimi + claude — whatever `/v1/models` serves). Ask each
to: attack the ranking, name what's missing, and pick ONE winner with rationale. Disagreement between
models is information — investigate it before choosing. The final choice is yours, recorded in the ledger.

## Step 4 — BUILD

- Branch `improve/<slug>`. Smallest coherent implementation of the winning bet.
- Reuse existing machinery (grep first): pure-core + thin integration, self-registering route modules,
  the lessons/doctrine lifecycle for anything learned, replay fixtures for anything decided.
- Subagents: use Explore for read-only sweeps, parallel agents for independent slices; keep integration
  (wiring, prompts, migrations) in the primary session.

## Step 5 — MEASURE

Match the measurement to the bet (declared in step 2):
- Decision-policy changes → replay suite (`npm run test:supervisor-replay`) + new fixtures for the change.
- Answer-quality changes → `bin/supervisor-eval.mjs --pairs` against real `decisions.response` ground truth
  (held-out split; report match/partial/escalate deltas).
- Detection/lifecycle changes → reconstruct the triggering incident from live data and show the new
  behavior (the incident-replay pattern).
- Product features → a scripted end-to-end on a scratch session (`~/aios-scratch`) + screenshots via
  `bin/shot.mjs`.
A bet that can't demonstrate its effect gets shipped dark + instrumented, not celebrated.
Measurement harnesses are **repo artifacts** (`scripts/measure/`) so the same script runs pre-merge
(estimate) and post-merge (actual) — never /tmp throwaways (amendment, run 1).

## Step 6 — SHIP

Full suite + secret-scan → push branch → PR-style summary (problem, change, measurement results, risk,
rollback). Merge/release per the operator's standing instructions; anything touching operator-facing
behavior defaults to presenting first.

## Step 7 — RETRO & SELF-AMEND (what makes this loop self-improving)

Append a ledger entry: what was bet, built, measured, learned — including where THIS LOOP wasted effort
or missed. Then propose concrete amendments to `LOOP.md` (add a signal source, drop a step that added
nothing, tighten a guardrail) and apply the approved ones in the same PR. A run that changes the product
but never the loop is only half done.
