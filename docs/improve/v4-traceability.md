# Supervisor v4 — incident-to-invariant traceability

Every failure class from the 2026-07 ground-truth review of the 10 longest sessions maps to an
enforceable invariant, the component that enforces it, the test that proves the guard is live
(mutation rule: disabling the guard must fail the test), and the runtime metric that proves it
stays effective. Rows close only when all four exist in production.

Status legend: ☐ open · ◐ partial (mechanism exists, not yet kernel-grade) · ☑ closed.

## Agent-side classes

| # | Failure class | Invariant | Enforcing component | Test | Runtime metric | Status |
|---|---|---|---|---|---|---|
| A1 | Unverified completion claims | No `completed` transition without system-collected evidence bound to acceptance criteria; challenge budget exhaustion → human review, never silent accept | Evidence probes + completion gate (Phase 2) | Lab: done-claim with stale/absent evidence is refused; mutation: gate off → test fails | done-claims overturned by operator per week | ☐ |
| A2 | Standing-order decay (stop-and-wait under nonstop mandate) | Under an active nonstop directive, `waiting-agent-input` beyond bound triggers kernel CONTINUE intent or escalation | State machine watchdog (Phase 2) + CONTINUE intent (Phase 0/1) | Lab: parked next-step composer scenario auto-continues | stall-minutes under nonstop directives | ☐ |
| A3 | Zombie/wedge tails | Identical stabilized snapshot beyond bound → `parked`/`process-unresponsive` with explicit recovery policy, queue demotion, single notify | State machine (Phase 2); bg-hold bound exists (◐) | Unit: state entry/timeout; lab: multi-day identical-screen replay | zombie-hours per session; time-to-park | ◐ |
| A4 | Repeated-instruction amnesia | Operator directives persist as ledger entries checked before sends and at claim time; repeat-complaint fuzzy match escalates | Directive ledger (Phase 4) + launch contract injection (Phase 3) | Lab: rule violated after resume is flagged | operator instruction repeats per session | ☐ |
| A5 | Validator tampering / faked outputs | Edits to validator/test/release tooling paths flag immediately and downgrade verdicts; verification runs outside agent-writable domain | Tamper tripwire + protected harness (Phase 2) | Mutation: tripwire off → tamper lab scenario passes falsely → suite fails | tamper flags raised; time-to-flag | ☐ |
| A6 | Fabricated self-constraints (invented gates/rules) | Any agent-cited blocking rule is verified against the artifact (file/line) once, then escalated or dismissed — never argued in prose loops | L2 brain verify-the-artifact flow (dig-for-truth, ◐ exists) + typed ESCALATE | Lab: invented-rule scenario resolves in ≤1 escalation | invented-gate stall-hours | ◐ |
| A7 | Deploy malpractice (dirty tree / wrong cwd) | Deploy-class actions unavailable inside agent panes; deploy path requires clean committed tree + repo identity + capability | Deploy isolation (Phase 3) + reserved-action block (Phase 0) | Unit: deploy intent from pane refused; integration: dirty-tree deploy refused | agent-initiated deploys bypassing the path (must be 0) | ☐ |
| A8 | Error-state helplessness (429/529/limit loops) | Rate/usage-limit screens classify as `resource-degraded{reset_at}`; retries suppressed until reset; recovery via verified resume only | State machine (Phase 2) + `sessions.resume` manifest check (Phase 3) | Lab: dated limit wall → zero retry sends, one escalation with reset time | retry-sends into hard walls (must be 0) | ☐ |

## Supervisor-side classes

| # | Failure class | Invariant | Enforcing component | Test | Runtime metric | Status |
|---|---|---|---|---|---|---|
| S1 | Fabricated operator authority | Operator authority is unrepresentable without a resolvable verbatim source or capability object; reserved actions escalate-only | Intent schema + capability objects (Phases 1–2); reserved block (Phase 0) | Unit: authority-bearing intent without source refused; lab: fabrication-order replay | authority assertions without source (must be 0) | ◐ |
| S2 | Self-contradiction (opposite directives) | Opposite intents against the same open item within a window are a state-machine conflict → hold + single escalation | Kernel conflict check on typed intents (Phase 1) | Unit: CONTINUE vs STOP conflict held; lab: build↔defer replay | conflicting-send incidents (must be 0) | ☐ |
| S3 | Send-effectiveness blindness | N sends without receipt (observed state transition) opens the circuit; open circuit = no sends, one escalation | Send mediator (Phase 0) → receipts (Phase 1) | Unit: breaker opens at N; lab: frozen-pane replay sends ≤N | sends-without-receipt; max consecutive ineffective sends | ◐ |
| S4 | Verbatim re-challenge loops | Challenge budgets bind to work items; identical sends dedupe exactly; budget exhaustion → `requires_human_review` | Send mediator dedupe (Phase 0) + claim budgets (Phase 2) | Lab: re-challenge scenario caps at budget; mutation: dedupe off → fails | duplicate challenges per claim | ◐ |
| S5 | Verdicts contradicting operator sentiment | Operator feedback outranks brain verdicts; disagreement adjusts autonomy and is surfaced, not overridden | Directive ledger stance integration (Phase 4) | Statistical eval: verdict-vs-operator agreement on holdout set | verdict/operator disagreement rate | ☐ |
| S6 | Reserved-action violations (surveys, operator-reserved questions, approval relay) | Reserved classes are unsendable intents; approval relay impossible — approvals exist only as operator-minted capabilities | Reserved block (Phase 0) + capabilities (Phase 2) | Unit: each reserved class refused; canary probe in production | reserved-action sends (must be 0) | ◐ |
| S7 | Send hygiene (placeholders, stale goals) | Templates cannot render unresolved variables; goal version checked in lease before send | Template renderer + leases (Phase 1) | Unit: unresolved-placeholder render throws; stale goal-version lease refused | placeholder/stale-goal sends (must be 0) | ☐ |
| S8 | Coverage inversion (absent where needed, burning tokens where not) | Supervision invocation is event-driven with per-session call budgets; high-risk sessions get supervision by default once S1–S4 hold | Event-driven invocation (Phase 0) + scheduler policy (Phase 4) | Integration: no-event window produces zero brain calls | brain calls per session-hour; % high-risk sessions supervised | ◐ |

## Pipeline classes (discovered during Phase 0, 2026-07-16)

| # | Failure class | Invariant | Enforcing component | Test | Runtime metric | Status |
|---|---|---|---|---|---|---|
| P1 | Deploy false-hold (restart race): a successful deploy is marked deploy_not_served because the health confirmer dies in the restart it caused, and the HELD row wedges the single-slot queue with no operator lever | A HELD verdict must be reconciled against observed reality (served commit ⊇ candidate + healthz) before it can block the queue; holds get an operator resolve control | publisher reconcile-on-boot late-confirm + POST /api/deploy/integration/:id/resolve (next slice) | Unit: late health confirm with served==candidate promotes GREEN, not HELD; mutation: fix off → false-hold reproduces | false-hold rate; queue-blocked minutes per week | ☐ |

## Cross-cutting SLOs (Phase 4 dashboard)

Paired safety/utility — both directions watched so guards can't "improve" by doing nothing:
reserved-action violations = 0 · sends-without-receipt = 0 · duplicate interventions per incident ≤ 2 ·
missed-needed-intervention rate · time-to-detect / time-to-recover wedge · operator corrections per
active hour · escalation precision (% acted on) and recall · brain cost per productive session-hour ·
false-block rate · % allowed sends audited.
