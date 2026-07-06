# Supervisor redesign — from frozen-doc executor to living-context judgment agent

Branch `feat/supervisor-evalmem` (worktree). System-level change to the supervisor agent (all sessions),
flag-gated (default OFF), reversible, measured by the matched-pairs eval. No deploy from here.

## The flaw (why the supervisor felt meaningless)
The supervisor is a **frozen-doc executor**: its judgment is anchored to a static `doc` written once, and
when unsure it **escalates**. Two failure modes follow:
1. **Enforces stale truth.** Live incident (`s_e8b74301f6`, 2026-06-18): the doc *hardcodes* "flag the
   403 for qwen3.6-plus / 401 node-pairing" as a blocker. The operator cleared exactly that in chat at
   05:11–05:16 ("just rolled the token", "10000 means go", "you're allowed now", "permissions except
   billing"). The frozen doc never learned it, so 1.5h later the supervisor faithfully re-raised a dead
   issue. A doc-executor can never be smarter than its last hand-edit.
2. **Punts instead of deciding.** "Escalate when the doc doesn't delegate" bounces the work back to the
   operator. Requiring the operator to keep the doc current is the same trap — the operator doing the
   supervisor's job.

A meaningful supervisor must be grounded in **live reality** and **decide from the operator's
demonstrated judgment**, not execute a frozen artifact.

## Substrate decision (where "living context" comes from)
**Use the existing always-on DB tables. No dependency on the `knowledge` agent; no operator opt-in; no
new bespoke store.** Confirmed: the `knowledge` agent is *per-project* CONTEXT.md + a wiki, not updated
per message — wrong granularity, and gating the supervisor on a separately-enabled agent makes it
not-meaningful-by-default. Everything needed is already written on every exchange:

| Need | Source (always-on, read-only) |
|---|---|
| Operator's messages | `messages` (direction `in`, source `text`/`voice`/`text+attachments`) |
| Operator's actual decisions | `decisions` (`ask` → `response`) |
| Coding agent's reports/screen | terminal log + `decisions.ask`/`summary` |
| Supervisor's own replies/verdicts | `messages` (source `agent:supervisor`) + `supervisor_reviews` |

Optional enrichment only: a project's `knowledge` CONTEXT.md when present (domain vocabulary) — never required.

## The redesign — four pillars
1. **Live context is first-class; the doc is a seed, not the ceiling.** Each decision reconciles: doc
   (intent) + live delta (operator messages/decisions since the doc) + decision corpus (cross-session
   precedent) + real work state (git).
2. **Staleness reconciliation** *(build first)*. Before enforcing/re-raising any doc constraint, check
   it against newer operator signals; a more recent resolution **supersedes** the doc. The supervisor
   stops re-raising resolved items and (pillar 4) self-updates the doc — the operator never hand-maintains it.
3. **Decisive by default, calibrated escalation.** Act from doc + precedent + live state behind a
   confidence gate. Escalate ONLY the genuinely operator-reserved class (irreversible/costly, true
   product forks with no precedent, explicit un-released gates — e.g. the stray `+1,396/−98` worker
   change and the real M2→M3 sign-off were correctly escalated). **Never re-escalate what the operator
   already answered.**
4. **Closed loop / self-maintaining doc.** Operator overrides + resolutions feed back into the doc's
   "Decisions & agreements" / a "Resolved" section and the corpus, so escalation/override rates fall over
   time and it sounds more like the operator.

## Build order (each flag-gated, default OFF, measured before any default-on)
- **`decision_memory`** — cross-session precedent from `decisions`. *(built; matched-pairs +11.8pts MOP, −13pts escalation, net +8)*
- **`live_context`** — *this build*: within-session staleness reconciliation. `src/agents/live_context.js`
  surfaces the operator's recent in-session signals/resolutions (operator-authored `messages` + answered
  `decisions`, newest-first, timestamped, **window-proof** — pulled directly, not relying on the scroll
  window that let "you're allowed now" fall off). Injected into the ANSWER prompt ahead of everything,
  with the rule: *newer operator signals SUPERSEDE the doc; do not re-raise a resolved item.* Wired into
  `runAnswer` behind `cfg.live_context`.
- **Calibrated escalation + non-repeat** (pillar 3) — next.
- **Self-maintaining doc** (pillar 4) — after, once reconciliation is trusted.

## How the redesign handles the live incident (on its own)
At 06:55 it (a) sees "qwen 403" in the doc, (b) finds the 05:11–05:16 operator resolutions in
`live_context` (window-proof) → marks the blocker **resolved**, doesn't re-raise it; (c) pulls the
gpt-5.5/local-qwen precedent via `decision_memory`; (d) answers "access resolved, proceed"; (e) still
escalates only the stray-worker-change + M2 sign-off — the two genuinely-operator calls. Meaningful.

## Measurement
The matched-pairs eval (`bin/supervisor-eval.mjs --pairs`) is the meaningfulness meter. Treatment arm =
whichever flags are on (`--memory`, `--live`, or both) vs the baseline arm, identical decisions,
leakage-guarded. Track: agreement ↑, escalation-rate ↓, override-rate ↓ (override-rate once dogfooding).
Nothing goes default-on until a clean matched-pairs run shows lift with regressions near zero
(+ the precedent-confidence threshold mitigation from `supervisor-evalmem-DECISION.md`).

## Guardrails
Worktree only; no edits to `/Users/host/aios`; no deploy; live corpus read-only; all flags default OFF;
commit per step.
