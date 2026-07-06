# Supervisor Agent Full Review - 2026-06-25

## Scope

This review covers the Supercalm Supervisor agent as a product and engineering system:

- Scheduler and policy logic in `src/agents/supervisor.js`.
- Prompt design in `src/agents/supervisor.js` and `src/agents/answer_prompt.js`.
- Living context, operator intent, doc maintenance, learning, verification ledgers, and playbooks.
- UI surfaces in `web/agents/supervisor.js`.
- Existing design intent in `docs/supervisor-living-context-DESIGN.md` and `docs/wiki/skill-evolution-research.md`.
- Live operational evidence from the local Supercalm database, including Supervisor intervention counts and active holds.

This is a design review and refactor proposal. It does not deploy code and intentionally does not change runtime behavior.

## Executive Finding

The Supervisor has accumulated the right capabilities, but the architecture has not kept up.

The strongest pieces are evidence-first verification, living operator context, doc maintenance, completion gating, playbook learning, verification labels, and UI control. The weakness is that these pieces are now coordinated by one large implicit state machine in `src/agents/supervisor.js`. The result is policy fragility: a small patch can fix one incident and quietly change how completion gates, answer-only requests, holds, doc advancement, or recovery behavior interact.

The next improvement should not be another prompt patch. The next improvement should be a comprehensive architecture refactor that separates observation, policy, actions, state, learning, and UI explanation as one complete body of work. The controlling contract is [[supervisor-comprehensive-refactor-contract]].

## Evidence Reviewed

Code size and ownership:

- `src/agents/supervisor.js`: 1,749 lines.
- `src/agents/evidence.js`: 653 lines.
- `src/agents/host.js`: 332 lines.
- `src/agents/context.js`: 243 lines.
- `src/agents/doc_maintainer.js`: 184 lines.
- `src/agents/verify_labels.js`: 156 lines.
- `src/agents/live_context.js`: 99 lines.
- `src/agents/answer_prompt.js`: 87 lines.
- `src/agents/playbook.js`: 72 lines.
- `src/agents/verify_ledger.js`: 56 lines.
- `src/agents/verify_snapshots.js`: 45 lines.

Important inspected code areas:

- `src/agents/supervisor.js:350` defines regex-based operator intent detection.
- `src/agents/supervisor.js:520` defines the inline completion verification prompt.
- `src/agents/supervisor.js:707` logs interventions and deduplicates only selected unsent rows.
- `src/agents/supervisor.js:755` implements answer handling, including evidence, cited sources, live context, DoD, and playbook input.
- `src/agents/supervisor.js:913` implements completion verification.
- `src/agents/supervisor.js:1068` starts `onTick`, the main scheduler policy.
- `src/agents/supervisor.js:1431` builds doc-maintenance signals from operator messages, own recent verdicts, and agent reports.
- `src/agents/doc_maintainer.js:15` defines a clearer JSON-delta doc-maintenance prompt and is a good pattern to preserve.
- `src/agents/live_context.js:1` treats operator-authored context as window-proof and separate from agent/supervisor messages.
- `src/agents/answer_prompt.js:12` externalizes the answer prompt, unlike the completion verification prompt.
- `web/agents/supervisor.js:139` exposes multiple preview profiles in settings.

Live operational data from the local database:

- `verify/completion/needs_attention`: 832 total rows, 206 sent.
- `answer/question/answered`: 450 total rows, 450 sent.
- `gate/completion/challenged`: 413 total rows, 410 sent.
- `recover/context-wedge/compacted`: 158 total rows, 158 sent.
- `doc-update/maintain/updated`: 135 total rows.
- `answer/action/answered`: 92 total rows.
- `verify/completion/off_track`: 84 total rows, 17 sent.
- `recover/api-error/waiting`: 70 total rows.
- `recover/api-error/retried`: 55 total rows, 54 sent.
- `keepworking/idle/nudged`: 52 total rows, 51 sent.
- `verify/completion/complete`: 42 total rows.
- `escalate/completion/escalated`: 21 total rows.

Learning and audit data:

- Active playbook: version 2, with optimizer evidence of `+4.0pts` on a held-out set of 24 examples compared with version 1.
- Verify labels: 3 `false_complete/untested`, 1 `correct_new_issue/new_issue`.
- Verify ledger rows: 9.
- Verify snapshots: 36.
- Active holds found during review:
  - `s_e8b74301f6`: `goal_conflict`.
  - `s_ea3c3b954e`: `goal_conflict`.

Design intent already documented:

- `docs/supervisor-living-context-DESIGN.md` says the core flaw was frozen-doc execution and calls for live context, staleness reconciliation, decisive default behavior, calibrated escalation, and closed-loop doc maintenance.
- `docs/wiki/skill-evolution-research.md` maps research into shipped features: lessons, playbook optimizer, deep verification, verification ledger, verify labels, and snapshots.

## What Works

The Supervisor is not fundamentally wrong. It has several good ideas that should be preserved.

- Evidence-first completion verification is the right default. The verifier asks for concrete proof from git diffs, tests, screenshots, terminal output, and API output instead of accepting agent prose.
- Living context exists and is conceptually correct. Operator messages are treated as a special source of truth instead of being blended with agent chatter.
- Doc maintenance is moving in the right direction. `doc_maintainer.js` uses a structured JSON delta, which is easier to test and safer than free-form rewriting.
- Model fallback is pragmatic. The Supervisor can keep working when one model path fails.
- The UI exposes meaningful controls: enabled state, grant mode, send capability, self-maintenance, gates, interval, preview profiles, and history.
- Learning primitives exist: playbooks, verification labels, snapshots, and ledgers.
- The recent operator-intent patch fixed an important class of blind sends: question-only requests should not trigger completion-gate challenges.

## Findings

### F1 - Critical: `onTick` is an implicit state machine

`src/agents/supervisor.js:1068` contains the main scheduler policy. It decides when to stand down, answer, verify, maintain docs, recover from API errors, retry context wedges, challenge completion, reopen signed-off work, nudge idle agents, or send checkpoints.

The issue is not just size. The issue is that order now defines policy. A branch added for one incident can affect several other behaviors because there is no explicit decision table.

Examples:

- Wait and question-only intents now short-circuit some branches, but this is enforced by branch placement.
- Completion-gate cooldowns, gate scope keys, holds, signed-off quiet, and progress fingerprints all live in the same flow.
- API recovery and context recovery are mixed with user-intent handling.
- Doc maintenance can run in the same scheduler that controls direct sends.

Impact:

- Hard to reason about "when to wait, when to do nothing, and when to be aggressive."
- Hard to prove that a new patch does not reintroduce blind supervisor messages.
- Hard to write focused tests without constructing a large fake world.

Recommendation:

Extract a pure policy engine:

```js
decision = decideSupervisorAction(snapshot, state, config)
```

The decision engine should return a single decision, a reason, allowed actions, and a state patch. The side-effectful code should execute only that decision.

### F2 - Critical: There is no single send policy guard

Recent incidents were about messages being sent at the wrong time, not just about message wording.

Today, sends happen through several paths:

- Answer handling.
- Completion gate challenge.
- Keep-working nudges.
- API recovery.
- Context-wedge recovery.
- Escalation.
- Checkpoints.

Each path has local checks, but there is no final centralized guard that says:

- What did the operator just ask?
- Is this a question-only turn?
- Did the operator say wait?
- Is this an ack after evidence, where the correct action is no action?
- Has the same scope already been challenged?
- Is this send allowed by the current grant/capability?
- Will this send be useful right now?

Impact:

- New send paths can accidentally bypass recent operator intent.
- Local fixes are easy to miss when behavior is added elsewhere.
- The UI cannot clearly explain why a send happened.

Recommendation:

Add `sendWithPolicy(action, snapshot, state)` and make every outbound Supervisor message pass through it. The policy result should be logged whether it sends or stands down.

### F3 - High: Prompt policy and scheduler policy diverge

The answer prompt is externalized in `src/agents/answer_prompt.js`. The completion verifier prompt remains inline in `src/agents/supervisor.js`.

This creates two policy surfaces:

- The scheduler decides if the Supervisor should act.
- The prompt decides how skeptical, aggressive, or quiet the Supervisor should be.

The split is unavoidable, but the current implementation makes it too easy for prompt wording to compensate for missing scheduler policy.

Impact:

- "Do not blindly repeat the gate" can be patched into a prompt but still be violated by the scheduler.
- The answer path can improve through playbooks while the completion-gate path remains harder to evaluate.
- Prompt edits become a substitute for policy architecture.

Recommendation:

Move prompts into versioned prompt modules and pair each prompt with:

- Input schema.
- Output schema.
- Behavioral tests.
- Snapshot examples.
- Evaluation labels when available.

### F4 - High: State is ad hoc and under-specified

Supervisor state is spread across grant state keys and review rows. Examples include:

- `verifiedWorkFp`
- `gateSentFp`
- `gateSentKey`
- `needsOperatorHold`
- `lastProgressFp`
- `questionOnlyReviewedKey`
- `errSig`
- `ctxWedgeAt`
- `docCutoffTs`

These keys are useful, but the schema is not explicit enough. The code relies on informal invariants about which keys can coexist and when they should reset.

Impact:

- Regressions can happen when unrelated git churn clears or changes state.
- Holds can remain active without a clear operator-facing resolution path.
- It is hard to audit why the Supervisor is quiet or noisy.

Recommendation:

Create a typed state module:

```js
readSupervisorState(grant)
patchSupervisorState(grant, patch)
isSignedOff(state, snapshot)
markGateSent(state, scope)
armHold(state, reason, scope)
clearHold(state, reason)
```

State migrations should be explicit and versioned.

### F5 - High: Tests do not cover the scheduler decision surface

The recent guard tests are valuable, but they mostly test source-level invariants and narrow behavior. The highest-risk logic is the scheduler decision surface.

Needed tests are scenario tests such as:

- Operator says "answer my question only" and the agent answers: Supervisor must not send a completion gate.
- Operator says "OK, I saw it change": Supervisor should record the ack and stand down unless new evidence requires action.
- Agent says "same gate, sixth time, no new signal": Supervisor should not repeat the same gate and should explain the hold state.
- Operator says "continue with Goal 2 after Goal 1": Supervisor should not treat Goal 2 as future work once Goal 1 is complete.
- Agent reports completion with no evidence: Supervisor should challenge with concrete missing evidence.
- Visual work lands with no screenshot: Supervisor should ask for render evidence.
- API error repeats while operator is actively asking a question: Supervisor should not hijack the conversation.

Recommendation:

Build deterministic tests around `decideSupervisorAction`. These should not need a running model.

### F6 - Medium: Learning exists but is not yet governing the risky path

The answer playbook has an optimizer and an active version. Verification labels, snapshots, and ledgers exist. That is good.

The highest user pain, however, has been scheduler behavior:

- Blind completion gates.
- Repeated "I don't accept done" messages.
- Failure to notice answer-only instructions.
- Failure to continue to the next phase when the operator already said to continue.
- Treating "future work" as a reason to stop when the future work is now.

Those are not primarily answer-prompt failures. They are policy failures.

Recommendation:

Add a scheduler-policy eval corpus. Start with live incidents, label the expected decision, and use those as regression tests before optimizing prompt text.

### F7 - Medium: The UI exposes controls but not the current reasoning

`web/agents/supervisor.js` exposes many settings, but the operator still cannot easily answer:

- What does the Supervisor think I just asked?
- Why is it quiet?
- Why did it send that message?
- Is it holding because of a goal conflict?
- What evidence is missing?
- Which policy branch is active?

Impact:

- The operator sees repeated messages as "dumb" because the system does not show its decision state.
- Debugging requires reading database rows or source code.

Recommendation:

Add a "Supervisor State" panel backed by backend summary data:

- Current operator intent.
- Current decision or stand-down reason.
- Active hold, if any.
- Last allowed send and why it was allowed.
- Last blocked send and why it was blocked.
- Gate scope key.
- Verified work fingerprint.
- Last evidence snapshot age.

### F8 - Medium: The supervision doc is useful but too loosely parsed

`gateScopeKey` derives scope from document headings and bullets. The doc maintainer advances prose sections such as Goal, Now, Acceptance, Rules, and Decisions.

This is workable, but it is brittle:

- Heading variants can change behavior.
- Non-bullet acceptance criteria may be missed.
- The scheduler depends on markdown shape.
- "Future" versus "current" work is a semantic distinction but is represented as prose.

Recommendation:

Introduce a structured supervision-doc model:

```js
{
  goal: string,
  currentPhase: string,
  nextPhase: string,
  acceptance: [],
  hardRules: [],
  decisions: [],
  blockedUntil: null | { reason, requiredOperatorInput },
  version: number
}
```

Markdown can remain the human-readable storage format, but parsing should produce schema warnings and policy should consume the structured model.

### F9 - Medium: Doc maintenance intentionally avoids tool evidence

`maintainSignals` uses operator signals, recent Supervisor verdicts, and agent reports. It deliberately avoids raw diffs and tool calls, which keeps it cheap and less noisy.

The risk is that the doc can advance based on agent prose or Supervisor verdict summaries rather than a normalized evidence state.

Recommendation:

Do not feed raw diffs directly into doc maintenance. Instead, feed normalized verifier outputs:

- `phaseComplete: true/false`
- `acceptedCriteria: []`
- `missingCriteria: []`
- `evidenceRefs: []`
- `operatorDecisions: []`

This preserves cost control and improves correctness.

### F10 - Medium: Holds need first-class lifecycle and UI

Active `goal_conflict` holds exist in the database. Holds are useful, but their lifecycle needs to be explicit:

- Why was the hold armed?
- What operator signal clears it?
- What work is still allowed while held?
- When should it expire?
- How should it appear in the UI?

Recommendation:

Model holds as typed state, not just a state key. Add UI display and an explicit clear path.

## Proposed Architecture

The Supervisor should be refactored into a pipeline:

```text
Observe -> Decide -> Act -> Learn -> Explain
```

### 1. Observe

Build a normalized snapshot from session state, messages, evidence, docs, repo status, and prior Supervisor state.

Suggested module:

- `src/agents/supervisor/observe.js`

Suggested output:

```js
{
  session: {
    id,
    status,
    category,
    updatedAt
  },
  operator: {
    lastMessageTs,
    intent,
    confidence,
    text,
    signals
  },
  work: {
    agentStatus,
    reportedCompletion,
    progressFingerprint,
    evidenceBrief,
    missingEvidence
  },
  doc: {
    goal,
    currentPhase,
    acceptance,
    hardRules,
    decisions,
    gateScopeKey,
    staleWarnings
  },
  state: {
    signedOff,
    activeHold,
    lastGate,
    verifiedWorkFp,
    pendingQuestionOnlyReview
  }
}
```

### 2. Decide

Make one pure policy decision.

Suggested module:

- `src/agents/supervisor/policy.js`

Suggested output:

```js
{
  decision: 'stand_down' | 'answer_question' | 'maintain_doc' | 'verify_completion' | 'challenge_completion' | 'keep_working' | 'recover_api' | 'recover_context' | 'checkpoint' | 'escalate',
  reason: string,
  confidence: 'high' | 'medium' | 'low',
  allowedSend: boolean,
  statePatch: {},
  evidenceRefs: []
}
```

The policy module should be deterministic and unit-tested without model calls.

### 3. Act

Execute the chosen action.

Suggested module:

- `src/agents/supervisor/actions.js`

Rules:

- Every send passes through `sendWithPolicy`.
- Every no-send is logged as a policy decision.
- Model calls are action implementations, not policy definitions.

### 4. Learn

Keep the existing learning systems, but route them through the same decision vocabulary.

Suggested module:

- `src/agents/supervisor/learning.js`

Inputs:

- Verification labels.
- Verify snapshots.
- Answer playbook outcomes.
- Operator corrections.
- Scheduler-policy examples.

Outputs:

- Prompt addenda.
- Watchlist patterns.
- Policy regression cases.

### 5. Explain

Expose the current Supervisor state to the UI.

Suggested module:

- `src/agents/supervisor/ui_summary.js`

The UI should not have to infer state from review history. Backend summary should directly answer:

- What is the current policy decision?
- Why?
- What would make the Supervisor act next?
- What message, if any, was blocked by policy?

## Refactor Contract

The implementation plan in this review has been superseded by [[supervisor-comprehensive-refactor-contract]].

The important correction is that the Supervisor redesign is not a starter task with optional later work. It is one complete refactor program with workstreams for decision records, snapshots, operator intent, policy, dispatch, verification, supervision-doc modeling, holds/state, learning, UI transparency, replay fixtures, and runtime migration.

Future agents should use this review for diagnosis and use [[supervisor-comprehensive-refactor-contract]] as the controlling implementation checklist.

## Acceptance Criteria Summary

- A deterministic policy test suite covers at least 10 live incident fixtures.
- `src/agents/supervisor.js` no longer owns observation, policy, prompts, actions, learning, and UI summaries in one file.
- Every outbound Supervisor message has a recorded policy reason.
- Every blocked send or stand-down decision has a recorded reason.
- Operator `question_only`, `wait`, `continue`, and `ack` intents are visible in backend summary and UI.
- Active holds have type, scope, reason, clear condition, and UI visibility.
- Prompt versions are recorded for verifier decisions.
- No new npm dependencies are added.
- Any deploy uses `bin/deploy`, which performs the version bump.

## Proposed Module Layout

```text
src/agents/supervisor/
  index.js              # exported agent definition, thin integration layer
  observe.js            # builds SupervisorSnapshot
  policy.js             # pure decision engine
  actions.js            # side effects and model calls
  state.js              # typed state helpers and migrations
  prompts/
    answer.js
    verify.js
    unstick.js
    doc_generate.js
    doc_revise.js
  learning.js           # playbook, labels, snapshots, scheduler corpus
  ui_summary.js         # backend summary for web panel
  fixtures/             # regression fixtures from live incidents
```

The final `src/agents/supervisor.js` can remain as a compatibility shim during migration.

## Bottom Line

The Supervisor should become less like a patched chatbot and more like a small policy engine with model-backed actions.

The right next step is a refactor that first makes the current behavior inspectable and testable. After that, behavior changes such as smarter continuation, better silence, stronger gates, and better learning can be made with much lower risk.
