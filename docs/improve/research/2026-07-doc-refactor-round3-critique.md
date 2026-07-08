# Round 3: outward research + author-design critique (2026-07-07)

## Search digests (tool 1: gpt-5.5 /responses web_search via fleet; tool 2: Claude WebSearch — fleet's kimi/glm/qwen/gemini search routes are dead: gemini 403, kimi builtin not executed by aggregator, qwen/glm flags stripped)

### Memory architectures (gpt-5.5 search)
## State of the art, mid-2026: agent memory is becoming scoped, temporal, inspectable context

The winning pattern is no longer “dump chat into a vector DB.” Production systems now split memory by **scope** — thread/session, project/repo, user, team/org — and by **type**: **episodic** logs of what happened, **semantic** facts/preferences/decisions, and increasingly **procedural** rules/skills learned from outcomes. The hard problems are the “manage” layer: promotion from raw episode → durable fact/rule, contradiction handling, provenance, permissioning, decay, and preventing poisoned/stale memories from steering future actions.

### Letta / MemGPT
- **Mechanism:** OS-style virtual context: small editable **core memory blocks** always in-context; larger searchable **archival/recall memory** paged in via tools; blocks are persisted and can be shared across agents. Sources: [MemGPT paper](https://arxiv.org/abs/2310.08560), [Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks), [context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy).
- **Steal:** For agent supervision, keep a tiny always-loaded “verification contract” block: acceptance criteria, repo invariants, forbidden shortcuts, test policy; page detailed prior failures only when relevant.

### mem0
- **Mechanism:** Memory-as-a-service extracting salient facts from conversations into persistent vector/graph stores, with LLM-based consolidation and retrieval; its 2025 paper reports higher accuracy, lower latency, and token savings versus baseline memory systems. Sources: [docs](https://docs.mem0.ai/features/contextual-add), [paper](https://arxiv.org/abs/2504.19413), [site](https://mem0.ai/about-us).
- **Steal:** Use mem0-style “memory write after every run” to persist reviewer findings: “agent X often forgets migrations,” “this repo requires snapshot updates,” “flaky test Y is ignored unless touched.”

### Zep / Graphiti
- **Mechanism:** Temporal knowledge graph: conversations and business data become entities/edges with validity timestamps; old facts are invalidated rather than overwritten; retrieval combines vector, keyword, and graph traversal. Sources: [Graphiti](https://www.getzep.com/platform/graphiti/), [docs](https://help.getzep.com/graphiti/getting-started/welcome), [Zep paper](https://arxiv.org/abs/2501.13956).
- **Steal:** Model acceptance criteria, commits, tests, bugs, PR comments, and “fixed-by” relations as a temporal graph so the supervisor can ask: “Which criterion was current when this code was generated?”

### LangMem / LangGraph
- **Mechanism:** Framework-native memory: LangGraph separates thread-scoped short-term checkpoints from long-term JSON stores namespaced by user/app/org; LangMem adds semantic, episodic, procedural memory managers, hot-path tools, background extraction, and consolidation. Sources: [LangGraph memory](https://langchain-ai.github.io/langgraph/agents/memory/), [LangChain memory overview](https://docs.langchain.com/oss/python/concepts/memory), [LangMem intro](https://langchain-ai.github.io/langmem/).
- **Steal:** Implement supervision as a LangGraph node with its own long-term namespace: `{org}/{repo}/{branch}/{agent}` plus procedural memories like “before approving, run contract tests and inspect changed fixtures.”

### Claude Code memory
- **Mechanism:** File/workspace memory: `CLAUDE.md` and `.claude/rules/` provide hierarchical project instructions; auto-memory writes local markdown notes under project memory, with `MEMORY.md` bootstrapping the first 200 lines or 25KB and topic files read on demand. Source: [Claude Code memory docs](https://code.claude.com/docs/en/memory).
- **Steal:** Prefer transparent, reviewable markdown memories for supervision: a checked-in `SUPERVISOR.md` containing acceptance heuristics, with append-only “lessons learned” files tied to failing PRs.

### Anthropic managed-agent memory
- **Mechanism:** Built-in shared memory for managed agents with concurrent access, provenance, and audit logs showing which agent/session changed memory. Source: [Anthropic blog, Apr. 23 2026](https://claude.com/blog/claude-managed-agents-memory).
- **Steal:** Every memory mutation in a supervision product should be auditable: who wrote it, from which run, based on which evidence, and whether it affected a pass/fail decision.

### Newer 2026 entrants: Cognee, Graphlit, Hypermemory, Engram, Walrus Memory, Midbrain
- **Mechanism:** The category is fragmenting into graph-native memory, universal cross-tool memory, enterprise context platforms, verifiable/portable memory, and local-first temporal stores. See [Graphlit 2026 survey](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks), [Cognee](https://www.cognee.ai/), [Hypermemory](https://hypermemory.io/), [Engram](https://engram.so/), [Walrus Memory](https://www.prnewswire.com/news-releases/walrus-launches-walrus-memory-as-portable-memory-layer-for-ai-agents-302790486.html), [Midbrain](https://www.midbrain.ai/).
- **Steal:** Treat memory as governed infrastructure, not a chatbot feature: portable across coding agents, permissioned by repo/org, source-grounded, and cryptographically or auditably verifiable where possible.

## Notable 2025–2026 papers

### A-MEM — Agentic Memory for LLM Agents, 2025
- **Mechanism:** Zettelkasten-style memory: LLMs create notes, links, dynamic indices, and evolve memory organization rather than using fixed slots. Source: [arXiv](https://arxiv.org/abs/2502.12110).
- **Steal:** Let the supervisor link recurring failure patterns across PRs: “auth regressions,” “missing migration,” “incorrect mock,” producing reusable review checklists.

### Multi-Layered Memory Architectures, 2026
- **Mechanism:** Decomposes history into working, episodic, and semantic layers with adaptive retrieval gating and retention regularization to reduce drift and false memory. Source: [arXiv](https://arxiv.org/abs/2603.29194).
- **Steal:** Gate retrieval: don’t stuff all prior repo lore into reviews; retrieve only memories relevant to changed files, criteria, and test surface.

### Beyond Similarity / MemGate, 2026
- **Mechanism:** Treats memory search as a trust boundary; long-term memory can become a durable prompt-injection channel, so a gate filters retrieved memories before the LLM sees them. Source: [arXiv](https://arxiv.org/abs/2606.06054).
- **Steal:** Critical for supervision: retrieved memories should be evidence-ranked, provenance-checked, and never allowed to override explicit acceptance criteria or current repository state.
### Multi-agent same-repo coordination (gpt-5.5 search)
**Mid-2026 read:** the winning coordination stack is boring software-engineering infrastructure, not exotic swarm chat: **issue/task as source-of-truth → agent-owned branch/worktree/VM → PR/diff artifact → CI/review gate → human/merge-queue authority**. Pure “agents talk to each other” is secondary; the durable primitives are Git, tickets, locks, tests, and dashboards.

### Products / systems

- **Cursor background/cloud agents + Agents Window**  
  **Mechanism:** Cursor runs many agents across local, worktree, cloud, and SSH environments; `/worktree` creates isolated Git worktrees, `/best-of-n` runs alternatives in separate worktrees, `/multitask` decomposes into async subagents, and cloud agents run in isolated VMs/branches. Cursor also supports PR “babysit” cloud subagents and mobile review/merge flows. Sources: Cursor 3.0/3.2 changelogs and latest cloud-agent notes.   
  **Steal for supervision:** Treat every agent run as a **named, inspectable workstream** with branch/worktree, plan, logs, diff, artifacts, and one-click promotion to human foreground.

- **Devin sessions / Devin Review**  
  **Mechanism:** Devin’s unit is a **session** that can be listed via API and associated with PRs; recent releases emphasize session categorization, permalinks, multi-PR isolation, merge-conflict notifications, and Devin Review auto-merge after approval/checks. Devin Review CLI uses cached isolated Git worktrees for PR diff review.   
  **Steal for supervision:** Make “session” a first-class audit object: owner, task, ACU/cost, linked PRs, status, confidence, comments, merge blockers.

- **OpenHands / Agent Canvas / CAID**  
  **Mechanism:** OpenHands Agent Canvas runs multiple agents simultaneously, each in its own Git worktree; the CAID research system maps human-team primitives to agents: manager builds dependency graph, assigns structured JSON subtasks, engineer agents work in isolated worktrees, then Git merge + tests integrate.   
  **Steal for supervision:** Require a **manager-authored dependency DAG** before parallelism; only independent nodes get agents.

- **Claude Code: worktrees, subagents, agent teams**  
  **Mechanism:** Claude Code has explicit worktree support for parallel sessions; subagents can declare `isolation: worktree`; experimental agent teams add shared tasks, inter-agent messaging, a lead agent, and independently addressable teammates.   
  **Steal for supervision:** Separate **helper subagents** from **teammates**: helpers report upward; teammates need task registry, messaging, and visible ownership.

- **GitHub Copilot coding agent / Agent HQ / partner agents**  
  **Mechanism:** GitHub turns issues/PRs into the coordination layer: assign Copilot/Claude/Codex to issues, starting branch/custom agent/model are selected, agents submit draft PRs, can continue on PR feedback, fix failing Actions, resolve merge conflicts, and “agent merge” waits until GitHub permits merge.   
  **Steal for supervision:** Put coordination where developers already arbitrate: **issue assignee + PR branch + branch protection + CI + review comments**.

- **OpenAI Codex as GitHub agent**  
  **Mechanism:** Via GitHub Agent HQ public preview, Codex can be assigned from issues, PRs, Agents tab, mobile, or VS Code and returns draft PRs alongside Copilot/Claude for review.   
  **Steal for supervision:** Normalize **multi-agent bakeoffs**: assign the same issue to multiple agents, compare draft PRs, merge one.

- **Amp by Sourcegraph**  
  **Mechanism:** Amp emphasizes team collaboration via shared threads/workflows, subagents, and team-visible usage rather than native Git locking; public positioning highlights subagents and shared-by-default team collaboration.   
  **Steal for supervision:** Preserve **threads as reusable runbooks**: good prompts, context, and agent traces become team assets.

- **Factory.ai Droids**  
  **Mechanism:** Factory Droids plan, code, test, review, and create PRs across IDE/browser/Slack/Jira; Factory says Missions coordinate long-horizon, multi-step, multi-agent workflows, with real-time org context, memory, guardrails, local/cloud execution, and model routing.   
  **Steal for supervision:** Add **autonomy levels and permission envelopes** per task: read-only, propose-diff, run-tests, push-branch, request-merge.

- **Newer orchestration entrants: cogyard, Factory Factory, Factory Floor, Daintree, Clash**  
  **Mechanism:** These are converging on thin orchestration over existing agents: markdown task files with atomic claims, per-task worktrees, port allocation, Kanban/portal views, ACP-compatible launchers, deterministic ports, and pre-merge conflict simulation. cogyard is explicit: `_tasks/*.md`, YAML frontmatter, atomic claim, worktree, port pair. Factory Factory starts GitHub issues into isolated ACP worktrees. Factory Floor gives each workstream branch/worktree/terminal/browser/Claude session. Clash uses `git merge-tree` to simulate conflicts before edits/merge.   
  **Steal for supervision:** Keep the control plane **agent-agnostic and repo-native**: markdown/JSON tasks, atomic leases, deterministic env/ports, and preflight merge simulation.

### Papers / benchmarks signal

- **AgenticFlict** found **29K+ conflicted PRs** among processed AI-agent PRs, a **27.67% conflict rate**, proving conflict management is not theoretical.   
- **AIDev / PR acceptance work** shows no single agent wins all task types; Claude Code leads docs/features, Cursor fixes, Codex broad categories.   
- **PR-lifecycle governance research** says agents may initiate PR work, but **merge governance remains predominantly human**.   
- **Open-source census** says PR-deployed cloud agents and commit-deployed in-editor agents show up in different work patterns, so supervision needs both PR and commit telemetry. 

**What’s winning:** Git worktree/branch isolation, issue/PR assignment, atomic task claims, shared task registries, visible sessions, CI/test gates, merge-conflict preflight, agent PR queues, and human-controlled merge authority. The losing primitive is unstructured agent chat without locks, ownership, or mergeable artifacts.
### Context engineering + papers (Claude WebSearch): key items
- PROJECTMEM 2606.12329: append-only event log + PRE-ACTION GATE warning before repeating a failed fix
- ETH study: LLM-generated context files HURT in 5/8 settings; stale structural refs actively mislead
- Anthropic long-running harness: progress files + git checkpoints; planning-with-files: plan/findings/progress + completion gate + multi-agent disk state
- Self-Compacting agents 2606.23525; EDV 2606.24428 default-reject memory writes; MemGate 2606.06054 retrieval=trust boundary; Zep temporal validity; RecMem consolidation; FSFM forgetting; Collaborative Memory private/shared tiers w/ provenance; AgenticFlict 27.67% agent-PR conflict rate

---
## The author's PSS design (as sent for critique)
# 4. THE AUTHOR'S DESIGN (attack this) — "Project Supervision Store" (PSS)

**A. Storage & authority: DB-authoritative, NOT repo-native task files.** tasks/events/standards/runtime live in Supercalm's sqlite (supervisor+operator writable only); the repo gets read-only PROJECTIONS (GOAL.md stays). Reason: our threat model is a skeptical supervisor — repo-native task files (cogyard/planning-with-files style) are builder-editable, i.e. goalpost-moving; MemGate's trust-boundary argument applies to the contract itself. The industry's repo-native convergence is for BUILDER coordination, not for the JUDGE's contract.
**B. Schema:** `tasks(id, project_id, title, goal, status proposed|active|paused|verify_pending|done|abandoned|superseded, claimed_by_session, claim_heartbeat_at, criteria_json[{id,text,status,evidence_ref,valid_from,superseded_at}], constraints_json, verify_facts_json, created_at, closed_at, outcome, close_summary)` · `task_events(id, task_id, project_id, ts, actor operator|supervisor|maintainer|migration, type opened|amended|claimed|released|blocked|verify_pass|verify_fail|closed|incident|deploy|rollback|legacy_doc, summary ≤2 sentences, refs{commit,review_id,files[]})` · `project_standards(id, project_id, text, source_ref, status)` · `session_runtime(session_id, active_task_id, branch, worktree, ports, test_cmd, files_touched, updated_at)`. Timeline = a VIEW over task_events; outcomes = closed events; "Resolved" = event types. Zep-steal: criteria carry validity intervals.
**C. Boundary control: suggestions + explicit, via the EXISTING stance classifier.** It already LLM-classifies every operator input (durable stance); it gains a 4th output: task_boundary hint (new|amend|close|none) → panel suggestion chip + `/task` composer command. Auto-transition ONLY on gate-verified complete + next distinct operator ask. Reason: zero new model calls; the classifier already sees exactly the right signal.
**D. Injection budget (hard):** active card ≤1.2k tokens (structured fields, terse — ETH: generated verbosity actively hurts) + session_runtime ~150t ALWAYS; standards only on verify/card-draft; doctrine unchanged; events/precedents/wiki RETRIEVAL-only, each retrieved item carries a provenance line and CANNOT override operator words or the card (MemGate).
**E. Pre-action gate (PROJECTMEM steal):** before answer/unstick proposes an approach, retrieve verify_fail/incident events overlapping the same files; inject "previously failed: X (event ref)". Kills repeat-failed-fix loops (we had exactly this incident class).
**F. Multi-session:** task CLAIMS (one session per task, heartbeat TTL ~10min); conflict detection = files_touched overlap across live sessions (git diffs already collected) + `git merge-tree` preflight before gate sign-off on a shared branch (Clash-steal); on conflict → warn both sessions + operator, downgrade autopilot→copilot on the conflicting sessions (authority envelope). Inheritance-on-open: standards + goals + open/paused task list offered — nothing else. Worktree isolation stays ADVISORY (suggested after repeated conflicts), never enforced.
**G. Knowledge line:** descriptive→wiki (builder-writable); normative→PSS (supervisor/operator only). Supervisor gains RETRIEVAL-ONLY wiki access (reuse existing wiki_search internals). `verify_facts` (test cmd, build check) pinned ONTO the card at task-open with provenance — copied, not live-read, so a builder editing the wiki mid-task can't move goalposts. A knowledge fact that starts gating gets PROMOTED into a project_standard with source_ref.
**H. Migration: lazy, on-touch.** When a session is next engaged: classifier buckets its legacy doc lines (doctrine-candidate ≤3/session → grouped per-project triage bundle; project-fact → wiki suggestion; fossil/anti-staleness → discard; everything → one `legacy_doc` event archiving the doc verbatim). No eager sweep. Reason: old docs are already untrustworthy (round-2 GPT point) + triage queue pressure is a live operator complaint.
**I. Explicit cuts:** no cross-project promotion yet (no observed recurrence); no standalone event-log artifact (events table IS the log); paused-task UI deferred (schema supports it); EDV-style multi-verifier memory writes deferred (doctrine approval gate already default-rejects; outcome events are supervisor-written evidence, not learned claims).
**J. Untouched:** doctrine, engagement, stance, stage, send_policy, decide.js, reviews. The doc-maintainer becomes the card-maintainer. decide.js gains task_state as an input in phase 2, not v1.
**Sequencing:** (1) schema + session_runtime, data-only → (2) structured card + gate/answer rewire + panel card UI → (3) claims + conflict warnings → (4) events write path + pre-action gate + retrieval → (5) lazy migration. Each phase independently shippable behind a flag.


---
## Critiques

### Claude Fable 5
**Q1 — POSITION: The author wins on write-authority but conflates authority with storage; a hash-pinned projection hybrid beats both, and pure-DB has real costs he ignores.**

The trust argument is sound — but "repo-native = builder-editable" is false as stated. Hybrid: DB stays authoritative; project the *full task card* (not just GOAL.md) into the repo as a supervisor-committed file, hash-pinned in the DB. Builder edits become a *tamper signal* — free evidence for the skeptical supervisor, not goalpost-moving. The author's design leaves builders partially blind: they never see criteria unless prose-relayed in prompts, which recreates injection bloat. Unaddressed costs of pure-DB: contract has no git history (git-blame on criteria changes is exactly the audit story he wants); repo clones/second machines lose the contract entirely; projections drift with no reconciliation mechanism specified. The industry converged on repo files partly for *durability and portability*, not just coordination — he rebutted only the coordination half.

**Q2 — POSITION: criteria-as-JSON-blob defeats the Zep steal, and the 1.2k cap misreads what ETH actually found.**

Embedding criteria with validity intervals inside `criteria_json` makes the killer temporal query — "which criteria were current at commit X?" — a parse-every-row operation. Criteria need a first-class table (id, task_id, valid_from, superseded_at, evidence_ref) or the intervals are decoration. Also missing: task dependencies (OpenHands' DAG-before-parallelism — claims without ordering invite deadlock), `session_id` on task_events actor, standards↔verify linkage (which standards were checked at gate time?), and any refresh path for pinned `verify_facts` when the test command legitimately changes mid-task. The cap: first breakage is criteria truncation → gate grills a partial contract → false completes, the worst possible failure. And ETH's finding was about *LLM-generated* context hurting — the card-maintainer's terse summaries are still LLM-generated; the cap limits volume, not the misleading-staleness failure mode. Provenance-marking maintainer text matters more than 1.2k.

**Q3 — POSITION: Piggybacking risks regressing the classifier that two evals depend on, and "next distinct operator ask" is an undefined predicate that will sever evidence chains.**

The stance classifier's outputs back `live_context` (−23pts wrong escalations) and durable stance — adding a fourth head changes the prompt/objective with zero eval coverage for either task. Stance is sticky/durable; boundaries are per-utterance events; these have opposite temporal semantics in one classifier. Concrete failures: casual mentions ("also, logout's broken") spawn new-task chips → chip fatigue → operator ignores → drift back to monolith behavior; a follow-up bug report after gate-pass reads as "distinct ask," auto-closing the task and orphaning the regression's evidence trail. Worst: a single missed boundary has *no repair path* — the design lacks operator split/merge/retro-close operations, so one classifier miss permanently pollutes a card. Builder-announced subtask transitions (a strong signal the supervisor already sees in tmux) are ignored entirely. Dedicated classification is cheap; classifier regression is not.

**Q4 — POSITION: The pre-action gate doesn't need the events table — supervisor_reviews already contains verify-fails, so it could ship in v1; authority downgrade is premature and contradicts "decide.js untouched."**

E is scheduled behind phase 4 (events write path), but the incident class it kills is already recorded: `supervisor_reviews` has verify/unstick entries with triggers and verdicts. Retrieving prior fails from reviews by file overlap ships *now*, no schema. Claims: the 10-min heartbeat TTL interacts badly with `stuck_timeout_sec=300` — a wedged-but-recoverable session loses its claim mid-recovery, a second session claims, both write; that's the thrash incident *reintroduced by the fix*. Autopilot→copilot downgrade is a send-authority change, i.e. a decide.js policy input — but J says decide.js gains task_state in phase 2, not v1. Contradiction. Cheapest thing that prevents 3-agent thrash: files_touched overlap → warn all sessions + operator. No claims, no merge-tree, no downgrade. Merge-tree preflight is cheap but only fires at gate time — too late for thrash prevention.

**Q5 — POSITION: The fingerprint family and goal_doubt are silently broken by task-scoping, and live_context's supersession rule now contradicts the card's contract authority.**

Specifics: `workFp/challengedWorkFp/tierVerifiedFp/gateDraftFp/gateEscalatedFp` fingerprint doc-derived work-state — on task switch they either re-arm (gate re-grill spam, the exact runaway they were built to stop) or persist stale (missed gates on paused-task resume). They must become (session, task_id)-scoped; the design never says so. `goalConflictKey`/goal_doubt: goal now exists on N open tasks plus a GOAL.md projection — which does goal_doubt compare against, and what does GOAL.md project when two sessions hold different active tasks? `live_context` says operator words supersede doc facts — but the card is now the authoritative contract; supersession must become a boundary-flow *amendment* (event + criteria supersede) or behavior and audit record diverge. decide.js `snapshot_hash` — hash of what, post-doc? Replay continuity breaks at migration. Engagement governor is session-scoped; a stale session's unreleased claim blocks a task forever. Card-maintainer: two sessions, one shared task — write contention unspecified.

**Q6 — POSITION: ADD first-class criteria table + card-amendment hash chain; CUT authority downgrade (and claims-with-TTL) from v1; the sequencing buries events too late and ships gate-rewire without fingerprint rescoping — reorder.**

ADD: criteria as a real table with an amendment event + hash chain, so decide.js's `snapshot_hash` means something post-doc and temporal queries actually work. CUT: autopilot downgrade and heartbeat claims from v1 — file-overlap warnings deliver 80% of the safety with none of the TTL/decide.js coupling. Sequencing flaws: events land in phase 4, but lazy migration (5) writes `legacy_doc` events and the pre-action gate needs failure history — events schema is a dependency of half the plan. Phase 2 rewires the gate onto cards without rescoping fingerprints — that ships a known runaway class. My order: (1) schema *including* events + criteria table; (2) card + gate rewire *bundled with* fingerprint/goal_doubt rescoping; (3) pre-action gate seeded from supervisor_reviews; (4) overlap warnings; (5) migration; claims/merge-tree/downgrade only after conflict telemetry justifies them.
### GPT-5.5
Q1. POSITION: DB-authoritative is right for the judge’s contract, but wrong if it becomes the only coordination artifact.

Repo-native task files are unsafe as *authority* because builders can edit them, but the author overcorrects by making tasks invisible to the ecosystem. Real-world agent workflows, PR review, CI, and human debugging benefit from repo-local, branch-visible task artifacts. Hybrid: DB is canonical; repo gets signed/read-only projections containing task id, criteria ids, status, and evidence refs. On readback, projections are treated as cache only unless signature/hash matches DB. Builders may propose amendments via PR/comment/CLI, never mutate authoritative criteria. Also add a “projection drift” detector: if GOAL.md/task projection differs from DB, supervisor warns and regenerates. This preserves MemGate while retaining industry ergonomics. The missing point: trust boundary does not imply “no files”; it implies provenance, signatures, and write separation.

Q2. POSITION: The schema is too JSON-heavy for the invariants it needs, and the 1.2k card cap will fail on multi-surface tasks.

`criteria_json`, `constraints_json`, and `verify_facts_json` hide the exact things you’ll need to query, diff, supersede, audit, and fingerprint. Criteria should be first-class rows with stable ids, status, validity interval, source, superseded_by, evidence refs, and last_verified_at. Evidence should be separate typed records, not inline blobs. Missing: acceptance source/authority, dependency/blocking relations, risk level, required approvals, environment assumptions, artifact links, and branch/commit range per task. A 1.2k cap is workable only for narrow tasks. It breaks first on tasks with many criteria, migrations, security constraints, or UI acceptance details. The failure mode is silent omission: the supervisor grills against an abbreviated card and falsely passes. Need overflow retrieval by criterion id plus “card truncated” explicit flag.

Q3. POSITION: Piggybacking on stance is a cheap v0, but unsafe as the boundary authority.

The stance classifier was trained/validated around operator intent and send authority, not task segmentation. Boundary detection has different costs: falsely amending a task can erase scope; falsely closing can suppress supervision; falsely opening can fragment work and poison memory. “Next distinct operator ask” is ambiguous in CLI chatter: bug reports, clarifications, approvals, and emotional corrections can all look like boundaries. Existing live_context behavior may also bias the classifier toward recent words and away from persistent criteria. Dedicated boundary classification may still be LLM-based, but it needs separate labels, confidence, examples, and audit outcomes. Operator-only control is too heavy; better: suggestions default to no mutation, with explicit confirmation for new/amend/close except gate-verified close. Do not let “zero new calls” drive correctness for a contract mutation path.

Q4. POSITION: V1 should include cheap file-overlap warnings and event-based repeat-failure retrieval; claims/merge-tree/downgrade are partly premature.

Pre-action gate earns v1 if scoped narrowly: retrieve prior verify_fail/incident by same files/error/test, with provenance and recency. It directly addresses known repeat-failed-fix loops. File-overlap conflict detection also earns v1 because diffs already exist and would have prevented much of the 3-agent thrash. Claims are dangerous if they become hard locks without UI/lease recovery; start advisory. Merge-tree preflight is valuable but later: it requires reliable branch/worktree metadata and can produce false comfort when conflicts are semantic. Autopilot→copilot downgrade on conflict is sensible but depends on precise conflict attribution. Cheapest thrash prevention: show “another live session is touching these files/task” before sending any intervention, suppress autopilot sends on overlapping files, and escalate once with both session ids and diff summaries.

Q5. POSITION: Replacing the doc will collide with existing dedupe, gate, live-context, and projection assumptions unless task identity becomes a first-class fingerprint dimension.

State keys like `workFp`, `liveFp`, `challengedWorkFp`, `tierVerifiedFp`, `answerKey`, `gateDraftFp`, and `gateEscalatedFp` must become task/card-version scoped; otherwise stale interventions leak across tasks or re-arm endlessly after card edits. `needsOperatorHold/goalConflictKey` must compare operator words against active criteria, not legacy Goal text. Gate records need `task_id`, `criteria_version/hash`, and evidence ids; old review history keyed to doc snapshots loses comparability. `snapshot_hash` in decide.js must include card hash eventually, or audit says “allowed” against invisible state. `live_context` can no longer simply supersede stale doc facts; it should create an amendment suggestion or temporary hold. GOAL.md projection risks reviving stale global goals unless labeled non-authoritative and task-specific. Engagement governor may under-supervise stale active tasks unless claims/heartbeats feed it.

Q6. POSITION: Add contract-versioned evidence; cut deferred decide.js integration; sequencing is not safe as written.

ADD: immutable task/card versions plus typed evidence records. Every verify/gate/answer should cite `task_id`, `card_version`, criterion ids, and evidence ids. Without this, you cannot audit what “done” meant at the time, and validity intervals are mostly decorative.

CUT: phase-2 deferral of `decide.js` task_state input. If PSS is authoritative, policy must know task status, holds, card hash, conflict state, and claim state from v1; otherwise deterministic audit diverges from actual supervision.

Safer order: (1) schema with normalized criteria/evidence/card versions plus read-only projections; (2) decide.js/review/state fingerprint integration, data-only; (3) card UI and answer/gate rewire behind flag; (4) file-overlap warnings and advisory claims; (5) events plus pre-action gate; (6) lazy migration. Do not migrate or inject cards before audit/fingerprint semantics are fixed.
### GLM-5.2
## Q1

POSITION: The author is right on normative authority but wrong to dismiss repo-native files; the design already IS a hybrid (GOAL.md projection) but lacks builder-visible coordination artifacts.

The author conflates two concerns: the judge's contract (DB-authoritative — correct) and builder coordination (repo-native — missing). MemGate protects against retrieved memory overriding the contract; it doesn't say the contract must be invisible to the repo. DB-only creates two problems the author hand-waves: (1) builders reconstruct task state from memory/prose — exactly the old doc failure mode — because they can't see structured task state in the repo; (2) the audit trail lives in sqlite not git, so you lose free versioning, diff, and bisect. The `legacy_doc` event archiving verbatim is a band-aid for absent git history. Hybrid without goalpost-moving: DB stays source of truth; repo gets **read-only projected task cards** (structured, like GOAL.md); builder edits to those files are detected via git diff and rejected/warned. Builders get visible coordination; the contract stays untouchable. The author's own GOAL.md projection proves the pattern works — extend it.

## Q2

POSITION: The 1.2k cap is unsound; criteria-as-JSON prevents per-criterion retrieval and temporal queries; the gate breaks first when the cap bites.

Criteria need a **separate table** (`criteria(id, task_id, text, status, evidence_ref, valid_from, superseded_at, superseded_by)`), not a JSON blob. You query "which criteria were valid at time T" (Zep intervals); you retrieve individual criteria for gate grilling; you track evidence per criterion. A JSON column forces full-load-every-time — the old doc's whole-injection problem in structured clothing. A real task with 6–8 criteria (text + evidence_ref + status + validity) consumes 600–800 tokens alone; add goal, constraints, verify_facts and 1.2k is blown. When it bites, the gate gets truncated criteria — it **cannot verify what it cannot see**. The ETH verbosity finding targets generated prose, not the contract. Truncating the contract to fit a budget is backwards. Also: `close_summary` free-text is narrative rot reincarnated; `files_touched` is session-scoped but should be task-scoped; no `superseded_by` FK on tasks despite `superseded` status; no dependency/parent field (OpenHands DAG was in the research for a reason).

## Q3

POSITION: Piggybacking creates unmeasurable boundary accuracy and structurally misses builder-initiated transitions.

The stance classifier fires on **operator input** — but task boundaries are frequently crossed by builder actions (subtask done, next started) with no operator utterance. "Auto-transition only on gate-verified complete + next distinct operator ask" means the classifier never sees builder-initiated boundary crossings at all. Worse: adding a 4th output to an existing multi-class classifier causes negative transfer on the other outputs, and boundary accuracy is hidden inside stance accuracy — you can never independently eval or improve it. The durable stance (classified once, cached) is temporally wrong for boundaries: a stance from 90 minutes ago saying "amend task" is meaningless after that task closed. Ambiguous operator asks ("now fix the tests") collapse the boundary signal. A dedicated boundary detector — cheap, diff-based, not LLM — checking whether builder file-touches or commit messages crossed a task boundary would catch what the stance classifier structurally cannot. At minimum, the `/task` command should be the **primary** boundary mechanism and the classifier a fallback, not the other way around.

## Q4

POSITION: Pre-action gate and files-touched overlap detection earn v1; merge-tree preflight and formal claims are premature; the thrash was preventable with overlap detection alone.

Pre-action gate (E) is the single highest-value item — directly kills the repeat-failed-fix incident class, cheap retrieval (events by file overlap), PROJECTMEM validates it. Ship it early, potentially ahead of the full events table by querying `supervisor_reviews` for verify-fail on overlapping files. Files-touched overlap + authority downgrade is the **cheapest thing that would have prevented the 3-agent thrash**: two sessions touching the same files → warn + downgrade autopilot→copilot. No claims, no merge-tree, no heartbeat needed. Formal task claims with 10-min TTL are premature — a session running a 15-min test suite loses its claim; activity-based refresh is more complexity than current session counts justify. Merge-tree preflight per gate is expensive (git operation on every sign-off) with low marginal payoff when overlap detection already catches the common case; defer until parallel-session density makes it pay. Ship overlap detection in phase 3; pre-action gate alongside or before events retrieval in phase 4.

## Q5

POSITION: Gate fingerprints, answer counters, and live_context are structurally mismatched with the card; decide.js has a v1 gap with no input source.

Specific collisions: (1) `gateDraftFp/gateEscalatedFp/workFp/challengedWorkFp/tierVerifiedFp` are per-session flat keys but must become per-(session, task) — the schema has no home for them; `session_runtime` is wrong because they survive task pause/resume. (2) `answerKey/answerTries/answerSentTries` are per-session but semantically per-task; no schema field exists. (3) `live_context` was prose-overriding-prose; now it must override structured criteria — the mechanism has no write path for "operator's words amend criterion C3." (4) decide.js loses doc-derived signals (`completion_gate` grills doc criteria, `goal_doubt` checks doc goal-vs-spec) but doesn't gain `task_state` until "phase 2" — so v1 decide.js runs with **neither old doc nor new task input**. (5) GOAL.md projection is under-specified for multi-task projects. (6) `doc_settle_sec`/card-maintainer: prose-update logic doesn't transfer to structured-field updates — this is a rewrite, not a rename. (7) Decision-memory precedents reference old doc criteria; retrieval keys change; existing precedents are stale on migration.

## Q6

POSITION: Add a `criteria` table; cut `close_summary`; reorder so events write path precedes the gate rewire, and give decide.js task_state in the same phase.

**ADD:** `criteria` as a first-class table — unlocks per-criterion gate retrieval, temporal validity queries, and individual provenance. The gate grills individual criteria, not a blob.

**CUT:** `close_summary` free-text. This is the old doc's narrative rot reincarnated. Generate summaries from `task_events` at retrieval time; don't store decaying prose.

**Sequencing is NOT safe as written.** Phase 2 rewires the gate before phase 4 adds the events write path — meaning gate verdicts (verify_pass/verify_fail) have nowhere to write. The gate either silently drops audit records or writes to the old reviews table without the new event schema. **Reorder:** (1) schema + events write path → (2) card + injection → (3) gate/answer rewire (now has card input AND event output) → (4) claims + conflict detection → (5) lazy migration. Also: decide.js must get `task_state` in the **same phase as the gate rewire**, not deferred — without it, decide.js simultaneously lacks old doc input and new task input, running blind on every tick.