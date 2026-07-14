# Autonomous integrate-&-deploy — plan

Status: **approved, building MVP-first (2026-07).** Owner: multi-session-collaboration workstream.
Companion: [`docs/wiki/release-system.md`](../wiki/release-system.md) (release system), the
multi-session Phase-1 isolation (shipped, `src/worktrees.js`), and the fix-relay incident
[`docs/wiki/incident-multiagent-fix-relay-2026-06-28.md`](../wiki/incident-multiagent-fix-relay-2026-06-28.md)
(why this must be safe).

## Goal
**Any agent session ships its branch to `main` without a human doing the merge.** The human
authorization gate is replaced by (a) a **strict procedure** and (b) a **multi-agent adversarial check
pipeline**; **rollback** is the mandatory safety net. Everyone can deploy; nobody hand-merges.

## The one principle that makes it safe
A self-deploying server (AIOS restarts itself on deploy) is only sound as an **external durable state
machine** — persisted stages, idempotent boot-recovery, fencing, external health checks — **never a
detached child**. The dominant failure is **"false certainty after partial success"**: `main` advances,
the server restarts, in-memory lock/orchestration state is lost, health is briefly/incorrectly marked
green, and the ledger then advertises an unsafe rollback target. Therefore: **merge, deploy, and health
are separate PERSISTED states; "the process returned" never means "green."** And: **deterministic gates
before AI reviewers — safe before smart.** (Design reviewed by gpt-5.6-sol.)

## 1. Durable state machine
SQLite (WAL, `synchronous=FULL`). Every transition is one transaction + one immutable event row.

```sql
integrations(
  id, source_ref, source_sha, base_sha, candidate_sha, previous_green_sha,
  stage, attempt, fence_token, owner_boot_id, heartbeat_at,
  checks_digest, deploy_started_at, health_deadline,
  rollback_sha, failure_code, failure_detail, created_at, updated_at
);
integration_events(id, integration_id, from_stage, to_stage, data, at);   -- immutable audit
health_probes(integration_id, boot_id, served_sha, status, detail, at);
```

**Stages:**
`QUEUED → PREPARING → CHECKING → APPROVED → PUBLISHING → MAIN_PUBLISHED → RESTART_REQUESTED → VERIFYING → GREEN`

**Failure paths:**
- before publication → `REJECTED`
- after publication → `ROLLING_BACK → ROLLBACK_PUBLISHED → ROLLBACK_RESTART_REQUESTED → ROLLBACK_VERIFYING → ROLLED_BACK`
- unsafe/ambiguous → `HELD` (page a human; blocks the queue)

External actions use **intent/result** stages: persist `PUBLISHING` *before* the CAS push of
`old-main → candidate`, then reconcile after. `bin/deploy` takes an **exact SHA** and does **no** mutation
beyond that deploy (version bump happens *before* checks, on the candidate).

## 2. Boot recovery + fencing
`flock` ownership does **not** survive the self-deploy restart (the FD dies with the old process). So on
boot, **before accepting any deploy request**: acquire the flock, mint a new `boot_id`, find the single
non-terminal integration (a `UNIQUE`-style active-row invariant), **increment `fence_token`**, and
reconcile: compare git `main`, the deployed/served SHA (§4), and the persisted `stage` →
resume checks / verify an already-restarted candidate / or `HELD` on ambiguity. **No worker holding a
stale fence token may write.** Fencing + the active-row invariant — not the lost flock — define the new owner.

## 3. Multi-agent check pipeline (replaces the human gate)
Runs against an **isolated worktree** of the candidate **rebased onto latest green**.

**Deterministic (hard):** trusted build · lint · unit/integration/smoke tests · secret + dependency +
license + generated-file + infra-policy scans · a **protected-path sentinel** (any change to
deploy/launchctl/health/DB-migration/config/ledger/**check-harness** paths demands stronger dedicated
tests; destructive migrations are ineligible for autonomous deploy).

**Independent reviewers (AI, added LAST — step 7):** diff-risk · production-failure ("find why this
breaks prod") · rollback/schema-compatibility.

**Hard gate:** all deterministic pass **AND** all reviewers return structured `PASS` with **no**
unresolved high/critical finding. Any disagreement → `REJECTED` (no autonomous deploy).

**Anti-gaming (critical):** checker prompts, policy, binaries, and test orchestration come from
**trusted current-green code, not the candidate**. Reviewers run **independently**, receive code as
**untrusted data**, have **no credentials/network**, **cannot see each other's output**, and cannot
modify results. Hash inputs + outputs + checker versions into `checks_digest`.

## 4. Persisted health (never "process returned")
`VERIFYING → GREEN` only when, sustained (e.g. a probe every 5s for 2 min, ≥20 consecutive successes):
- `/health` reports the **expected SHA** (§ served-SHA) + a **new `boot_id`** + DB connectivity +
  migration compatibility;
- queue/worker execution + a **read→write→read** smoke op succeed;
- no crash/restart, no fatal log, no latency/error-budget breach.
Persist every probe + the deadline. **One success is never green.** Timeout or wrong served-SHA →
rollback **if classified safe**, else `HELD`.

Served-SHA: `/health` (and `/healthz`) report the git commit the running server was built from, so the
pipeline can prove "the server is now serving exactly the candidate." (**Step 1.**)

## 5. Rollback
Rollback unit = application SHA **+** a config/artifact manifest **+** a migration plan. Require
expand/contract backward-compatible migrations (or a tested reversible migration/snapshot). While the
serialization lock is still held: create + **CAS-push a forward revert commit** (never reset/force-push),
deploy + verify it through the **same** health window. **Auto-rollback on not-green ONLY when
compatibility was pre-certified**; irreversible schema/data changes, external side effects, lost
artifacts, rollback failure, or ambiguous state → `HELD` + page a human. `thrash.js` checkpoint tags are
**not** valid rollback targets (no health provenance).

## 6. Concurrency + thrash breaker
FIFO queue, **exactly one active integration**. Each is (re-)rebased + (re-)checked against **latest
green** only when dequeued. Logical ownership held through health/rollback. `thrash.js` opens a
**persisted circuit breaker** after repeated failures/rollbacks or excessive restart frequency → new
deploys `REJECTED` until manually cleared. This is what stops a deploy→rollback→redeploy loop.

## 7. Build order (MVP-first — safe before smart)
1. **Exact-SHA `bin/deploy` + served-SHA `/health`.** ← *building now.* Provenance + a real health signal.
2. `integrations` state/events tables + fencing + boot recovery + FIFO lock. Survives self-restart; one deploy at a time.
3. **Deterministic** gates + protected-path rejection. "Everyone can deploy" **safely**, no AI yet.
4. Sustained health verification (no false green).
5. Forward-revert **auto-rollback** for schema-neutral changes (the safety net).
6. Thrash circuit breaker.
7. **Then** the multi-agent AI reviewers + migration-capable rollback.

By step 3 any agent can deploy autonomously + safely, gated by deterministic checks; the AI review
pipeline (step 7) is an enhancement on proven rails, not a prerequisite.

## Open decisions
- **Test command source** for "test the rebased commit" (revive `pm_session_runtime.test_cmd` / per-project config).
- **"Green" acceptance** exact thresholds (probe cadence, window, error budget) per project.
- **Trigger:** who enqueues an integration (the session's operator-granted `integrate` capability) and whether a soaked-green deploy auto-promotes the release channel to `stable` ([[release-system]] §3).
- **flock on macOS** (no `flock(1)`): a small `fcntl` helper vs in-process-only serialization on the single host.
- **Reviewer models + budget** for the step-7 adversarial pipeline.
