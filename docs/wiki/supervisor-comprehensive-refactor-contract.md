# Supervisor Comprehensive Refactor Contract

_AIOS architecture contract - 2026-06-25_

## Intent

This contract defines the Supervisor redesign as one complete body of work.

Do not narrow this into a starter goal, partial version, or "first slice" that stops after one subsystem. The point of this work is to refactor, redesign, and re-architect the Supervisor as a coherent system. Individual tasks can have dependencies, but they are all part of the same required outcome.

The operator expectation is continuous execution: when one task is complete and verified, continue to the next remaining task in this contract. Do not ask whether to proceed unless there is a real blocker that cannot be resolved from repo context, runtime evidence, or operator-authored instructions.

## Product Goal

The Supervisor should become an auditable decision system that understands the user's latest words, the current session state, project evidence, and prior commitments before it acts.

It must know when to:

- stay quiet,
- wait,
- answer a question,
- push an agent to continue,
- challenge an unsupported completion claim,
- record a decision,
- update the supervision doc,
- escalate to the operator,
- recover from infrastructure errors,
- and explain exactly why it did or did not send a message.

Blind boilerplate such as repeating the same completion gate after the operator has already acknowledged context is a product failure.

## Non-Negotiables

- Treat the refactor as one complete program with workstreams, not a sequence of disposable starter goals.
- Keep working through the remaining checklist after each completed work item.
- Every Supervisor message must consider the operator's latest words.
- "Do nothing" and "wait" are real decisions, not missing branches.
- Every outbound Supervisor message must cite both the latest relevant operator intent and the fresh signal that justifies sending.
- If the Supervisor cannot name the user intent and the fresh signal, it must not send.
- Every outbound send path must pass through one dispatch policy layer.
- Every decision, including blocked sends and quiet ticks, must be inspectable.
- Runtime behavior must be backed by tests, API output, screenshots, or database evidence.
- Every deploy must use `bin/deploy`, which performs the required version bump.
- Do not add npm dependencies.

## Diagnosis

`src/agents/supervisor.js` has accumulated too many responsibilities:

- scheduler policy,
- operator intent detection,
- completion verification,
- answer generation,
- doc maintenance,
- context recovery,
- API error recovery,
- send dedupe,
- state mutation,
- prompt text,
- learning hooks,
- UI summary,
- and review logging.

The result is an implicit state machine where branch order defines product behavior. That is why small patches can fix one incident while creating or preserving another: question-only handling, repeated gates, goal-conflict holds, doc advancement, and keep-working prompts all interact inside one large tick loop.

The new architecture must make the decision process explicit, testable, and visible.

## Target Architecture

The complete architecture is:

```text
Observe -> Interpret -> Decide -> Dispatch -> Verify/Learn -> Explain
```

These are workstreams inside one refactor, not separate stopping points.

### Observe

Build one normalized `SupervisorSnapshot` from the current session, project, terminal evidence, messages, supervision doc, active holds, prior Supervisor state, project graph, changed-impact data, and recent review history.

Suggested module:

- `src/agents/supervisor/observe.js`

The snapshot must be serializable and replayable. No model output should be required to construct the base snapshot.

Required fields:

```js
{
  schema: 'supervisor.snapshot',
  generatedAt,
  session: {
    id,
    projectId,
    status,
    category,
    title,
    summary,
    updatedAt
  },
  operator: {
    lastMessageTs,
    lastMessageText,
    recentSignals,
    intent,
    intentConfidence,
    intentEvidence
  },
  agent: {
    status,
    reportedCompletion,
    reportedQuestion,
    progressFingerprint,
    terminalSignals,
    apiErrorSignals,
    contextWindowSignals
  },
  work: {
    gitHead,
    baseRef,
    changedFiles,
    changedImpact,
    evidenceBrief,
    missingEvidence,
    visualEvidence
  },
  supervisionDoc: {
    raw,
    goal,
    currentWork,
    remainingWork,
    acceptanceCriteria,
    hardRules,
    decisions,
    staleWarnings,
    gateScopeKey
  },
  supervisorState: {
    signedOff,
    activeHold,
    lastGate,
    lastDecision,
    verifiedWorkFp,
    questionOnlyReview,
    recoveryState
  },
  history: {
    recentSupervisorDecisions,
    recentAgentMessages,
    recentOperatorMessages,
    relevantPrecedents,
    relevantLessons
  }
}
```

### Interpret

Turn raw signals into typed intent and state labels.

Suggested module:

- `src/agents/supervisor/interpret.js`

Required classifications:

- `question_only`
- `wait`
- `continue`
- `ack`
- `correction`
- `scope_change`
- `completion_claim`
- `evidence_supplied`
- `blocked`
- `operator_override`
- `no_new_signal`

Regex rules are acceptable when they are visible, tested, and paired with evidence. If a model is later used for intent interpretation, its output must be advisory and recorded with confidence and source.

### Decide

Make one explicit decision record for each scheduler tick and each manual check.

Suggested module:

- `src/agents/supervisor/decide.js`

Required output:

```js
{
  schema: 'supervisor.decision',
  decisionId,
  generatedAt,
  policyVersion,
  snapshotHash,
  ruleId,
  action: {
    type: 'none' | 'wait' | 'answer' | 'verify' | 'challenge' | 'nudge' | 'recover' | 'maintain_doc' | 'escalate' | 'checkpoint',
    target: 'agent' | 'operator' | 'supervisor_doc' | 'internal',
    payload: {}
  },
  allowedSend,
  suppressionReason,
  latestOperatorIntent: {
    type,
    text,
    ts,
    confidence
  },
  triggeringSignal: {
    type,
    summary,
    ts,
    evidenceRef
  },
  reasons: [],
  unmetCriteria: [],
  statePatch: {},
  requiredEvidence: [],
  audit: {
    evaluatedRules: [],
    matchedRules: [],
    priorDecisionRefs: []
  }
}
```

Required rules:

- A quiet tick emits `action.type = 'none'` or `action.type = 'wait'`.
- A send is illegal unless `allowedSend = true`.
- A send is illegal unless `latestOperatorIntent` and `triggeringSignal` are populated.
- A repeated challenge must cite what changed since the previous challenge. If nothing changed, the decision must be `none` or `wait`.
- "Future work" language in a doc is not a blocker after prerequisites are complete or the operator says to continue.
- Operator-authored instructions outrank agent prose and stale generated summaries.

### Dispatch

Make all side effects flow through one outbound policy layer.

Suggested module:

- `src/agents/supervisor/dispatch.js`

Required behavior:

- Every `ctx.sendToAgent(...)` call in Supervisor-owned code goes through dispatch.
- Dispatch receives a `SupervisorDecision`, not free-form text.
- Dispatch logs sends, blocked sends, and no-send decisions.
- Dispatch handles dedupe, cooldown, and grant checks consistently.
- Dispatch refuses to send if the decision lacks a cited operator intent or triggering signal.
- Dispatch records exact sent text and whether the send reached the agent.

There must be no hidden send path.

### Verify

Separate verification judgment from send policy.

Suggested modules:

- `src/agents/supervisor/verify.js`
- `src/agents/supervisor/evidence_summary.js`

Required behavior:

- Completion verification judges acceptance criteria against concrete evidence.
- Visual work requires screenshot or render evidence.
- API claims require API output.
- Test claims require actual command output or committed CI evidence.
- The verifier returns structured results, not only prose.
- The decision engine consumes verifier output and decides whether to challenge, wait, accept, or escalate.

### Learn

Make lessons and precedents scored evidence, not global prompt soup.

Suggested module:

- `src/agents/supervisor/learning.js`

Required behavior:

- Retrieve precedents and lessons by query relevance, recency, source, confidence, and project match.
- Never inject every old lesson unconditionally.
- Store operator corrections as labeled training examples.
- Store scheduler-decision examples, not only answer-quality examples.
- Keep current and desired outcomes for known bad sessions.

### Explain

Expose the Supervisor's reasoning in the UI and API.

Suggested module:

- `src/agents/supervisor/explain.js`

Required UI/API fields:

- current operator intent,
- current action decision,
- why the Supervisor is quiet,
- why the Supervisor sent,
- last blocked send,
- active hold and clear condition,
- gate scope key,
- current evidence state,
- missing evidence,
- stale doc warnings,
- policy rule that fired,
- last decision record link.

The operator should not need database queries to understand the Supervisor.

## Workstreams

All workstreams belong to the same refactor and remain open until the full definition of done is satisfied.

### Workstream A - Decision Records

- Add persistent `supervisor_decisions` storage.
- Store one decision record for every scheduler tick that reaches Supervisor logic.
- Store no-send decisions.
- Store blocked sends.
- Store sent text and send result.
- Link decision records to snapshot hashes and evidence refs.
- Show decision records in Supervisor history.

### Workstream B - Snapshot Builder

- Extract current state reads into `observe.js`.
- Include operator messages, terminal tail, git status, project graph, changed impact, doc state, active holds, and prior reviews.
- Make snapshots serializable fixtures.
- Add snapshot tests for current live incidents.

### Workstream C - Intent Interpretation

- Replace scattered regex checks with a typed intent result.
- Preserve the current fixed behavior for question-only, wait, continue, and ack.
- Add tests for operator wording from real sessions.
- Ensure the latest operator message is always considered before any send.

### Workstream D - Policy Engine

- Move branch policy out of `onTick` into named decision rules.
- Rules return structured decisions.
- Rule order is explicit and recorded.
- No rule performs I/O or model calls.
- Every rule has focused fixtures.

### Workstream E - Dispatch Chokepoint

- Replace all raw Supervisor `ctx.sendToAgent` calls with dispatch calls.
- Make dispatch validate `allowedSend`, cited intent, triggering signal, dedupe, and grants.
- Add tests proving no send can bypass dispatch.
- Add review-log evidence for blocked sends and quiet decisions.

### Workstream F - Verification Engine

- Externalize completion verification into structured verifier output.
- Keep model-backed analysis, but make its input/output schema explicit.
- Record prompt version and evidence version.
- Add labeled replay tests from `verify_snapshots`.
- Require concrete evidence per acceptance criterion.

### Workstream G - Supervision Doc Model

- Parse the supervision doc into a structured model.
- Keep markdown as the human-readable source.
- Emit parser warnings for ambiguous sections.
- Track current work, remaining work, decisions, hard rules, acceptance criteria, and resolved criteria.
- Ensure the model supports progressive work without treating later work as forbidden.

### Workstream H - Holds and State

- Wrap existing state keys behind typed helpers.
- Preserve live state during migration.
- Add typed holds with reason, scope, armed time, clear condition, and allowed actions.
- Surface holds in the UI.
- Add explicit clear/resolve actions with audit records.

### Workstream I - Learning and Retrieval

- Build scheduler-policy examples from bad sessions.
- Store current behavior and desired behavior separately.
- Retrieve lessons by score and source.
- Stop treating stale memories as unconditional rules.
- Use operator corrections as high-value labels.

### Workstream J - UI Transparency

- Add a Supervisor State panel.
- Show the current decision record.
- Show why quiet.
- Show why sent.
- Show blocked-send reasons.
- Show active hold lifecycle.
- Show missing evidence and stale warnings.
- Make decision history filterable by action, rule, send result, and session.

### Workstream K - Replay and Regression Harness

- Add fixture files for real incidents.
- Run decision replay without model calls.
- Include fixtures for:
  - answer-only request,
  - operator wait request,
  - operator ack after visible status change,
  - repeated completion gate with no new signal,
  - LangGraph/current-work continuation,
  - completion claim with no tests,
  - visual work with no screenshot,
  - API auth false positive,
  - context window wedge,
  - active goal-conflict hold.
- Tests assert action type, allowed send, suppression reason, rule id, cited intent, triggering signal, and state patch.

### Workstream L - Runtime Migration

- Keep service stable while moving code.
- Preserve live holds and signed-off state.
- Add compatibility shims only while needed.
- Remove obsolete branches after replacement tests pass.
- Deploy only from a clean tree through `bin/deploy`.

## Dependency Rules

Dependencies exist for safety, but they do not reduce the total scope.

- Dispatch chokepoint must exist before send policy can be trusted.
- Decision records must exist before UI explanation can be complete.
- Snapshot fixtures must exist before policy rules can be safely rewritten.
- Structured verifier output must exist before completion gate behavior can be reliably tuned.
- Typed holds must exist before hold UI can be considered complete.
- Learning retrieval must use decision records and labels, not raw prompt text alone.

When a dependency is complete, continue into the dependent work immediately if remaining tasks exist.

## Full Definition Of Done

The refactor is not done until every item below is true.

- `src/agents/supervisor.js` is a thin integration layer, not the owner of scheduler policy, prompts, learning, state, and UI summary.
- Every Supervisor decision produces a persisted decision record.
- Quiet ticks and wait decisions are persisted.
- Every outbound Supervisor send goes through dispatch.
- No Supervisor-owned code path can call `ctx.sendToAgent` directly.
- Dispatch refuses sends without cited operator intent and triggering signal.
- The UI explains the current Supervisor decision without reading raw database rows.
- Active holds are visible, typed, auditable, and clearable.
- Completion verification outputs structured criteria results.
- Prompt versions and evidence versions are recorded.
- Supervision docs are parsed into structured current work, remaining work, decisions, hard rules, and acceptance criteria.
- The policy engine is deterministic and replayable without model calls.
- Regression fixtures cover the known bad sessions and the expected desired behavior.
- Lessons and precedents are retrieval-scored evidence, not unconditional prompt rules.
- Product behavior confirms:
  - no blind repeated completion gates,
  - no interruption after answer-only requests,
  - no failure to continue remaining work after the operator already said to continue,
  - no stale "future work" blocker once prerequisites are complete,
  - no unexplained Supervisor sends.
- `npm test` passes.
- Any UI changes are backed by rendered evidence.
- Any deploy uses `bin/deploy` and shows a new served version.

## Operating Rule For Future Agents

Do not report the Supervisor refactor as done because one workstream is complete.

After completing a task, check this contract for remaining unchecked work and continue. If a session is handed only a narrow checklist, it must reconcile that checklist against this full contract and continue with the remaining contract items once the narrow item is verified.

The correct behavior is persistent completion of the whole refactor, not stopping at a convenient boundary.
