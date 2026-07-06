# Supervisor Regression Review - 2026-06-28

## Executive finding

The Supervisor is drifting away from the original goal.

The original goal was an autonomous, auditable supervisor that keeps coding agents aligned with the operator's latest intent, pushes work forward, knows when to stay quiet, verifies real outcomes, and explains its decisions. The current system has many of the right parts, but they are layered as patches around the old monolithic tick loop. This makes the Supervisor appear active while still supervising the wrong task, accepting irrelevant proof, or sending generic challenges that force the operator to re-supervise the work.

The failure is architectural, not just prompt quality.

The core problem is that `src/agents/supervisor.js` still owns the real policy. The extracted modules exist, but the main branch order in `onTick()` still decides most behavior. That is why every incident gets another patch, and those patches can make the system feel dumber: they add more conditions to an implicit state machine instead of making the decision process explicit.

## Operator complaint reviewed

Recent operator complaints included:

- The Supervisor did not catch that side-by-side visual review was explicitly requested before sign-off.
- The Supervisor failed to keep the coding agent focused on a simple Admin Devices three-column layout fix.
- The Supervisor accepted narrow proof such as DOM column counts while the screenshot still showed the product-level complaint.
- The Supervisor treated `passcode required` / `authentication_error` as retryable transient noise.
- The assistant manually patched live session docs, which is itself wrong because the job is to train the Supervisor, not do the Supervisor's work manually.
- The Supervisor repeats official-sounding language without showing that the operator's latest words were understood.

These complaints are valid.

## Evidence inspected

Code and docs:

- `docs/wiki/supervisor-agent-full-review-2026-06-25.md`
- `docs/wiki/supervisor-comprehensive-refactor-contract.md`
- `src/agents/supervisor.js`
- `src/agents/supervisor/observe.js`
- `src/agents/supervisor/interpret.js`
- `src/agents/supervisor/decide.js`
- `src/agents/supervisor/dispatch.js`
- `src/agents/supervisor/decision_records.js`
- `src/agents/supervisor/state.js`
- `src/agents/supervisor/verify.js`
- `src/agents/doc_maintainer.js`
- `src/agents/live_context.js`
- `src/agents/operator_requirements.js`
- `web/agents/supervisor.js`
- Supervisor tests under `test/`

Runtime records:

- `supervisor_reviews`
- `supervisor_decisions`
- recent `messages` rows for operator complaints and forwarded cross-agent notes
- active sessions and latest Supervisor records

Commands used included:

- `wc -l src/agents/supervisor.js src/agents/supervisor/*.js ...`
- `rg "sendToAgent|dispatchSupervisorSend|ctx.setState|logIntervention" src/agents/supervisor.js src/agents/supervisor/*.js`
- SQL counts over `supervisor_reviews` and `supervisor_decisions`
- recent message/review queries for `s_d8ea209518`, `s_84a509f6fc`, and this Supervisor-fix session

No live session doc/grant was manually patched for this review.

## Current state

The 2026-06-25 refactor contract defines the correct target:

```text
Observe -> Interpret -> Decide -> Dispatch -> Verify/Learn -> Explain
```

Some pieces now exist:

- `observe.js` builds a `SupervisorSnapshot`.
- `interpret.js` classifies operator intent.
- `decide.js` has a pure-ish policy function.
- `dispatch.js` is the direct send chokepoint.
- `decision_records.js` persists decision records.
- `state.js` reads state into a typed-ish shape.
- `verify.js` externalizes the verifier prompt builder.

But those pieces are not yet the architecture. They are support modules around the old controller.

Concrete size evidence:

- `src/agents/supervisor.js`: 2,232 lines.
- `src/agents/evidence.js`: 897 lines.
- `web/agents/supervisor.js`: 847 lines.
- Extracted `src/agents/supervisor/*.js` modules combined: 931 lines.

The main loop still lives in `src/agents/supervisor.js` around `onTick()`. It still mixes observation, policy, model calls, doc maintenance, verification, state mutation, recovery, notification, and dispatch decisions.

## What has improved

The system is not useless. Several improvements are real and should be preserved:

- Raw `ctx.sendToAgent(...)` calls are no longer present in `src/agents/supervisor.js`; sends flow through `dispatchSupervisorSend()` / `dispatchSupervisorCommand()`.
- `dispatch.js` blocks sends without a triggering signal.
- `supervisor_decisions` records many sends and blocked sends.
- The verifier now receives `CURRENT_OPERATOR_REQUIREMENTS`.
- The doc maintainer now receives `CURRENT_OPERATOR_REQUIREMENTS`.
- Recent code now reanalyzes operator messages before the settle window.
- Preview profile passcode inheritance was fixed.
- Passcode/auth errors were removed from transient retry handling.

These are good patches, but patches are not enough.

## Live operational evidence

Current aggregate `supervisor_reviews` counts showed:

- `verify/completion/needs_attention`: 887 rows, 256 sent.
- `answer/action/answered`: 809 rows, 809 sent.
- `gate/completion/challenged`: 494 rows, 491 sent.
- `answer/question/answered`: 471 rows, 471 sent.
- `doc-update/maintain/updated`: 279 rows.
- `recover/context-wedge/compacted`: 158 rows, 158 sent.
- `keepworking/idle/nudged`: 117 rows, 111 sent.
- `recover/api-error/waiting`: 97 rows.
- `recover/api-error/retried`: 80 rows, 79 sent.
- `verify/completion/complete`: 59 rows.

Decision record coverage is partial:

- `supervisor_reviews`: 3,953 rows.
- `supervisor_decisions`: 1,084 rows.
- Approximate historical coverage: 27.4%.

Some of this gap exists because decision records were added later, but the deeper issue remains: the contract says every decision, including quiet ticks, should be inspectable. The current implementation records selected no-send branches, not every scheduler decision.

Recent `supervisor_decisions` also show a source confusion problem. `latestOperatorIntent` can be derived from operator-pasted cross-agent text such as `[from Claude] NOT BLOCKING - go ahead...`. The operator sent that text, but its semantic speaker is another agent. Treating it as direct operator intent can distort decisions.

## Primary failure modes

### F1 - The refactor contract is not the controlling implementation

`docs/wiki/supervisor-comprehensive-refactor-contract.md` is clear: the Supervisor should be an auditable decision system with a pure decision pipeline. The repo has modules for that, but `src/agents/supervisor.js` still owns the real behavior.

Evidence:

- `decideSupervisorAction()` is used for policy preview and unexpected-exit recovery, but the main waiting/review/verify/answer branches still live inside `onTick()`.
- State mutation happens directly throughout `supervisor.js` via `ctx.setState(...)`.
- Verification, model calls, doc maintenance, and action choice still interleave in the same function.

Impact:

- Fixes depend on branch ordering.
- A correct rule in `decide.js` may not affect live behavior.
- Testing `decideSupervisorAction()` does not fully test the actual Supervisor.

Required correction:

- Make `decideSupervisorAction()` the mandatory route for every tick.
- Move side effects after a decision record, not before.
- Treat direct branch logic in `onTick()` as migration debt until removed.

### F2 - Latest operator words are still not a deterministic current-task model

Recent patches extract `CURRENT_OPERATOR_REQUIREMENTS`, but this is still a set of recognized patterns rather than a general current-task model.

Current behavior depends on:

- regex intent from `interpret.js`,
- operator requirement extraction from `operator_requirements.js`,
- LLM doc maintenance from `doc_maintainer.js`,
- the old markdown `## Now`,
- verifier interpretation,
- session category from detector output.

That is too many competing sources.

Impact:

- The Supervisor can know the latest operator requirement in verifier evidence while `## Now` is still stale.
- If the extractor does not recognize the wording, the system falls back to stale doc behavior.
- If doc maintenance fails or is debounced, stale scope can survive.

Required correction:

- Add a deterministic `CurrentTask` object to the snapshot:

```js
{
  source: 'operator_latest' | 'doc' | 'agent_question' | 'verified_next',
  text,
  acceptance,
  operatorMessageIds,
  confidence,
  staleDocOverride: true | false
}
```

- The policy engine should judge against `snapshot.currentTask`, not markdown parsing directly.
- Markdown `## Now` should be a view/cache of `CurrentTask`, not the authority.

### F3 - The Supervisor confuses message authorship with semantic speaker

`recentOperatorSignals()` intentionally reads operator-authored messages. That is good for normal chat, but the operator often pastes cross-agent updates:

- `[from Claude] ...`
- `[Claude -> Codex] ...`
- `Codex status: ...`

These are operator-submitted rows, but semantically they are agent reports. The intent classifier can treat words inside them, such as "go ahead", "not blocking", or "verified", as direct operator intent.

Impact:

- The Supervisor may think the operator said "continue" when the operator merely relayed another agent's status.
- Completion, coordination, and deployment decisions can be based on forwarded text with the wrong authority.

Required correction:

- Split operator message analysis into:
  - `operator_directive`: direct operator instruction.
  - `forwarded_agent_report`: text quoted or prefixed from another agent.
  - `operator_commentary`: operator sentiment/complaint.
  - `credential/config update`.

- Forwarded agent reports can be evidence, but they must not become operator intent unless the operator adds a direct instruction outside the quote.

### F4 - Evidence relevance is weak

The Admin Devices failure is the clearest example. The agent could produce a narrow "three columns measured" proof while the operator's screenshot still showed the product-level layout complaint.

The Supervisor asked for evidence, but not always the right evidence.

Impact:

- The agent learns to satisfy the gate wording rather than the product issue.
- The operator has to visually re-check and restate the problem.
- Tokens are spent on proof folders and challenges while the simple product bug remains.

Required correction:

- Add an evidence-relevance check before accepting verification:

```js
Does the evidence directly address the latest operator complaint?
Does it compare against the newest screenshot/URL?
Does it prove the user-visible outcome, not only an internal measurement?
```

- Visual complaint resolution should require a screenshot comparison to the latest operator screenshot or named surface.

### F5 - "Do not manually patch sessions" is not enforced

Manual session doc patching happened during incident response. That is the wrong pattern. It makes the current session look better while leaving the product behavior undertrained.

Impact:

- The operator cannot trust that the Supervisor learned anything.
- Future sessions repeat the same failure.
- It trains the human/operator to rely on the assistant as the real supervisor.

Required correction:

- Establish a hard operating rule:

```text
Do not manually patch live Supervisor docs/grants/session state to fix behavior unless the operator explicitly asks for emergency recovery. Fix product behavior, tests, and deployment instead.
```

- Add a test/lint guard is hard because API calls are runtime, but the rule belongs in docs and agent operating guidance.

### F6 - The doc maintainer is model-dependent and can be stale

`doc_maintainer.js` is better than a full free-form rewrite, but it still depends on a model deciding whether to advance `## Now`.

Recent patches make it more aware of current operator requirements, but the deterministic path is missing.

Impact:

- A model can archive a correction into Timeline/Decisions without advancing `## Now`.
- Debounce and settle timing can hide fresh operator messages.
- Failed model calls can leave stale scope without an explicit degraded-mode decision.

Required correction:

- Deterministic operator requirement extraction should directly set `CurrentTask` for the decision engine.
- Model doc maintenance should update human-readable markdown after the deterministic task state is set.
- If doc maintenance fails, the Supervisor should still act from `CurrentTask` and record `doc_update_failed`.

### F7 - Decision records are not complete enough

`supervisor_decisions` is a good start. But it is not yet the single ledger of every tick.

Evidence:

- `supervisor_decisions` has about 1,084 rows versus 3,953 `supervisor_reviews` rows.
- Quiet returns still happen without a decision record in some branches.
- The UI still cannot explain every silence.

Impact:

- The operator still needs DB queries to understand why the Supervisor did or did not act.
- It is hard to audit "why did it wait?" or "why did it send this?"

Required correction:

- Every tick that reaches Supervisor logic must persist one decision record.
- Early returns must be converted into explicit `wait` / `none` decisions.
- `supervisor_reviews` should become event/history output, not the primary decision ledger.

### F8 - The policy engine is incomplete

`src/agents/supervisor/decide.js` is small and testable, but it does not own enough.

Missing or only partially modeled:

- doc maintenance decisions,
- completion gate cooldown details,
- corrective nudge caps,
- blind evidence escalation,
- checkpoint behavior,
- answer retry escalation,
- goal conflict resync,
- API error recovery nuance,
- context wedge dwell logic,
- operator-settle-after-reanalysis behavior.

Impact:

- Replay tests cover desired architecture, but not the actual branch behavior that keeps failing.

Required correction:

- Move the actual branch decisions into `decide.js` incrementally but continuously until `supervisor.js` becomes an orchestrator.
- Add fixtures from the exact bad sessions:
  - side-by-side missed,
  - devices column fix drift,
  - answer-only ignored,
  - forwarded Claude message misread as operator intent,
  - auth/passcode retried as transient,
  - manual patching forbidden.

### F9 - The Supervisor over-produces generic challenge language

"Before sign-off, account for the current plan..." appears often. It is not always wrong, but repetition makes it feel dumb and context-blind.

Impact:

- The coding agent receives generic bureaucracy.
- The operator sees the same language regardless of the specific failure.
- Real product risk is buried under template language.

Required correction:

- Generate challenge messages from structured unmet criteria:
  - latest operator request,
  - specific missing evidence,
  - specific surface/file/URL,
  - why prior evidence was insufficient.

- Ban generic challenge templates when `current_operator_requirements` exists.

### F10 - No "simple task taking too long" management loop

The Devices issue exposed another missing behavior. When a simple, narrow, operator-visible task takes more than an expected time and keeps failing, the Supervisor should not merely request more evidence. It should manage execution:

- narrow scope,
- stop side quests,
- demand the smallest patch,
- require a screenshot,
- deploy,
- and escalate if the agent is not making progress.

Impact:

- A one-hour UI fix can sprawl into proof artifacts, reconciliation, side queues, and stale design work.

Required correction:

- Add task complexity/time expectation tracking:

```js
if latest operator task is narrow + visual + urgent + elapsed > threshold + no direct rendered fix:
  action = corrective_execution_push
  message = "Stop broad work. Patch only X. Deploy. Capture Y."
```

- This must be a policy rule, not a prompt suggestion.

## How the Supervisor is distancing from the original goal

The original goal was a practical autonomous supervisor for AI employees. The current behavior is drifting toward a verification bureaucracy:

- It can demand evidence while missing the operator's real complaint.
- It can be busy without being useful.
- It can preserve stale generated docs over fresh operator direction.
- It can turn product failures into proof-format disputes.
- It can rely on the operator to notice and restate obvious context.
- It can make the assistant manually intervene, which defeats the point.

The Supervisor should be judged by whether the work gets done correctly with less operator effort. Recent incidents show the opposite: the operator had to inspect, correct, re-scope, and challenge the Supervisor itself.

## Revised architecture direction

Do not add another isolated patch first. The existing contract is still the right destination, but it needs sharper implementation priorities.

### Required target

The live path must become:

```text
Observe -> Build CurrentTask -> Interpret -> Decide -> Dispatch/Act -> Verify -> Learn -> Explain
```

`Build CurrentTask` is the missing piece.

### CurrentTask contract

Every tick should derive:

```js
currentTask = {
  text,
  acceptance,
  source,
  sourceMessages,
  supersedesDoc: boolean,
  evidenceRequired,
  urgency,
  surfaces,
  forbiddenShortcuts,
}
```

Examples:

- "Fix the column and deploy now" becomes an urgent Admin Devices production layout task.
- "I asked for side-by-side review" becomes a visual comparison gate across named surfaces.
- "[from Claude] verified..." becomes forwarded evidence, not operator intent.
- "answer my question only" becomes a no-send implementation hold.

### Decision contract

Every tick must persist a decision:

```js
{
  currentTask,
  latestDirectOperatorIntent,
  latestForwardedAgentReport,
  action,
  why,
  whyNot,
  evidenceInspected,
  evidenceMissing,
  sendText?,
}
```

### Dispatch contract

No message should be sent unless:

- it cites direct operator intent or the absence of a direct override,
- it cites a fresh triggering signal,
- it cites the current task,
- it says why prior evidence is insufficient if challenging completion,
- it passes dedupe and usefulness checks.

## Concrete next work

This should be treated as one continuous Supervisor repair program, not another narrow goal that stops early.

1. Add `src/agents/supervisor/current_task.js`.
2. Classify operator-authored messages into direct directives vs forwarded agent reports.
3. Make `currentTask` deterministic and include it in `SupervisorSnapshot`.
4. Update `decide.js` to use `currentTask` as the authority over markdown `## Now`.
5. Convert every early return in `onTick()` into a persisted decision.
6. Move completion gate, corrective gap, blind evidence, keep-working, and settle behavior into `decide.js`.
7. Add replay fixtures for the exact recent failures.
8. Change challenge text to be specific to `currentTask`, not generic template language.
9. Surface `currentTask`, direct operator intent, forwarded reports, and last decision in the Supervisor UI.
10. Remove or shrink old branches from `supervisor.js` only after replay tests cover them.

## Acceptance criteria for this repair

- A new operator message causes current-task reanalysis on the next tick without manual session patching.
- Forwarded agent messages are not mistaken for direct operator instructions.
- The Supervisor can explain the current task in the UI.
- The Supervisor can explain why it sent or stayed quiet.
- Repeated generic completion-gate language is replaced by specific missing-evidence challenges.
- Visual complaints require visual evidence tied to the latest screenshot/URL.
- Auth/passcode failures are reported as evidence-channel blockers, not transient retries.
- Simple urgent tasks that overrun get narrowed execution pushes, not broad proof bureaucracy.
- Every tick produces a decision record.
- `supervisor.js` becomes a thin orchestrator and stops owning policy.

## Bottom line

The Supervisor is getting worse because the system keeps adding incident patches around an implicit state machine. The fixes are individually reasonable, but together they make behavior harder to predict and harder to trust.

The way back is not more prompt text. The way back is to make the Supervisor's current-task model and decision pipeline explicit, deterministic, logged, and visible.

