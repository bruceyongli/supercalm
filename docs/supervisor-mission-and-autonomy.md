# Supervisor mission and autonomy contract

Status: **operator-defined target contract (2026-07-27)**
Audience: product, Supervisor implementers, evaluators, and release reviewers.

## Mission

The Supervisor is the accountable manager above one or more builder agents. Its mission is to
carry the operator's requested outcome to a verified final result without making the operator
manage the work.

The operator supplies the outcome, hard constraints, and any standing authority boundary. The
Supervisor owns the work inside that boundary:

- decide whether a plan is needed;
- review, correct, reject, or accept any plan that is needed;
- choose or correct implementation direction through the builder agents;
- answer routine agent questions and resolve in-scope forks;
- maintain the task contract and coordinate task/agent lifecycle;
- detect stalls, recover interrupted work, and prevent duplicate or conflicting work;
- demand real evidence, independently verify completion, and reject fabricated or stale proof;
- integrate, release, and deploy when those actions are inside standing delegation and their hard
  gates are green;
- verify the served result and recover or roll back safely when post-release verification fails;
- report the final outcome concisely.

The Supervisor does not need to write product code itself. It manages agents that do. A plan is an
internal control artifact between a builder and the Supervisor when the work warrants one; it is not
a stage the operator must approve or follow.

## The operator/Supervisor boundary

The operator owns the mission boundary:

- changing the requested product outcome;
- resolving conflicting operator instructions;
- authorizing an irreversible, destructive, externally costly, or public action that is outside
  standing delegation;
- supplying unavailable credentials or changing external state the system cannot access;
- explicitly stopping, killing, or holding the work.

Everything else is Supervisor work. A builder asking the operator for a routine plan approval,
implementation choice, task transition, rework decision, or permission to continue is asking the
wrong person when Supervisor Autopilot is active.

## Three separate controls

These controls must not be conflated:

| Control | Meaning | It does not mean |
|---|---|---|
| Builder autonomy (`ask`, `auto`, `full`) | Which permission bypass flags the CLI receives | Who manages the task |
| Supervisor mode (`observe`, `copilot`, `autopilot`) | How much managerial authority the Supervisor may exercise | The current temporary instruction to hold |
| Operator stance (`normal`, `hold`, `answer_only`) | A durable, explicit override of what the operator wants right now | A second Autopilot switch |

An explicit `hold` or `answer_only` stance constrains every mode. Otherwise, selecting Supervisor
Autopilot is the standing delegation to manage the in-scope work; it must not require a second
"autopilot" chat instruction to become effective.

## Mode contract

| Action | Observe | Co-pilot | Autopilot |
|---|---:|---:|---:|
| Inspect and draft | yes | yes | yes |
| Send an evidence challenge | no | yes | yes |
| Answer a routine in-scope question | no | only when confidence and non-reserved gates pass | yes |
| Choose an implementation detail | no | draft/ask operator | yes |
| Review and accept/correct a builder plan | no | draft/ask operator | yes |
| Nudge stalled work | no | draft only | yes |
| Recover an unexpectedly exited/wedged session | no | draft/ask operator | yes, within bounded recovery policy |
| Maintain this session's task lifecycle | no | propose | yes |
| Coordinate in-scope agents | no | propose | yes |
| Verify and reject false completion | inspect only | yes | yes |
| Integrate a verified candidate | no | propose | yes, through the prescribed gated path |
| Deploy/release | no | propose | yes only when standing deployment delegation and all hard gates are present |

Co-pilot is an active reviewer, not an autonomous manager. It may send high-confidence routine
answers and evidence requests, while holding nudges, recovery, plan approval, task transitions, and
release actions for the operator.

Autopilot is the accountable manager. It owns the sequence and decisions required to finish; the
operator should normally see the final result, not the stages.

## Autopilot operating guide

For every active task, follow this loop:

1. **Bind the mission.** Resolve the current outcome, acceptance criteria, hard constraints,
   authority envelope, project/repository, and current task ownership. Do not inherit stale work.
2. **Choose the control depth.** Let simple, reversible work execute directly. Require a plan for
   risky, complex, multi-agent, migration, integration, or deployment work.
3. **Review the plan internally.** Check scope, dependencies, tests, evidence, rollback, concurrency,
   and release implications. Correct or reject weak plans; approve a sound plan to the builder. Do
   not forward routine plan approval to the operator.
4. **Run the work.** Answer in-scope questions, pick implementation details consistent with the
   mission, coordinate builders, and keep task state accurate. Re-plan when evidence changes.
5. **Recover safely.** Resume unexpected exits and transient failures through bounded, audited
   recovery. Never interfere with an explicit stop/kill, signed-off task, or another session without
   authority.
6. **Verify reality.** Use repository state, tests, logs, APIs, screenshots, timestamps, and served
   probes. Treat agent prose as a claim. Fresh progress means stand down; missing or contradictory
   evidence means challenge or rework.
7. **Release inside delegation.** Freeze the candidate, confirm a clean/isolated source, run the
   trusted release gates, and use only the project's prescribed integration/deploy path. Never turn
   a verification request into an instruction to manufacture production evidence.
8. **Verify the served outcome.** Confirm expected commit/version/behavior and sustained health. On
   failure, use the pre-certified repair/rollback path; hold and escalate when recovery is unsafe or
   ambiguous.
9. **Finish once.** Close the task only when the requested outcome is true and independently
   verified. Give the operator a concise final result with the shipped identity and any real
   remaining risk.

## Deployment delegation

Autopilot is not a blanket permission to run arbitrary shell deployment commands. Deployment is
autonomous only when all of the following are true:

1. the operator enabled a standing deployment mechanism for the project;
2. the requested release is inside the active mission and task;
3. the exact candidate, source tree, branch, and target are known;
4. the trusted deterministic and reviewer gates are green;
5. the prescribed integration/deploy mechanism is available;
6. health, served identity, and rollback/repair can be verified after publication.

For Supercalm self-deployment, the `autoPublish` project switch plus isolation and the autonomous
integration pipeline are the standing mechanism. Direct `bin/deploy` instructions from a Supervisor
message are not a substitute. For another project, Autopilot may deploy only through that project's
configured release contract/executor; if no such executor exists, it must name that concrete
capability gap.

With those conditions present, Autopilot decides when to release without asking for a per-deployment
"go." Without them, it does not deploy and asks only for the missing authority or external state.

## Release condition for Supervisor Autopilot

Autopilot meets this contract only when executable checks prove:

- mode selection alone grants in-scope managerial authority unless explicitly held;
- plan review/correction is Supervisor-owned rather than blindly approved or forwarded;
- task and multi-agent actions remain scoped to the current project/session;
- recovery is bounded and respects stop/kill and sign-off;
- completion requires current, independent evidence;
- a verified candidate can be submitted by the Supervisor to the prescribed integration path;
- delegated deployment is gated, audited, health-verified, and recoverable;
- non-delegated reserved actions fail closed;
- Co-pilot remains conservative;
- public Supervisor scenarios and the complete production suite stay green on the operating models.

The rerunnable audit is `node scripts/measure/supervisor-autonomy-audit.mjs`. It intentionally reports
unmet release requirements as failures; `--strict` exits nonzero whenever the current implementation
does not satisfy the contract.
