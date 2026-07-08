# Panel round 2: supervisor doc re-architecture — project layer, knowledge line, multi-session (2026-07-07)

Brief: full stack context + operator's per-section doc critique + new requirements (multi-session inheritance, knowledge/supervisor line) + round-1 proposal & gpt-5.5 review. Three models answered Q1–Q6 independently.

---
## Claude Fable 5

# Q1. PROJECT SUPERVISION LAYER

**POSITION: Yes — project-scoped supervision store is the ground truth; sessions hold only a pointer to their active task card plus runtime facts.**

The thrash incident and requirement #2 make session-scoped docs untenable: two sessions on one repo must see the same open tasks and standards. Shape:

```
project_supervision/{project_id}/
  standards.yaml        # acceptance standards, durable verify heuristics
  goals.yaml            # north-star + current milestones (operator-editable)
  tasks/{task_id}.json  # card: goal, ac[{id,status,evidence_ref}],
                        #   constraints[], verify_notes, session_claims[],
                        #   state: draft|active|verify_pending|done|abandoned
  events.jsonl          # append-only outcome log (Q4)
session/{sid}.json      # active_task_id, runtime{branch,ports,test_cmd}, tier
```

Project layer owns: acceptance **standards** (recurring quality bars — "all endpoints need tests"), goals, task registry, history. Task card owns: goal, task-specific acceptance criteria (instantiated, ID'd, with evidence refs), task constraints, verify notes. Session owns only: which task it's driving, runtime facts, engagement state.

Key rule: a task can be claimed by at most one session at a time (`session_claims` with heartbeat) — this is the primitive that makes Q3 conflict detection cheap. GPT-5.5's structured-fields/typed-mutations verdict is right; I'd add the claim mechanism it missed.

---

# Q2. THE LINE

**POSITION: Knowledge = descriptive facts about the codebase (agent-writable, builder-trusted); supervisor state = normative judgments and evidence (operator/supervisor-writable only) — the supervisor READS knowledge via retrieval but never trusts it as verification evidence.**

Decision rule: **it belongs to knowledge iff it describes what IS (architecture, conventions-as-documentation, how-to run things) and would be true regardless of any supervision decision; it belongs to supervisor state iff it encodes what SHOULD be accepted, who decided it, or what evidence exists.**

Knowledge owns: CONTEXT.md, wiki (architecture, module maps, setup, gotchas), API surfaces. Writers: builder agents + operator.

Supervisor owns: task cards, acceptance standards, doctrine rules, decision precedents, event log, session runtime. Writers: maintainer LLM + operator approval; **never builder agents** — skeptical philosophy demands the builder cannot write into the store that judges it.

Read path: retrieval, not injection. The supervisor pulls wiki chunks scoped to the active task's touched files/topics (BM25 over wiki sections, top-3, ~1.5k tokens cap). Full CONTEXT.md injection would recreate the monolith problem the card architecture just killed. One exception: a knowledge-derived `verify_facts` snippet (test command, build check) may be pinned to the card at task start — copied with provenance, not live-read, so a builder editing the wiki mid-task can't move the goalposts.

---

# Q3. MULTI-SESSION SAME-PROJECT

**POSITION: Task-claim locking + cross-session conflict detection first; inheritance-on-open second; enforced worktree isolation is advisory-only, not mandated.**

Ranked by value/cost:

1. **Task claims + conflict detection (highest value, low cost).** With the Q1 project store, detection is nearly free: each session's runtime records branch + files touched (from git diff, already collected for verify). Overlap check: same branch OR intersecting file sets across live sessions → warn both supervisors + operator, downgrade autopilot to co-pilot on the conflicting sessions. This directly prevents the 10-deploy thrash.
2. **Inheritance-on-open (high value, medium cost).** Fresh session inherits: acceptance standards (always), project goals (always), open task list (offered — "resume task X or start new?"), last ~5 outcome events (retrieval-eligible, not injected). Do NOT inherit another session's task card wholesale — cards are claimed, not copied.
3. **Deploy serialization (medium).** A project-level advisory lock on "deploy" actions; audit-enforcement doctrine rule, operator-approvable.
4. **Enforced worktree isolation (lowest).** High friction, breaks legitimate pair-session workflows, and the supervisor shouldn't dictate repo topology. Offer as a suggestion when conflicts recur ≥2× in a project; never enforce.

Disagreement with implicit round-1 framing: isolation is a workaround; shared state + claims is the fix.

---

# Q4. TIMELINE

**POSITION: Kill the prose Timeline; replace with a project-level append-only event log of typed outcome records, retrieval-only, with "Resolved" folded in as an event type.**

The operator's stated purpose (don't repeat work, historical context for new tasks) is a **retrieval** problem, not an injection problem — GPT-5.5's "recency is not relevance" is correct and I extend it: the timeline should not exist as a document at all.

Write path: on task state transitions (done/abandoned/blocked-resolved) and on notable incidents (regression, rollback, conflict), the maintainer appends:

```json
{ts, type: "task_done|task_abandoned|incident|resolved|decision",
 task_id?, summary: "≤2 sentences", files_touched: [],
 outcome: "shipped|reverted|superseded", refs: {commit, card}}
```

"Resolved" merges in as `type:resolved` events linked to the blocking event — yes to the operator's merge instinct.

Read path: three triggers only — (a) new task creation: BM25 over summaries+files_touched using the new goal, top-5, injected once into card-drafting; (b) verify: events touching the same files (catches "we reverted this approach before"); (c) operator asks "what happened with X". Never in routine answer prompts.

Expiry: never delete (append-only, it's cheap JSONL); `superseded` outcomes get a recency penalty in ranking. 21d staleness doesn't apply — history doesn't go stale, it goes less relevant.

---

# Q5. MINIMAL ARTIFACT SET

**POSITION: Seven artifacts, exactly one always-injected per prompt (the active card); everything else retrieval or on-event.**

| # | Artifact | Scope | Writer | Lifecycle | Injection |
|---|----------|-------|--------|-----------|-----------|
| 1 | **Active task card** (goal, AC w/ ids+status+evidence, constraints, verify notes, pinned verify_facts) | task | maintainer + operator edits | archived on done/abandoned → becomes event | **always** (only always-inject artifact) |
| 2 | **Acceptance standards** | project | operator-approved via triage funnel | 21d staleness sweep | on-event: verify + card-drafting prompts only |
| 3 | **Project goals/milestones** | project | operator (maintainer suggests drift) | operator-managed | on-event: card-drafting + boundary suggestions |
| 4 | **Event log** (Q4) | project | maintainer, append-only | never expires; superseded = rank penalty | retrieval only |
| 5 | **Doctrine rules** | project + user | existing pipeline (approval=deployment) | existing 21d sweep | existing (matched rules only) |
| 6 | **Decision precedents** | project | existing (answered asks) | existing | retrieval (BM25+recency, existing) |
| 7 | **Session runtime** (active_task_id, branch, ports, test_cmd, files_touched, claims) | session | supervisor auto | dies with session; claims heartbeat 10min | always, but ~150 tokens |

Explicitly deleted: `## Now` (the active card IS now), `## Decisions & agreements` (splits into doctrine/events/precedents), prose Timeline, Resolved. Budget target: routine answer prompt = card + runtime + matched doctrine ≈ 2–3k tokens; verify adds standards + retrieved events.

---

# Q6. SEQUENCING VERDICT

**POSITION: Land a thin project store FIRST (2–3 days), then cards inside it — building session-scoped cards first means migrating the migration.**

Round-1's v1 was right pre-requirement-#2; it's wrong now. Cards written into session storage would need a second re-homing migration within weeks, and the thrash incident makes multi-session the operator's live pain. But "project layer first" doesn't mean the full Q5 set — just the directory + task registry + claims.

Build order:

1. **Project store skeleton**: `tasks/`, `events.jsonl`, session→task pointer, task claims. No behavior change yet; pure data layer.
2. **Structured active card + gate-reads-card-only + boundary suggestions** (round-1 core, now project-homed). Deletes `## Now`, monolith injection.
3. **Conflict detection**: branch/file overlap across live sessions → warn + authority downgrade. Cheapest payoff from step 1; directly addresses the incident.
4. **Event log write path + retrieval into card-drafting/verify**; fold Resolved in.
5. **Migration classifier for ~100 legacy docs** (lazy, on-touch, per GPT-5.5) + standards/goals extraction into project files.

**Cut: cross-project promotion suggestions to user scope.** It's the only round-1 item serving zero current pain — no evidence of cross-project rule recurrence yet, and the triage funnel already provides a manual path. Ship it when the data shows repeats.
---
## GPT-5.5

## Q1. PROJECT SUPERVISION LAYER

POSITION: Yes — supervision must be project-scoped, with task cards as narrow contracts and sessions as execution containers.

Project layer owns reusable supervisory context; task cards own the current commitment.

Data shape:

```ts
ProjectSupervision {
  project_id
  acceptance_standards: Standard[] // durable quality gates, e.g. tests, deploy expectations
  project_goals: Goal[]            // current product/technical direction, reviewed/expiring
  open_tasks: TaskRef[]
  recent_outcomes: OutcomeSummary[] // retrieval-indexed, not always injected
  active_sessions: SessionRef[]
  risk_register: Risk[]             // known regressions, flaky areas, migration hazards
  project_doctrine_overrides: RuleRef[]
}

TaskCard {
  task_id
  session_id
  status: proposed|active|verify_pending|done|abandoned
  goal
  acceptance_criteria: Criterion{id,status,evidence}
  verification_plan
  task_constraints
  linked_project_standards: StandardRef[]
  created_from
  provenance
}
```

Sessions should hold runtime facts only: branch, worktree, ports, command history, current agent state.

Acceptance standards can live at project scope when they recur across tasks: “must run smoke test before complete,” “don’t regress panel layout,” “deployment requires operator approval.” Task-specific criteria stay on the card: “Fable 5 appears in model list and works.”

History is project-level but retrieval-only. Never inject “all history.” Inject standards always when relevant; retrieve outcomes by files, feature, task type, or operator ask.

---

## Q2. THE LINE

POSITION: Knowledge is descriptive project truth; supervisor state is normative, operational, evidential, or authority-bearing.

Decision rule: it belongs to knowledge iff a competent builder should know it to implement correctly and it is not itself a supervision contract, approval rule, live task state, or verification judgment.

Knowledge owns:

- Architecture notes
- Domain concepts
- Setup instructions
- API contracts
- Codebase maps
- Design rationale
- Known components
- Historical explanations useful for implementation

Supervisor owns:

- Task cards
- Acceptance criteria/status/evidence
- Project acceptance standards
- Doctrine/rules
- Operator stance
- Send authority
- Session runtime facts
- Verification results
- Cross-session conflict state
- Outcome records
- Escalations/approvals

Writers:

- Knowledge: builder may propose/write; supervisor may suggest corrections; operator can approve important changes.
- Supervisor state: supervisor writes operational/evidence state; operator approves policy/doctrine/authority; builder cannot directly mutate supervisory truth except by producing evidence.

The supervisor should read knowledge through retrieval, not full injection. Retrieve by active task, touched files, error terms, and verification target. For high-salience project standards, the supervisor state may reference knowledge pages, but the enforceable copy belongs in supervisor state, not wiki prose.

Do not let agent-writable knowledge become hidden policy. If it affects gatekeeping, promote it into supervisor-maintained standards/doctrine with provenance.

---

## Q3. MULTI-SESSION SAME-PROJECT

POSITION: Shared project state plus conflict detection is mandatory; worktree isolation should be strongly recommended and selectively enforced.

Ranked by value/cost:

1. **Shared project supervision registry — high value, moderate cost.**  
   Track active sessions, branches, worktrees, touched files, claimed tasks, verification state, recent outcomes.

2. **Inheritance-on-open — high value, low/moderate cost.**  
   Fresh session inherits project acceptance standards, relevant project goals, recent outcomes by retrieval, open/conflicting tasks, doctrine overrides, and known risks. It should not inherit stale session goals or old task criteria.

3. **Cross-session conflict detection — high value, moderate cost.**  
   Detect same repo + same branch, overlapping files, competing migrations, duplicate task goals, deploy race, one session reverting another’s recent changes.

4. **Operator-facing conflict prompts — high value, low cost.**  
   “Session B is editing files Session A just changed; isolate, coordinate, or continue?”

5. **Worktree isolation — medium/high value, higher operational cost.**  
   Default recommendation for nontrivial concurrent tasks. Enforce for risky classes: deploys, schema migrations, shared UI flows, package upgrades, broad refactors.

6. **Automatic merge/deploy gating across sessions — high value, high cost.**  
   Later. Require no conflicting active verification/deploy before “complete” on shared branch.

The thrash incident is not solved by better session docs. It requires a project-level live concurrency model.

---

## Q4. TIMELINE

POSITION: Replace the monolithic timeline with task outcome records plus a project event log; read both by retrieval, not prompt stuffing.

Mechanism:

```ts
TaskOutcome {
  task_id
  project_id
  status: done|abandoned|superseded|failed
  summary
  files_changed
  acceptance_results
  verification_evidence
  regressions_or_followups
  operator_decisions
  completed_at
}

ProjectEvent {
  event_id
  type: task_started|task_done|deploy|regression|decision|conflict|rollback
  refs
  summary
  timestamp
  provenance
}
```

Write path:

- On task boundary: create/update TaskOutcome.
- On verification: attach evidence.
- On operator decision: record event and optionally doctrine candidate.
- On deploy/regression/conflict: emit project event automatically.

Read path:

- Active prompts retrieve outcomes/events by semantic query, files, components, branch, and recency.
- Completion gate retrieves prior related outcomes to avoid repeated failed fixes or regressions.
- Project dashboard can show chronological log.

“Resolved” should merge into TaskOutcome/EventLog as status transitions, not remain a separate section.

Expiry:

- Raw events can age out or compact after 30–90 days.
- Outcome summaries persist longer.
- High-impact incidents/regressions become project risks or knowledge entries.
- Policy-like repeated decisions go to doctrine.

Timeline becomes an indexable memory substrate, not a conversational scrapbook.

---

## Q5. MINIMAL ARTIFACT SET

POSITION: Minimal target set is eight supervisor artifacts: TaskCard, ProjectSupervision, SessionRuntime, Outcome/EventLog, Doctrine, DecisionMemory, OperatorState, ConflictRegistry.

1. **TaskCard**  
   Scope: task. Writer: supervisor/operator. Lifecycle: active → done/abandoned/superseded. Injection: active card always for answer/verify.

2. **ProjectSupervision**  
   Scope: project. Writer: supervisor; operator approves standards/goals. Lifecycle: durable with review/staleness. Injection: relevant standards/goals always or on task open.

3. **SessionRuntime**  
   Scope: session. Writer: supervisor. Contains branch, worktree, ports, commands, agent status. Lifecycle: expires with session. Injection: on-event/verify.

4. **Outcome/EventLog**  
   Scope: project/task. Writer: supervisor. Lifecycle: compact raw events; keep summaries. Injection: retrieval only.

5. **Doctrine**  
   Scope: project/user. Writer: operator-approved from supervisor candidates. Lifecycle: 21d review/staleness. Injection: always when applicable.

6. **DecisionMemory / Precedents**  
   Scope: project/user. Writer: supervisor from answered asks. Lifecycle: decay by age/usefulness. Injection: retrieval when answering similar asks.

7. **OperatorState**  
   Scope: user/session/project. Writer: classifier + explicit operator actions. Includes stance and send authority. Lifecycle: durable stance; authority until changed/session end depending setting. Injection: always for authority decisions.

8. **ConflictRegistry**  
   Scope: project. Writer: supervisor. Tracks live sessions, branches, files, deploys, locks. Lifecycle: live + short retention. Injection: on session open, task start, verify, deploy.

Cut markdown monolith entirely. Render these artifacts as views, not source of truth.

---

## Q6. SEQUENCING VERDICT

POSITION: Per-session task cards remain the right v1 nucleus, but they must be born project-aware; do not ship another isolated session system.

Build order:

1. **Structured active TaskCard + gate reads active card only.**  
   Immediate fix for stale goals, old acceptance criteria, and doc bloat. Include IDs, status, evidence, provenance.

2. **ProjectSupervision skeleton.**  
   Add project acceptance standards, current goals, active sessions, and recent outcome index. New cards link to project standards.

3. **Boundary suggestions + explicit controls.**  
   Operator can start/switch/close task. Auto-close only after verified completion plus clear new ask.

4. **Outcome/EventLog write path.**  
   On task close, write outcome summary and evidence. Retrieve related outcomes for new tasks and verification.

5. **Cross-session registry/conflict warnings.**  
   Track sessions/worktrees/branches/touched files; warn on overlap and inherited risks.

Single thing I would cut: **legacy migration classifier in v1**. Lazy migration is correct eventually, but it is not the critical path. Old docs are already untrustworthy. Start clean with project-aware task cards and only mine legacy material opportunistically when a project is touched or when retrieval finds a strong match.
---
## GLM-5.2 (raw — includes leaked reasoning preamble; final answers start at 'Q1 POSITION'; truncated at max_tokens in Q6 rationale)

The user wants me to act as one of three frontier models reviewing an architecture problem for a tool called "Supercalm" — a self-hosted supervisor of CLI coding agents. I need to answer 6 questions, each with a POSITION line (one decisive line) followed by ≤200 words of rationale.

Let me think through each question carefully based on the context provided.

The key context:
- Today: session-scoped markdown monolith docs injected fully into prompts
- Problems: stale goals, mixed rule species, lagging "Now" section, 40+ decisions bullets accumulating
- New requirements: multi-task sessions, multi-session same-project, line between knowledge and supervisor state, clean context
- Round 1 proposed: task-card architecture with active card, archived cards, doctrine migration, knowledge layer reading

Let me think through each question:

**Q1. PROJECT SUPERVISION LAYER**
Should supervision state become project-scoped? Yes. The session-scoped approach is the root cause of the thrash incident and the staleness problem. The project layer should hold: standing acceptance standards, project goals (mutable but maintained), recent outcomes/history, cross-task constraints. Task cards hold: task-specific goal, acceptance criteria, verification notes, task-scoped constraints.

Data shape:
```
ProjectSupervisionState {
  project_id: str
  goals: [{ text, updated_at, superseded_by }]
  acceptance_standards: [{ id, text, scope, source_ref }]  // standing, reusable
  constraints: [{ id, text, scope, origin }]  // project-level rules
  recent_outcomes: [{ task_id, summary, outcome, timestamp, evidence_refs }]
  open_tasks: [{ task_id, session_id, status, summary }]
  sessions: [{ session_id, tmux_pane, task_id, branch, last_active }]
}
```

TaskCard:
```
TaskCard {
  task_id, project_id, session_id
  goal: str
  acceptance_criteria: [{ id, text, status: pending|met|failed, evidence: ref }]
  verification_notes: str
  constraints: [constraint_id]  // refs to project constraints + local ones
  status: active|completed|abandoned
  outcome: str  // on completion
  created_at, completed_at
}
```

**Q2. THE LINE**
Knowledge layer (CONTEXT.md/wiki): builder-facing, describes the codebase, how to run things, architecture, file structure, conventions. It's about "what is true about this project as a codebase."

Supervisor state: about "what we're doing, what we've decided, what we've verified, what the rules are."

Decision rule: "It belongs to knowledge iff it's a stable fact about the codebase/project that any agent or human would need regardless of the current task. It belongs to supervisor state iff it's about a decision, constraint, verification, or outcome tied to supervision activity."

Knowledge owns:
- CONTEXT.md (project overview, how to run, architecture)
- Wiki entries (codebase facts, patterns, gotchas)
- Build/test commands
- File structure notes

Supervisor owns:
- Task cards (active + archived)
- Operator doctrine (learned rules)
- Project supervision state (goals, standing standards, outcomes)
- Session runtime facts
- Decision memory / precedents

Writers: Knowledge is agent-writable (builder can update it). Supervisor state is written by the supervisor only. Supervisor reads knowledge via retrieval (query-relevant sections), NOT full injection — this keeps context clean.

**Q3. MULTI-SESSION SAME-PROJECT**
The thrash incident shows this is real. Options:
1. Shared project state — essential, already argued in Q1
2. Cross-session conflict detection (same files/branch) — high value, moderate cost
3. Enforced worktree isolation — high value but high friction
4. Inheritance-on-open — essential for fresh sessions

Ranking by value/cost:
1. Shared project state (highest value, lowest cost — it's the foundation)
2. Inheritance-on-open (high value, low cost — pull standards, goals, open tasks)
3. Cross-session conflict detection (high value, moderate cost — file overlap detection, branch collision)
4. Worktree isolation (high value but high friction — should be advisory/enforced only when conflict detected, not default)

Actually, worktree isolation might be the cheapest effective solution — if each session gets its own branch/worktree, conflicts are structural. But the operator's culture seems to be working on shared branches sometimes. Let me be opinionated: enforced worktree isolation is the right default but with an escape hatch for truly isolated tasks.

**Q4. TIMELINE**
The operator's purpose: know what was done, don't repeat, supervise with historical context.

Right mechanism: per-task outcome records (structured) + a project-level event log (append-only, retrieval-only). NOT a narrative timeline section.

Per-task outcome records are the primary artifact — when a task card is archived, it gets an outcome summary, evidence refs, and timestamp. These are queryable.

The project-level event log is a thin append-only stream: {timestamp, session_id, event_type, task_id, summary}. It's for "what happened" not "what to do."

"Resolved" items merge into outcome records — they're just completed tasks with outcomes.

Write path: supervisor writes outcome records on task completion. Event log is auto-appended on key events (task start, completion, escalation, doctrine change).

Read path: retrieval-only. Query by task_id, topic, recency. NOT injected wholesale.

Expiry: outcome records never expire (they're history). Event log entries are retained indefinitely but only retrieved when relevant. Cap the injected set to 0 — always retrieval.

**Q5. MINIMAL ARTIFACT SET**
Complete minimal set:

1. **Active Task Card** — scope: task; writer: supervisor (+ operator edits); lifecycle: created on task start, archived on completion/abandonment; injection: ALWAYS (active card only)

2. **Archived Task Cards (with outcomes)** — scope: project; writer: supervisor; lifecycle: archived, permanent; injection: RETRIEVAL only (by topic/similarity)

3. **Operator Doctrine** — scope: project + user(global); writer: operator (via triage); lifecycle: 21d staleness sweep; injection: ALWAYS (active rules for current project scope), RETRIEVAL for global

4. **Project Supervision State** (goals, standing acceptance standards, open tasks registry, session registry) — scope: project; writer: supervisor; lifecycle: goals mutable, standards semi-permanent; injection: ALWAYS (goals + standards), RETRIEVAL for open tasks

5. **Session Runtime Facts** — scope: session; writer: supervisor (auto-detected); lifecycle: session-scoped, dies with session; injection: ALWAYS (for the session's own facts)

6. **Decision Memory / Precedents** — scope: project + user; writer: supervisor; lifecycle: permanent with recency decay; injection: RETRIEVAL only (BM25+recency)

7. **Project Event Log** — scope: project; writer: supervisor (auto); lifecycle: append-only; injection: RETRIEVAL only

Actually, let me reconsider. The operator wants "clean and super-related context." So I should be minimal. Let me think about what's truly minimal:

1. Active Task Card (task scope, always injected)
2. Project Supervision State (project scope, always injected for goals+standards)
3. Operator Doctrine (project+user, always injected active project rules)
4. Session Runtime Facts (session, always injected)
5. Archived Outcomes + Precedents (project, retrieval only)
6. Event Log (project, retrieval only)

That's 6. The knowledge layer (CONTEXT.md/wiki) is separate and also retrieval-only for supervisor.

**Q6. SEQUENCING VERDICT**
The question is: should per-session task cards still be the v1, or must the project layer land first?

Given the thrash incident and the operator's explicit requirements about multi-session and inheritance, the project layer MUST land first or at least concurrently. You can't have task cards without knowing which project they belong to and what standing standards apply.

My build order:
1. Project layer skeleton (project_id, goals, standing acceptance standards, session registry) — this is the foundation
2. Active task card (structured, one active per session, gate reads card only)
3. Supervisor reads project knowledge via retrieval (not full injection)
4. Migration classifier for legacy docs → project state / card / doctrine / discard
5. Cross-session awareness (open tasks registry, conflict detection)

Cut: the event log / timeline. It's the lowest-value artifact right now and the operator explicitly questioned it. Outcome records on archived cards give most of the value. Add event log later if needed.

Actually, let me reconsider the cut. The operator said timeline has value for "knowing history." But the structured outcome records + precedents cover this. The event log is redundant with outcome records. So cutting the event log/timeline is the right call.

Wait, but I should also consider: should I cut migration? Migration of legacy docs is important but could be deferred. No, the operator has ~40 decisions bullets and 25+ timeline entries that are actively causing problems (stale goal sent to builder 6×/hour). Migration is needed.

Let me reconsider more carefully. The round-1 v1 cut included: structured active task card + suggested boundaries + gate-reads-card-only + supervisor reads project knowledge + migration classifier + promotion suggestions.

The new dimension is project-level. So my revised build order:

1. **Project supervision state** (project_id, goals, standing standards, session registry) — foundation, must be first
2. **Active task card** (structured, per-session, one active, gate reads card only) — depends on project state for standards
3. **Supervisor reads project knowledge via retrieval** — clean context
4. **Migration classifier** — deal with legacy monolith docs
5. **Cross-session awareness** — open tasks registry + file conflict detection

Cut: **event log / timeline**. Outcome records on archived cards + decision memory/precedents provide the historical value. The narrative timeline is the artifact the operator most questioned, and it's the most prone to staleness.

Now let me write this up concisely for each question. I need to be opinionated, concrete, with data shapes, and ≤200 words per rationale.

Let me also think about where I might disagree with GPT-5.5's round-1 review:

GPT-5.5 said "promotion ≥2 projects too naive" — I think they're right but I'd push further: promotion should require operator approval always, and the threshold should be category-dependent.

GPT-5.5 said "session runtime facts" is a missing 6th home — I agree, but I'd fold it into the session-level view of project state rather than a separate artifact. Actually, it's important enough to be its own thing — branch, ports, test commands are session-specific.

GPT-5.5 said task boundary detection should be suggestions + explicit controls — I agree but would add: the DEFAULT should be explicit operator confirmation, not auto-transition. This is safer for a supervisor.

GPT-5.5 said "card is a contract, not truth" — I'd go further: the card should be versioned, and the gate should check against the version that was active when the task started, not whatever it evolved to. Actually no, the card should evolve with the task — acceptance criteria can be refined. The gate checks the current card.

Let me also think about what's unique in my perspective vs what GPT-5.5 already covered. I should bring new angles:

- I'm emphasizing the project layer MORE than GPT-5.5 did (they focused on task cards)
- I'm drawing a sharper line on knowledge vs supervisor state
- I'm being more concrete about cross-session conflict detection
- I'm cutting the timeline/event log entirely in favor of outcome records

Let me draft each answer now.

---

Q1 POSITION: Project-scoped supervision state with per-task views; project layer holds goals + standing acceptance standards + outcome history + open-task registry; task cards hold goal + acceptance criteria + verification notes scoped to one task.

Rationale:
The session-scoped doc is the root cause of every reported failure: stale goals (session died, goal lived on), mixed rule species (nowhere to route them), "Now" drift (no boundary detection). Move to:

```
ProjectState {
  project_id: str
  goals: [{ text, updated_at, status: active|superseded }]
  acceptance_standards: [{ id, text, origin_ref }]  # standing, reusable across tasks
  outcomes: [{ task_id, summary, result, evidence_refs, timestamp }]  # retrieval-only
  open_tasks: [{ task_id, session_id, status, branch, files_touched[] }]
  sessions: [{ session_id, pane, task_id, last_active_at }]
}

TaskCard {
  task_id, project_id, session_id
  goal: str
  acceptance_criteria: [{ id, text, status: pending|met|failed, evidence_ref }]
  verification_notes: str
  constraints: [constraint_ref]  # refs project standards + local overrides
  status: active|completed|abandoned
  outcome: str  # written on archive
}
```

The gate grills against the ACTIVE card's criteria. Standing standards from project state are inherited but not duplicated into every card. This is what "clean and super-related context" means: the card is small because the project carries the weight.

---

Q2 POSITION: Knowledge = stable codebase facts any agent needs regardless of task; supervisor state = decisions, constraints, verifications, outcomes tied to supervision activity. Decision rule: "It belongs to knowledge iff removing the current task still makes it true and useful."

Rationale:
Knowledge owns: CONTEXT.md (how to build, architecture, file layout), wiki entries (patterns, gotchas, API notes), build/test commands, dependency notes. Agent-writable, builder-updated, supervisor-read-via-RETRIEVAL (semantic search, not full injection — full injection is what poisoned today's prompts).

Supervisor owns: task cards (active+archived), operator doctrine (learned rules), project supervision state (goals, standing standards, outcomes), session runtime facts (branch, ports, test cmd), decision memory/precedents. Supervisor-written, operator-approved on doctrine only.

The line test: "Removing the current task, is this still true and useful?" If yes → knowledge. "Is this about a decision, verification, or constraint on a specific task or supervision policy?" → supervisor state.

Critical: the supervisor must NOT write to knowledge. The builder writes knowledge; the supervisor writes supervision state. If the supervisor discovers a codebase fact (e.g., "tests fail on Node 22"), it routes that to the builder via a suggestion, not a direct knowledge write. This preserves the knowledge layer as builder-owned territory and prevents the supervisor from becoming a shadow knowledge maintainer.

---

Q3 POSITION: Shared project state is the foundation; inheritance-on-open pulls standards+goals+open tasks; cross-session file/branch conflict detection is the safety net; enforced worktree isolation is the right default with an escape hatch for isolated tasks. Rank: shared state > inheritance > conflict detection > worktree isolation.

Rationale:
1. **Shared project state** (highest value, lowest cost): already specified in Q1 — all sessions read/write the same ProjectState. This alone would have prevented the thrash incident (3 sessions, 10 deploys, repeated regressions) because open_tasks would show overlapping file sets.

2. **Inheritance-on-open** (high value, low cost): new session opens → pull project goals, standing acceptance standards, recent outcomes (top 3 by recency/relevance), open task list. NOT the full history — just enough to not repeat work. This is the "smart inherit" the operator asked for.

3. **Cross-session conflict detection** (high value, moderate cost): when a session touches files in open_tasks[].files_touched of another live session → advisory warning to operator. Same branch → escalate to warning. Different branches/worktrees → silent.

4. **Worktree isolation** (high value but friction): default to separate branches per session; escape hatch when the operator explicitly marks a task as "isolated" or "read-only." Don't force worktrees — the operator's workflow sometimes needs shared-branch quick fixes.

The thrash incident would have been caught at step 3.

---

Q4 POSITION: Kill the narrative timeline; replace with structured per-task outcome records (written on archive, retrieval-only) + a thin project event log (append-only, retrieval-only, never injected). "Resolved" items are just completed task outcomes — merge them.

Rationale:
The timeline failed because it was a free-text narrative injected wholesale — guaranteed to lag and bloat. The operator's actual need is three things: (1) don't repeat work, (2) know history for context, (3) supervise new tasks better. These map to:

**Outcome records** (on archived task card): `{ task_id, summary, result: completed|abandoned|failed, evidence_refs[], key_decisions[], timestamp }`. Written by supervisor on archive. Read via retrieval (BM25 + project boost, same as decision memory). Never expires — this is history.

**Project event log** (thin, append-only): `{ timestamp, session_id, event_type: task_started|completed|abandoned|escalated|doctrine_changed, task_id, one_line_summary }`. Auto-written by supervisor on events. Read via retrieval when the supervisor needs "what happened recently in this project." Never injected wholesale. Retained indefinitely but capped to last 100 entries per project (older ones are summary-compressed into outcome records).

**"Resolved" merges into outcomes** — a resolved item is a completed task; its outcome record captures the resolution. No separate "Resolved" section.

Write path: supervisor-only, event-driven. Read path: retrieval-only, query by task_id/topic/recency. Expiry: outcomes never expire; event log entries compress after 100.

---

Q5 POSITION: Six artifacts. (1) Active Task Card [task, always injected], (2) Project Supervision State [project, always injected for goals+standards], (3) Operator Doctrine [project+user, always injected active project rules], (4) Session Runtime Facts [session, always injected], (5) Archived Outcomes [project, retrieval-only], (6) Decision Memory/Precedents [project+user, retrieval-only]. Plus the project event log as a sub-component of #2.

Rationale:
Complete minimal set:

| # | Artifact | Scope | Writer | Lifecycle | Injection |
|---|---------|-------|--------|-----------|-----------|
| 1 | Active Task Card | task | supervisor + operator | created on start, archived on completion | ALWAYS (active only) |
| 2 | Project State (goals, standing standards, open tasks, session registry, event log) | project | supervisor | goals mutable, standards semi-permanent, event log append-only | ALWAYS (goals+standards); retrieval for event log |
| 3 | Operator Doctrine | project + user(global) | operator via triage | 21d staleness sweep | ALWAYS (active project-scope rules); retrieval for global |
| 4 | Session Runtime Facts | session | supervisor (auto-detected: branch, ports, test cmd, known-good state) | lives+dies with session | ALWAYS |
| 5 | Archived Task Outcomes | project | supervisor on archive | permanent | RETRIEVAL only |
| 6 | Decision Memory/Precedents | project + user | supervisor | permanent, recency decay in ranking | RETRIEVAL only |

Knowledge layer (CONTEXT.md/wiki) is separate: builder-written, supervisor reads via retrieval.

"Clean and super-related context" = always-injected set is small (4 items, task-scoped), retrieval set is deep (3 items, history+precedents). The active prompt never exceeds: 1 card + project goals/standards + active doctrine + session facts. Everything else is queried when needed.

---

Q6 POSITION: Project layer must land first — task cards without a project parent are orphaned and recreate the session-scoped problem. Build order: (1) project state skeleton, (2) active task card on top of project state, (3) supervisor reads knowledge via retrieval, (4) migration classifier, (5) cross-session awareness. Cut: the event log.

Rationale:
Round-1's v1 (task cards first) was right for a single-session world. The operator's new requirements (multi-session, inheritance, "clean and super-related context") make the project layer the load-bearing wall. If you build task cards first, you'll bolt project state onto them later and get the same coupling problems the monolith has today.

**Build order:**
1. **Project state skeleton** — project_id, goals (mutable), standing acceptance standards, session registry. This is the parent everything hangs from. Even if it starts with one session per project, the shape is right.
2. **Active task card** — structured fields, one active per session, gate reads card+project standards only. Boundary suggestions, explicit