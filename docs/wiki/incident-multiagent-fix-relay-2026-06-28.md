# Incident: multi-agent "fix-relay" broke the shared codebase (2026-06-28 → 06-29)

Status: **investigation complete, mitigation not yet built.** Operator paused the build to decide
direction; this doc is the durable write-up so we can resume. Sibling: `supervisor-regression-review-2026-06-28.md`
(architecture review) and the `[[supervisor-design]]` memory.

## TL;DR

The operator wired three full-autonomy **codex** sessions against one shared monorepo
(`/Users/host/openhand/share`, the `openhand/` app that deploys to `agent.openhand.ai`): one **fixer**
and two **testers**. The testers relayed bug reports to the fixer; the fixer edited the monorepo and
**deployed to production ≥10 times** in ~10 hours. It was a **thrash loop, not convergence** — each
deploy fixed some reported blockers and regressed others (login broke → was fixed → broke again). The
operator eventually abandoned the relay and hand-repaired the code.

**Supercalm did nothing to stop it.** All three supervisors were `observe_only`, sent **zero** messages, and
the fixer's supervisor wasn't even created until ~29h after launch — *after* the damage. Even a
fully-armed supervisor could not have caught this class: its decision model is single-session and
reactive to completion-claims, with no notion of regression/oscillation, deploy churn, or one agent
being driven by others. There is also no snapshot/rollback safety-net.

## The three sessions

| Session | Role | Task (verbatim, truncated) | Launched |
|---|---|---|---|
| `s_f8b430775e` | **Fixer** | "Fix all errors found in testing from the other codex session and report back to them. Wait for now, you'll receive fix soon" | 2026-06-28 22:14 |
| `s_f83b2fcc00` | Tester (Kendra/DNBeta UX) | "Unresolved proof gaps / current risk … Deploy churn (open)…" | 2026-06-28 03:36 |
| `s_e3de14d126` | Tester (Kevin stock-trader) | "Stock trading employee test: go work on this test and try to exhaust all possibilities…" | 2026-06-28 21:48 |

All three: `tool=codex`, `autonomy=full`, `effort=high/xhigh`, `model=gpt-5.5`, project `p_fe069d8e8b`
(`/Users/host/openhand/share`).

## What happened (reconstructed from the message + event logs)

1. Operator told the fixer to accept fix requests from the two testers and report back after each fix.
2. Testers pushed structured "blocker" reports at the fixer (`messages.direction='in'`, `source='text'`).
   The fixer implemented across the monorepo and **deployed to prod repeatedly**. Distinct deployed
   asset hashes observed across the three sessions' messages (a proxy for deploy count):
   `B0twJWAN, M_kmQb89, D9sQ-9YN, BGuOrCJQ, C-QvDsLK, D2v7Cs7_, CppJumKc, DseO2uxp, Bg5K5OkK, DGHuuEbL`
   = **10 distinct production bundles**.
3. **Oscillation / regression** — the defining symptom. In the fixer's inbound messages:
   - 01:11 `REGRESSION from s_e3de14d126 … login is broken again.`
   - 01:34 `CURRENT RETEST … Login is no longer the main blocker`
   Login (and other flows) flipped broken→fixed→broken as bundles churned. Testers kept replying
   "improved but NOT done" / "still NOT fixed," feeding more edits. No convergence.
4. `openhand` repo took **59 commits** over Jun 28–30 (broad UI/admin/mobile "parity" churn + deploy
   proofs). Working tree is **clean now** — the operator's manual repair landed.
5. Operator's own words at handoff (the fixer's supervision doc goal, set Jun 30):
   *"Fix the production regressions … **without deleting working functionality**."* By the time
   supervision was turned on, firefighting was already underway.

## Root causes — why Supercalm didn't catch or repair it

### 1. Supervisors were passive, and the fixer's ran too late to matter
- All three grants: `config.observe_only = true`. Fixer and Kevin-tester were **not** granted the
  `send-input` capability (`caps_json` = `["read-context","screenshot","model-calls"]`).
- Aggregate across the three sessions: **9,183 `supervisor_decisions` + 212 `supervisor_reviews`,
  `SUM(sent) = 0`.** Not one intervention was ever delivered.
- Fixer's supervisor grant `created_at` = **2026-06-30 03:43**, ~29h after the 06-28 22:14 launch and
  after the breaking spree (06-28 22:14 → 06-29 08:18). Zero supervisor decisions exist for the fixer
  during the damage window.
- The fixer's supervisor did fire **58 `verify.corrective_gap` "challenge"** signals once running — all
  suppressed `observe-only`. It *saw* completion-without-proof and could not act.

### 2. The decision model can't represent this failure class
`src/agents/supervisor/decide.js` is a single-session priority tree. Its entire action vocabulary:
operator-intent (wait/question/continue/ack), `supervisor.hold`, exit/context-window recovery,
`verification.needs_evidence → challenge`, `waiting question → answer`, `review → verify`,
`idle → nudge`. **There is no rule for**: regression/oscillation, deploy churn, ever-widening diffs, or
"this agent is being driven by *other* sessions." The incident is invisible to it by construction.

### 3. No fleet-level view
Each supervisor observes exactly one agent's diff + terminal + screenshot (`observe.js`). Nothing
correlates the **set** of sessions sharing a `project_id`. The fix-relay — the actual unit that was
failing — has no representation anywhere in Supercalm. Worse, `context_guard.js` is deliberately hardened to
**suppress** pushing forwarded-report text (`forwarded-report-context-blocked`,
`stale-doc-context-blocked`), which makes the supervisor *more* passive in exactly this scenario.

### 4. No safety-net for destructive change
`gitGuardrails` was OFF, and even ON it only denies irreversible *git verbs* (`reset --hard`,
force-push, `clean -fd`). It does nothing about shipping a regression via deploy. Supercalm has **no
pre-change snapshot, no known-good checkpoint, and no rollback** — no concept of "revert to the last
verified-good bundle." Once regressions shipped, only a human could undo them.

## Can Supercalm fix such an issue? Yes — three layers (none exist today)

All map onto existing primitives: the supervisor `observe → interpret → decide → dispatch` loop, the
`supervisor_decisions` / `events` tables, and `signal()`.

### Layer A — Detect (cheap, highest leverage)
A new **non-convergence / regression-oscillation signal**, computed in `observe.js` from data Supercalm
already has:
- deploy/asset-hash churn rate (distinct bundles per hour),
- a criterion that went PASS → FAIL again (extractable from tester "REGRESSION"/"broken again" reports),
- diff-size / touched-file-count growth over time,
- commit velocity without a corresponding rise in verified-green states.
Emits `signal('regression_loop', …)` with the evidence bundle.

### Layer B — Circuit-break (the andon cord)
A first-class **fleet** rule `fleet.thrash_detected`, evaluated across sessions sharing a `project_id`
(new: the supervisor needs a project-scoped view, not just per-session). On the Layer-A signal it does
**not** nudge the agent (that adds fuel) — it **holds the fixer and escalates to the operator** with
concrete evidence: *"10 deploys in 9h, login regressed twice, diff now spans 6 files across 3 repos —
pause the relay?"* Works even while individual supervisors are `observe_only`, because the fleet
monitor is its own actor.

### Layer C — Repair / safety-net
Opt-in **known-good checkpoint**: tag/stash the tree at each supervisor-*verified* state, so a detected
regression can offer a one-click revert to the last green asset hash instead of a manual rebuild.
Bigger — touches the deploy/git path — so it's the second phase.

## Recommended phasing

1. **Layer A + B first** (detect + escalate at the fleet level). Fast, no rollback risk, and would have
   pulled the andon cord *hours* before the operator had to intervene by hand.
2. **Layer C** (checkpoint + rollback) second, as the repair net.

## Open questions to resolve before building

- Where does the **fleet monitor** live — a new tick actor keyed on `project_id`, or a project-scoped
  role inside the existing supervisor host? (Leaning: new lightweight project actor; the per-session
  supervisor stays single-agent.)
- How to detect a **fix-relay topology** generically (sessions cross-referencing each other by `s_…` id
  in messages is a strong, cheap signal already present in the data).
- Thresholds for "thrash": deploys/hour, repeated PASS→FAIL on the same named criterion, diff growth.
  Must be conservative — escalate, don't auto-act, in v1.
- Should Layer A also feed the **existing** per-session supervisor as a new `decide.js` rule
  (`agent.regressing`) so even a solo agent gets a hold, independent of the fleet view?

## Appendix — reproduction (host, `~/aios`)

```sh
# Sessions
sqlite3 data/aios.db "SELECT id,tool,autonomy,effort,model,datetime(started_at/1000,'unixepoch','localtime') \
  FROM sessions WHERE id IN ('s_f8b430775e','s_f83b2fcc00','s_e3de14d126');"

# Supervisor was passive: zero sends across all three
sqlite3 data/aios.db "SELECT session_id, SUM(sent) FROM supervisor_decisions \
  WHERE session_id IN ('s_f8b430775e','s_f83b2fcc00','s_e3de14d126') GROUP BY session_id;"

# Fixer's supervisor created ~29h late
sqlite3 data/aios.db "SELECT session_id, datetime(created_at/1000,'unixepoch','localtime'), caps_json, \
  substr(config_json,1,60) FROM agent_grants WHERE agent_id='supervisor' \
  AND session_id IN ('s_f8b430775e','s_f83b2fcc00','s_e3de14d126');"

# Deploy churn (distinct prod bundles mentioned)
sqlite3 data/aios.db "SELECT text FROM messages WHERE session_id IN \
  ('s_f8b430775e','s_f83b2fcc00','s_e3de14d126');" | grep -oE 'index-[A-Za-z0-9_-]{8}\.js' | sort -u
```
