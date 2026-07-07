# External review: supervision-doc → task-card refactor (gpt-5.5, 2026-07-07)

> Brief sent: full stack context + this session's monolith doc as evidence + the proposed
> task-card/scope design. Reviewer instructed to be adversarial. Verbatim response below.

## 1. Attack on task-card design / boundary detection

The task-card direction is correct, but the riskiest part is pretending the system can reliably infer “task boundaries” from ambient session chatter. It cannot, at least not cheaply and not without operator/builder cooperation.

### Main failure modes

#### A. False split mid-task

Example:

- Builder says: “Fixed pricing display. Now I’ll update tests.”
- Maintainer interprets “fixed pricing display” as task completion.
- Opens new card for “update tests.”
- Completion gate now verifies tests against a new card that no longer includes the original pricing acceptance criteria.
- Result: the system can mark incomplete work as complete because the acceptance criteria got partitioned too early.

This is especially likely when builders narrate phases as if they are separate tasks.

Concrete mitigation:

- Do not allow automatic split on progress prose alone.
- Require one of:
  - explicit operator signal,
  - explicit builder handoff/completion claim plus supervisor verification,
  - a command/button in UI,
  - strong terminal/project signal such as new branch/PR/issue selection, but only as supporting evidence.

#### B. Missed split, monolith reforms

Example:

- Operator says: “Okay, ignore that for now. Can you look at the GitHub migration bug?”
- Maintainer treats this as a timeline entry, not a new card.
- Active card accumulates unrelated acceptance criteria.
- You recreate today’s problem inside one “active” card.

Concrete mitigation:

- The maintainer should run a cheap “current request compatibility” check whenever an operator gives an imperative:
  - Does this request modify/extend the active card?
  - Or does it introduce a different deliverable?
- If confidence is low, ask a short disambiguation instead of guessing:
  - “Is this a new task card or a change to the current task?”
- Make this a one-click UI affordance, not an LLM ceremony.

#### C. Operator corrections become hard to model

Operator corrections often mean one of three things:

1. Amend the active task.
2. Close current task as abandoned and start a new one.
3. Record reusable doctrine/preference.

If you do not force this distinction, corrections will leak into the wrong layer again.

Concrete mitigation:

Every maintainer-generated update should have a type:

```ts
type DocUpdate =
  | { kind: "task_amendment"; task_id: string; patch: string }
  | { kind: "task_close"; task_id: string; outcome: "done" | "abandoned" | "superseded"; summary: string }
  | { kind: "task_open"; title: string; goal: string; acceptance: string[] }
  | { kind: "doctrine_candidate"; scope_hint: "project" | "global"; text: string }
  | { kind: "precedent_episode"; ask: string; answer: string; task_id?: string };
```

Without typed mutations, you will just have a prettier markdown monolith.

### Cheapest robust boundary signal

The cheapest robust boundary signal is **explicit operator intent**, captured with minimal UI friction.

Recommended v1 boundary hierarchy:

1. **Operator button / command**: “New task”, “Close task”, “Switch task”.
2. **Operator natural-language strong signal**, e.g.
   - “new task”
   - “different issue”
   - “pause this”
   - “forget that”
   - “now work on…”
   - “next: …”
3. **Verified completion of active task**, followed by a new operator ask.
4. **Builder completion claim** only after supervisor verifies against active card.
5. **LLM inference from ambient logs** as a suggestion only, never authoritative.

Do not let the maintainer silently close/open cards based on ambiguous model inference. That is how you get invisible corruption.

### Better v1 behavior

Instead of fully automatic boundary detection, ship **boundary suggestions**:

> “This looks like a new task: ‘GitHub migration bug’. Start a new task card?”

Buttons:

- New card
- Amend current card
- Ignore
- Close current + new card

This keeps the operator in the loop only at the high-risk moment. It is cheaper than recovering from bad splits later.

### Critical missing concept: task state machine

You need a real state machine, not just `status`.

Suggested:

```ts
status:
  | "active"
  | "blocked"
  | "awaiting_operator"
  | "verification_pending"
  | "done"
  | "abandoned"
  | "superseded"
```

Also enforce:

- One active task per session.
- Optional paused tasks if you expect task switching.
- A task cannot become `done` without a verification record.
- A task cannot be closed by maintainer inference without either operator confirmation or verified completion.

If users actually interleave tasks, “exactly one ACTIVE” may be too rigid. You probably want one **foreground** task, but allow paused/open tasks. Otherwise users will jam multiple live items into the active card because the model cannot represent reality.

---

## 2. Is dropping session scope from doctrine right?

Mostly yes. “Session-scoped doctrine” is dangerous because it sounds like a reusable rule but has the lifecycle of temporary context. That is exactly the bug you are trying to eliminate.

Session-level instructions should usually be one of:

- task-card constraints,
- operator stance,
- project doctrine,
- global doctrine,
- decision-memory precedent,
- ephemeral runtime state.

Do not add `doctrine.scope=session` unless you have a very crisp use case and expiry semantics.

### Things that may look session-level but should not be doctrine

#### “For this debugging session, do not run migrations.”

That is task constraint or temporary safety flag, not doctrine.

#### “In this session, answer tersely.”

That is stance or interaction mode, not doctrine.

#### “For this investigation, only inspect logs, do not modify code.”

Task-card hard constraint.

#### “Builder is currently planning; do not interrupt.”

Stage awareness/runtime state.

#### “This tmux pane is connected to production.”

Environment/session metadata, maybe a safety policy, but not doctrine.

### Is there anything precedents + task cards cannot hold?

Yes: **session runtime facts**.

Examples:

- active branch name,
- running server port,
- current tmux pane layout,
- environment variables,
- active PR,
- current worktree,
- pending uncommitted changes,
- test command currently known to work,
- builder agent identity/capabilities,
- project root path,
- whether this session is a continuation/import.

These should not go in doctrine or task cards. They are mutable session state.

You need a small `session_context` or `session_runtime` object:

```ts
session_runtime {
  session_id,
  project_id,
  project_root,
  worktree_path,
  branch,
  agent_kind,
  active_task_id,
  known_commands: [
    { name: "test", command: "npm test", source: "observed", last_success_at }
  ],
  environment_notes: string[],
  safety_flags: string[]
}
```

The task card answers “what are we trying to accomplish?” Runtime context answers “what world are we operating in?”

Without this, task cards will become junk drawers for operational facts.

---

## 3. Project→user promotion mechanic

The proposed trigger — “evidence from ≥2 projects” — is directionally right but too naive.

### Failure mode: accidental overgeneralization

Example:

- Project A: “Use Playwright screenshots before claiming UI complete.”
- Project B: same rule appears because both are frontend apps.
- System proposes global rule.
- But Project C is a CLI-only tool where this is nonsense.

Cross-project recurrence is evidence, not proof.

### Failure mode: duplicate wording hides semantic difference

Example:

- “Never auto-send without evidence” in a personal project.
- “Never auto-send without evidence” in a regulated client project.

Same wording, different severity. One may be advisory; the other audit/hard-blocking.

### Failure mode: two projects is too low for high-impact rules

For harmless style preferences, two projects is enough.

For rules that constrain autonomy, verification, safety, or sending authority, two projects is not enough.

### Better trigger

Use a promotion score, not a flat count.

```ts
promotion_score =
  distinct_projects_weight
  + repeated_operator_approval_weight
  + semantic_similarity_weight
  + recency_weight
  - project_specific_terms_penalty
  - conflict_penalty
  - severity_penalty
```

For v1, simpler:

Promote candidate if:

- appears in at least 2 distinct projects,
- operator approved/reinforced it at least twice,
- no project-specific named entities are present,
- no conflicting doctrine exists,
- model classifies it as “preference/process” not “project fact/task constraint.”

Have separate thresholds by category:

```ts
category:
  | "style_preference"        // low bar
  | "workflow_preference"     // medium
  | "verification_standard"   // medium/high
  | "autonomy_policy"         // high
  | "safety_policy"           // very high / manual only
```

### Better UI language

Do not say “promote to global” as if it is obvious. Say:

> “This rule appeared in 3 projects. Should Supercalm treat it as a user-wide preference?”

Show:

- original project rules,
- evidence snippets,
- affected projects,
- proposed global wording,
- what will happen to project-specific copies.

### Important: promotion should not delete project-specific nuance

A global rule may coexist with project overrides.

Example:

Global:

> “Do not claim completion without concrete evidence.”

Project override:

> “For this project, UI completion requires screenshots.”

So promotion should produce:

```ts
global_rule: "Completion claims require concrete evidence."
project_rule: "For UI work in this project, screenshots are required evidence."
```

not merge everything into one blunt global rule.

---

## 4. Migration risks for ~100 existing sessions

Migration is where this design can hurt users immediately.

### Biggest risk: hard-rules→doctrine flood

You already know the operator is complaining that learning is too much to review. Dumping every `## Hard rules` line from 100 sessions into triage will create a queue nobody will clear.

You need migration throttling and classification.

Do not send every migrated line to human triage.

First classify into buckets:

```ts
hard_rule_class:
  | "operator_preference_candidate"
  | "project_fact"
  | "task_constraint"
  | "obsolete_task_context"
  | "implemented_product_design"
  | "anti_staleness_patch"
  | "environment_note"
  | "duplicate_existing_doctrine"
  | "discard_suggestion"
```

Only `operator_preference_candidate` and maybe `duplicate_existing_doctrine` should reach the approval queue.

### Migration strategy

Do not rewrite all sessions eagerly.

Use lazy migration:

- When a session is opened/engaged, migrate that session.
- Keep original markdown untouched as backup.
- Generate proposed active card.
- Generate archived summary.
- Show diff in UI if confidence is low.

For dormant sessions, do nothing until touched.

### Migration output should be conservative

For each existing monolith:

1. Seed active card from `## Now`, current goal-ish text, latest unresolved timeline entries.
2. Archive old Decisions/Timeline as a compressed session history.
3. Do not inject old archive into prompts except one-line summaries.
4. Classify hard rules:
   - obvious doctrine candidates to triage,
   - project facts to CONTEXT/wiki candidate,
   - old task URLs to archive only,
   - anti-staleness negations to delete/suppress.

### Specific migration failure cases

#### A. Active card seeded from stale `## Goal`

You already had a real incident from stale goal injection. Do not trust `## Goal`.

Order of trust should be:

1. `## Now`
2. recent operator asks
3. recent builder activity
4. recent terminal/git evidence
5. latest timeline entries
6. old `## Goal` last, if at all

#### B. Anti-staleness patch becomes doctrine

Bad migration:

> “Do not treat ~/tmp/design_handoff_hermes_ui_v2 as current AIOS goal.”

If this becomes global/project doctrine, you have fossilized garbage.

These lines should be classified as `anti_staleness_patch` and discarded after the active card is fixed.

#### C. Product design fossils become doctrine

Bad migration:

> “Supervisor stage awareness must stand down during planning.”

If this is already shipped code, it should not become doctrine. At most it is historical rationale.

Classification should detect product-internal implementation decisions and avoid triage.

#### D. Dead URLs pollute project knowledge

Investigation URLs from a completed task should not move to CONTEXT.md/wiki. They belong in the archived task.

### Queue pressure control

Add migration triage caps:

- Max 3 doctrine candidates per migrated session.
- Batch duplicates aggressively.
- Hide low-confidence candidates by default.
- Auto-drop candidates classified as obsolete with high confidence.
- Show one “Migration review” bundle per project, not per session.

Better:

```ts
migration_candidate {
  text,
  proposed_destination:
    | "doctrine_project"
    | "doctrine_global"
    | "project_context"
    | "task_archive"
    | "discard",
  confidence,
  reason,
  source_session_ids[],
  duplicate_of_candidate_id?
}
```

The operator should review grouped concepts, not individual fossil lines.

---

## 5. What is over-engineered / what to cut / what is under-specified

### Over-engineered for v1

#### A. Fully automatic task-boundary detection

Cut it. Ship suggestions plus explicit controls.

Automatic open/close should only happen on verified completion + new operator request. Everything else should be proposed.

#### B. One-line summaries of last few archived cards in every prompt

Be careful. This can reintroduce stale context. Why should archived card summaries go into every answer/verify prompt?

For v1, include archived summaries only when:

- active task references prior work,
- retrieval finds a relevant archived card,
- operator asks about history,
- verifier needs to compare against previous claimed completion.

Default prompt should be active card only, not “last few tasks.” Recency is not relevance.

#### C. Task-card markdown as the primary data model

If the card is stored as opaque markdown, you will regret it. You need structured fields plus markdown rendering.

Use:

```ts
session_tasks {
  id,
  session_id,
  project_id,
  status,
  title,
  goal,
  acceptance_criteria_json,
  verification_notes_json,
  constraints_json,
  created_at,
  closed_at,
  outcome,
  close_summary,
  created_by,
  updated_by
}
```

Then render markdown from structure.

If you store only `doc_md`, every gate/verifier must parse markdown forever.

#### D. Migration “history collapses to one archived card”

This may be too lossy. A weeks-long session with 15 tasks should not become one archived card if you want future retrieval. But do not manually reconstruct all 15 either.

V1 compromise:

- One active card.
- One legacy archive blob.
- Optionally generate extracted archived task summaries as retrieval-only, not UI-authoritative.

### What to cut for v1

Ship:

1. Active task card with structured fields.
2. Explicit New/Close/Supersede controls.
3. Boundary suggestions, not automatic boundary changes.
4. Completion gate reads active card only.
5. Supervisor reads project knowledge.
6. Hard-rules migration classifier with aggressive suppression.

Defer:

- complex multi-task switching,
- automatic task segmentation,
- global promotion scoring beyond simple distinct-project suggestions,
- full archive card reconstruction,
- fancy timeline carryover,
- feeding last N archived cards into every prompt.

### Under-specified things that will bite in code

#### A. What counts as “active”?

You say exactly one active. But real users pause tasks. Need policy:

- Is there one active and many paused?
- Can a session resume a paused task?
- How does builder know which one is foreground?
- What happens when operator asks about old task?

#### B. Who is allowed to mutate a card?

Potential mutators:

- operator,
- supervisor,
- doc-maintainer,
- builder via prose,
- migration job.

You need provenance on every mutation.

```ts
task_event {
  id,
  task_id,
  actor_type: "operator" | "supervisor" | "maintainer" | "migration" | "builder",
  event_type,
  patch,
  confidence,
  created_at
}
```

Never let builder prose directly mutate acceptance criteria without supervisor/operator mediation.

#### C. Acceptance criteria lifecycle

Criteria need IDs and status.

```ts
acceptance_criterion {
  id,
  text,
  status: "open" | "satisfied" | "removed" | "superseded",
  evidence_refs[],
  created_at,
  source
}
```

Otherwise the verifier cannot cleanly say which criteria passed/failed.

#### D. Evidence model

If the gate grills against criteria, where is evidence stored?

You need evidence records:

```ts
verification_evidence {
  id,
  task_id,
  criterion_id?,
  kind: "git_diff" | "test_output" | "terminal" | "screenshot" | "file_read" | "url" | "manual_operator",
  ref,
  summary,
  collected_at
}
```

Without this, every verification is transient prompt soup.

#### E. Project knowledge ingestion

“Supervisor reads CONTEXT.md/wiki” is underspecified.

Questions:

- Which files?
- Max tokens?
- Retrieval or full injection?
- How stale?
- What if CONTEXT contradicts doctrine?
- What if builder has updated CONTEXT but supervisor cache is old?
- Is CONTEXT trusted more than task card?

You need precedence:

1. operator direct instruction,
2. active task card,
3. global/project doctrine,
4. project knowledge,
5. precedents,
6. archived history.

Also distinguish facts from policy. Project knowledge should not override doctrine.

#### F. Conflict handling

What if active card says “do not run tests” and doctrine says “verify with tests”?

You need explicit conflict behavior:

- hard task constraint can narrow verification method,
- doctrine can flag risk,
- supervisor escalates if verification cannot meet doctrine.

---

## 6. Other stack layers this refactor should touch

### A. Decision memory should be task-aware

Yes, archived cards should feed decision memory, but not as raw prompt history.

Create task-linked episodes:

```ts
decision_episode {
  id,
  project_id,
  session_id,
  task_id,
  ask,
  operator_answer,
  outcome,
  tags,
  created_at
}
```

Retrieval should include:

- same project boost,
- same task type boost,
- active card semantic similarity,
- recency decay,
- doctrine conflict penalty.

Do not inject whole archived cards. Retrieve specific relevant episodes.

### B. Completion gate should use active card plus doctrine, not project knowledge as acceptance criteria

The gate should not invent acceptance criteria from CONTEXT.md unless the active card references project standards.

Bad:

- CONTEXT says “we usually use screenshots.”
- Gate fails backend refactor for no screenshot.

Good:

- Doctrine says UI changes require screenshot evidence.
- Active card is UI-related.
- Gate requires screenshot.

Project knowledge can inform verification, but it should not silently expand scope.

### C. Attention governor should consider task state

Current governor is based on operator touch recency. That is useful but incomplete.

Task state should alter engagement:

- `awaiting_operator`: higher priority.
- `verification_pending`: engage if hot/warm and send-authority permits.
- `blocked`: summarize/escalate.
- `done`: stop unless new ask.
- `abandoned/superseded`: no verify.

This prevents verifier churn on closed tasks.

### D. Stage awareness should attach to task, not just session

Planning/implementation/verification is a task-local state.

If a session has a paused implementation task and an active planning task, session-level stage awareness will be wrong.

Add:

```ts
task_phase:
  | "intake"
  | "planning"
  | "plan_approval"
  | "implementation"
  | "verification"
  | "done"
```

### E. Operator stance may need task-specific override

Durable stance like autopilot/hold may not be enough.

Operator might say:

- “Autopilot this cleanup.”
- “Hold on the migration.”
- “Answer-only for this investigation.”

Do not necessarily add full “session doctrine”; add task-level authority override:

```ts
task_authority {
  task_id,
  send_authority_mode_override?,
  expires_at?,
  source
}
```

### F. Doctrine should store source and demotion reason

If migration and promotion are added, doctrine needs better provenance.

```ts
doctrine_rule {
  id,
  scope,
  project_id?,
  text,
  enforcement,
  category,
  evidence_count,
  distinct_project_count,
  source: "operator_approved" | "migration" | "promotion",
  source_refs[],
  last_used_at,
  status
}
```

Otherwise you cannot debug why a fossil rule exists.

### G. The supervisor must stop treating docs as trusted truth

This is the philosophical bug underneath the current system.

The task card is not “truth.” It is an operator-maintained contract. The supervisor should still be skeptical:

- Task card says current goal is X.
- Recent operator message says Y.
- Builder is editing unrelated files.
- Git branch name says Z.

Inconsistency should trigger a clarification, not blind injection.

Add an “active context consistency check” before important sends/verifications:

```ts
if active_card.goal conflicts with recent_operator_request:
  ask_or_suggest_boundary_update()
```

### H. Add a garbage-collection policy

Cards will rot too.

For active cards:

- If no touch in 48h/7d, mark stale/suspect.
- If operator returns after long gap, summarize and ask whether to resume or start new.
- Do not blindly inject an active card from three weeks ago just because it is active.

This interacts with the attention governor. “Stale = detection only” should probably also mean “do not use stale active task for authoritative answering without confirmation.”

---

## Bottom line

The task-card architecture is the right direction, but only if you avoid three traps:

1. **Do not replace one markdown monolith with many opaque markdown blobs.** Use structured task fields and event provenance.
2. **Do not pretend boundary detection can be fully automatic.** Make explicit/suggested task transitions the v1 core.
3. **Do not let archives creep back into every prompt.** Retrieval only; active card is the contract.

Recommended v1 cut:

- Structured active task card.
- Explicit/suggested task boundary controls.
- Completion gate reads active card only.
- Project knowledge wired via retrieval.
- Migration classifier with aggressive discard/grouping.
- Doctrine promotion suggestions, not automatic promotion.

Everything else can wait.