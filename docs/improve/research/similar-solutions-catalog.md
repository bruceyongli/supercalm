# Similar solutions catalog — coding-agent control planes

**Last reviewed:** 2026-08-02
**Scope:** products that coordinate coding agents, let a human supervise them remotely, or run coding
work asynchronously. This is a living source registry, not a one-time competitive verdict.

The question behind this catalog is not “who has the longest feature list?” It is: **what can help one
operator keep autonomous project work moving, spend attention only where it changes the outcome, and
trust the evidence behind a status report?**

The dated [July 2026 product-landscape digest](2026-07-product-landscape.md) contains the strategic
conclusions from one research sweep. This file keeps the underlying market map current.

## How to maintain this catalog

1. Prefer a product's documentation, repository, release notes, or first-party announcement. A search
   result is a lead, not evidence.
2. Record observed behavior separately from an AIOS recommendation. Use “not found in reviewed
   sources” instead of claiming a feature does not exist.
3. Update `Last reviewed` and the entry's source links when behavior changes. Avoid volatile prices,
   model names, download counts, and star counts unless the dated value itself matters.
4. Do not delete a discontinued or pivoted product. Move it to **Retired or pivoted** with the date and
   primary evidence; failed approaches are useful research.
5. Put an unverified lead in **Research queue**. Promote it only after reading a primary source and
   recording what is materially different.

Use these states:

- **Active** — current first-party product or documentation was reviewed.
- **Watch** — active, but its positioning, architecture, or availability is changing quickly.
- **Research** — relevant lead; current capabilities have not yet been verified.
- **Retired/pivoted** — the original approach ended or materially changed.

## What “similar” means

The catalog covers four overlapping classes:

- **Local agent workspace:** launches or organizes coding CLIs, normally with worktree isolation.
- **Remote companion:** exposes locally running sessions on web/mobile and sends attention alerts.
- **Cloud coding agent:** executes asynchronous work in a managed environment and returns a diff or PR.
- **Supervision layer:** detects blocked/waiting work, coordinates agents, enforces process, or preserves
  an audit trail.

Generic AI editors, model gateways, and observability dashboards belong here only when they materially
help supervise autonomous coding work.

## Current map

`Local` means the user's machine or a user-controlled server remains the execution source of truth.
`Cloud` means the vendor provisions the execution environment. `Hybrid` supports both or bridges them.
“Voice” records a first-party conversational or dictation surface, not ordinary speech-to-text in the
operating system.

| Solution | State | Class | Execution | Agent scope | Isolation / handoff | Remote or mobile | Voice | Most useful research angle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Orca](#orca) | Active | Local workspace + remote companion | Local / SSH | Multiple CLI agents | Worktree per task; compare and merge | iOS, Android, web companion | Dictation | Closest broad UI/control-plane peer |
| [Superset](#superset) | Active | Local agent workspace | Local | Multiple CLI agents | Worktrees and diff review | Not found in reviewed sources | Not found | High-density parallel-agent workspace |
| [Conductor](#conductor) | Active | Local agent workspace | Local | Claude Code, Codex, Cursor flows | Isolated workspaces / worktrees | Not found | Not found | Parallel work and merge ergonomics |
| [Vibe Kanban](#vibe-kanban) | Watch | Local agent workspace | Local | Many coding CLIs | Worktree per task attempt | Web UI; mobile status unclear | Not found | Task/attempt model and review loop |
| [Codex app and cloud](#openai-codex-app-and-cloud) | Active | Workspace + cloud agent | Local + cloud | Codex | Built-in worktrees / cloud environments | Cross-surface session continuity | Not evaluated | Parallel task UX and automations |
| [Claude Code Remote Control and web](#claude-code-remote-control-and-web) | Active | Remote companion + cloud agent | Local + cloud | Claude Code | Local session or isolated cloud task | Web and mobile app | Not evaluated | Local-source-of-truth remote control |
| [Cursor Background Agents](#cursor-background-agents) | Active | Cloud coding agent | Cloud VM | Cursor agent | Separate Git branch / PR handoff | Web and mobile | Not found | Async follow-up and environment setup |
| [Happier](#happier-formerly-happy) | Active | Remote companion | Local | Claude Code, Codex, OpenCode, others | Existing local sessions | Mobile, web, desktop | Voice input | Encrypted, agent-agnostic remote access |
| [Omnara](#omnara) | Watch | Remote companion + agent platform | Local + managed | Omnara agents / integrations | Git worktrees | Mobile, web, desktop, watch | Two-way voice | Phone-call-style steering and wrapper risk |
| [GitHub Copilot cloud agent](#github-copilot-cloud-agent-and-agent-hq) | Active | Cloud agent + supervision surface | Cloud | Copilot and enabled third-party agents | Branch and pull request | GitHub Mobile, web, VS Code | Not found | Issue-to-PR delegation and review |
| [Devin](#devin) | Active | Cloud coding agent + coordinator | Cloud VM | Devin / managed child Devins | Independent sessions and PRs | Web | Not found | Coordinator, knowledge, playbooks, schedules |
| [OpenHands](#openhands) | Active | Agent platform | Self-hosted + cloud | OpenHands SDK / agents | Isolated workspaces | Remote API / web | Not found | Open self-hosted execution boundary |
| [Jules](#google-jules) | Active | Cloud coding agent | Cloud | Jules | Session, plan, activities, source changes | Web / API | Not found | Async task API and plan approval |
| [agents-deck](#agents-deck) | Active | Supervision layer | Local | Claude Code, Codex, Cursor, others | Git-native audit trail | Browser dashboard | Not found | Attention state and process guardrails |
| [Agent Deck TUI](#agent-deck-tui) | Active | Local session manager | Local | Claude, Gemini, OpenCode, Codex, others | Optional git worktrees | Terminal; Telegram plugin | Not found | Lightweight multi-session visibility |

Blank or “not found” cells are research gaps, not proof that the feature is absent.

## Direct local workspaces

### Orca

**Observed.** Orca is an MIT-licensed desktop workspace that runs Codex, Claude Code, OpenCode, Pi,
and other CLI agents side by side, each in its own worktree. It combines terminals, persistent
scrollback, annotated diffs, GitHub and Linear integration, browser-based design inspection, file and
media previews, usage tracking, SSH worktrees, and compare/merge flows. Its companion keeps the
desktop as the execution source of truth while exposing status, replies, source control, attachments,
and dictation on mobile.

**Study for AIOS.** Orca is the most useful baseline for information density and cross-device session
continuity. Compare its terminal/diff/browser workspace with AIOS, but separately test the thing AIOS
is trying to make scarce: well-ranked, evidence-backed requests for human attention.

**Sources:** [site](https://www.onorca.dev/), [documentation](https://www.onorca.dev/docs),
[mobile companion](https://www.onorca.dev/docs/mobile), [GitHub](https://github.com/stablyai/orca)

### Superset

**Observed.** Superset presents many coding agents in one desktop workspace, gives each task a git
worktree, supports different CLI agents, and puts diff review beside the running sessions. Its product
positioning emphasizes operating dozens of agents without losing an overview of their state.

**Study for AIOS.** Examine scan speed, keyboard navigation, worktree lifecycle, and how much agent
state can remain visible without turning the interface into a monitoring wall.

**Sources:** [site](https://superset.sh/), [documentation overview](https://docs.superset.sh/overview)

### Conductor

**Observed.** Conductor runs agents in parallel workspaces backed by separate branches and working
trees. Its documentation covers Claude Code, Codex, and Cursor-oriented workflows and the handoff from
parallel work to review and integration.

**Study for AIOS.** Compare conflict handling, workspace setup cost, and the interaction that takes a
finished worktree into review, merge, and cleanup.

**Sources:** [parallel agents](https://www.conductor.build/docs/concepts/parallel-agents),
[documentation](https://www.conductor.build/docs)

### Vibe Kanban

**Observed.** Vibe Kanban models work as tasks with one or more attempts. Each attempt receives a
dedicated worktree, streams execution, and leads into change review. Its documentation lists a broad
set of supported coding-agent CLIs.

**Study for AIOS.** The task-versus-attempt distinction is useful for retries and competing solutions.
Re-check product status before drawing architectural conclusions; earlier market snapshots and the
currently available documentation do not tell a consistent lifecycle story.

**Sources:** [creating workspaces](https://www.vibekanban.com/docs/workspaces/creating-workspaces),
[monitoring task execution](https://www.vibekanban.com/docs/core-features/monitoring-task-execution),
[supported agents](https://www.vibekanban.com/docs/supported-coding-agents)

### agents-deck

**Observed.** agents-deck is a local, git-native dashboard for multiple coding-agent families. It
focuses on quickly distinguishing blocked, working, review, and standby states, with process
guardrails and an audit trail but no account or database requirement.

**Study for AIOS.** Its small state vocabulary is directly relevant to Needs You. Test whether its
status distinctions come from reliable structured events or conventions the agent must follow.

**Sources:** [site](https://agents-deck.com/)

### Agent Deck TUI

**Observed.** This separately named project is a terminal session manager for Claude, Gemini,
OpenCode, Codex, and other agents. It offers groups, search, notifications, fast session switching,
worktrees, session forks, and per-session tool configuration.

**Study for AIOS.** It is a useful lower-bound reference: how much supervision value can be delivered
without inventing a large visual layer? Also examine its transcript hooks and optional messaging
channels as alternatives to screen-state inference.

**Sources:** [GitHub](https://github.com/asheshgoplani/agent-deck)

## Remote and conversational companions

### Claude Code Remote Control and web

**Observed.** Remote Control reconnects a browser or mobile client to a Claude Code process that keeps
running on the user's machine. It uses outbound HTTPS, synchronizes the conversation across clients,
and supports multiple sessions. Claude Code on the web is a different mode: Anthropic provisions a
cloud environment for independent, asynchronous GitHub work.

**Study for AIOS.** Keep “remote control of a local truth” distinct from “cloud task delegation” in
both UI and failure handling. Reconnect behavior, delivery acknowledgement, and explicit session
identity are important references for AIOS conversation mode.

**Sources:** [Remote Control](https://code.claude.com/docs/en/remote-control),
[Claude Code on the web](https://support.claude.com/en/articles/12618689-claude-code-on-the-web)

### Happier (formerly Happy)

**Observed.** Happier is an open-source, end-to-end encrypted companion for coding agents including
Claude Code, Codex, and OpenCode. The agent continues on the user's computer while mobile, web, and
desktop clients expose the session remotely.

**Study for AIOS.** Review its pairing, encrypted relay, reconnect, and multi-agent adapter boundaries.
These are especially relevant if AIOS ever needs safe access beyond a private Tailnet.

**Sources:** [site](https://happy.engineering/), [GitHub](https://github.com/happier-dev/happier)

### Omnara

**Observed.** The current Omnara product combines desktop agent orchestration, worktrees, mobile/web/
watch access, and two-way voice. Its documentation describes monitoring and steering sessions that
continue running away from the phone. The original open-source CLI wrapper is explicitly no longer
maintained; Omnara says it moved to its own Agent SDK-based, voice-first platform because upstream CLI
changes repeatedly broke the wrapper.

**Study for AIOS.** Test the conversational contract, not just speech quality: interruption, ambiguous
references such as “fix it,” explicit confirmation, delivery acknowledgement, session changes, and
noise rejection. The legacy wrapper is strong evidence for preferring structured adapters and stable
protocols over terminal scraping wherever available.

**Sources:** [current product](https://remote.omnara.com/),
[quickstart](https://docs.omnara.com/quickstart), [architecture](https://docs.omnara.com/how-it-works),
[legacy wrapper and migration note](https://github.com/omnara-ai/omnara)

## Platform workspaces and cloud agents

### OpenAI Codex app and cloud

**Observed.** The Codex app organizes parallel agent threads by project, isolates local work with
built-in worktrees, supports diff review and comments, carries sessions across CLI and editor
surfaces, and can run recurring automations. Codex cloud uses managed environments for asynchronous
repository work.

**Study for AIOS.** The strongest UI references are progressive disclosure, local-versus-cloud task
clarity, readable diffs, and session continuity. AIOS should not duplicate model/provider labels in
multiple places merely because the reference UI shows rich session metadata.

**Sources:** [Codex app announcement](https://openai.com/index/introducing-the-codex-app/),
[Codex product](https://openai.com/codex/)

### Cursor Background Agents

**Observed.** Cursor runs asynchronous agents in isolated Ubuntu-based cloud machines. They clone a
GitHub repository, work on a separate branch, accept follow-ups, and can be inspected or taken over.
Environment setup can be committed in `.cursor/environment.json`; an API supports programmatic agent
creation and management. Cursor also exposes background agents through web and mobile.

**Study for AIOS.** Compare environment reproducibility, secret boundaries, follow-up semantics, and
the security tradeoff of automatically running commands in an internet-connected remote machine.

**Sources:** [background agents](https://docs.cursor.com/background-agent),
[API](https://docs.cursor.com/background-agent/api/overview),
[web and mobile](https://docs.cursor.com/en/background-agent/web-and-mobile)

### GitHub Copilot cloud agent and Agent HQ

**Observed.** GitHub turns an issue or prompt into an asynchronous agent session that changes a branch
and opens a pull request. The session can be followed and steered from GitHub, VS Code, and GitHub
Mobile. GitHub also documents enabled third-party coding agents alongside Copilot, using issues, pull
requests, an Agents surface, and mobile as common entry points.

**Study for AIOS.** The issue/PR is a durable collaboration boundary and audit artifact. Compare that
with AIOS's session-first model, especially for “done,” requested changes, CI failure, and handoff to
another agent.

**Sources:** [cloud agent overview](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview),
[mobile](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-mobile),
[third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)

### Devin

**Observed.** Devin runs software tasks in managed environments and can operate many sessions through
an API. Managed Devins adds a coordinator that decomposes work, starts and monitors child sessions,
messages or terminates them, and builds reusable knowledge, playbooks, and schedules.

**Study for AIOS.** This is the clearest commercial reference for supervisor-as-worker-manager. Compare
how coordination decisions are evidenced, what is learned automatically, and when a human sees a
decision rather than raw child-agent activity.

**Sources:** [introduction](https://docs.devin.ai/get-started/devin-intro),
[advanced capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities)

### OpenHands

**Observed.** OpenHands provides an open agent SDK and agent server that can run locally, on-premises,
or in managed cloud infrastructure. Its server exposes isolated workspaces, lifecycle management, and
event streams rather than requiring the user interface to own the execution process.

**Study for AIOS.** Examine the separation between agent runtime, sandbox, event protocol, and UI. It
is a useful architectural comparison for replacing fragile terminal inference while preserving
self-hosting.

**Sources:** [Agent Server overview](https://docs.openhands.dev/sdk/guides/agent-server/overview),
[cloud workspaces](https://docs.openhands.dev/sdk/guides/agent-server/cloud-workspace),
[CLI](https://docs.openhands.dev/openhands/usage/cli/quick-start)

### Google Jules

**Observed.** Jules exposes asynchronous coding work as sessions with activities, source context, and
a plan that can require approval. Its REST API makes the task lifecycle available to other tools.

**Study for AIOS.** The explicit session/activity/plan resources are useful protocol references for
structured progress and approval states that do not depend on interpreting terminal prose.

**Sources:** [Jules API reference](https://developers.google.com/jules/api/reference/rest)

## Evaluation frame for future reviews

When a solution changes, evaluate the workflow rather than copying its visual styling:

| Dimension | Question to answer |
| --- | --- |
| Attention | Does it distinguish “working,” “informational,” and “a human decision is required”? Can an acknowledged item stay dismissed across devices until genuinely new work appears? |
| Grounding | Does a report identify the project, request, latest outcome, evidence, and exact next action without replaying transcripts? |
| Conversation | Can the user interrupt, ask a question, refer to earlier context, reject a call, and know whether feedback was delivered? |
| Reliability | What happens on disconnect, process exit, device sleep, duplicate event, partial transcript, or provider change? |
| Isolation | Are parallel changes separated? Is integration deterministic, reviewable, and recoverable? |
| Evidence | Can the operator inspect the diff, tests, artifacts, and deployment state behind a claim? |
| Agent independence | Does it work across agent CLIs and subscription authentication without reducing every agent to fragile screen scraping? |
| Automation | Can tasks start from schedules, APIs, issues, or status transitions? Are retries and stop conditions bounded? |
| Learning | Does operator feedback become scoped, reviewable project doctrine rather than invisible prompt accumulation? |
| Deployment boundary | Is execution local, self-hosted, or vendor-cloud? What source, secret, network, and retention risks follow? |

For each serious comparison, capture one end-to-end scenario:

1. Start three independent tasks in the same repository.
2. Let one finish, one require a decision, and one fail or disconnect.
3. Acknowledge the decision on one device and verify the state on another.
4. Ask for a spoken summary, interrupt it, ask a grounded follow-up, and deliver feedback.
5. Inspect evidence, integrate the selected result, and confirm cleanup and recovery behavior.

This scenario is more informative for AIOS than a feature checklist or polished launch screenshot.

## Research queue

These leads overlap the scope but need a fresh primary-source review before being promoted:

| Lead | Why examine it | Evidence needed |
| --- | --- | --- |
| CodeLayer | Worktree-oriented multi-agent desktop UI cited in the July sweep | Current official site/repository, lifecycle, supported agents |
| Agentastic | Parallel coding-agent workspace | Current official docs and isolation/review workflow |
| Crystal | Multi-session Claude-oriented desktop workflow | Maintained repository, current feature set, lifecycle |
| FleetCode | Fleet view for coding sessions | Primary product/docs and event model |
| Emdash | Open-source multi-agent workspace | Current repository/docs; remote and review behavior |
| Sculptor | Parallel-agent experiments and background suggestions | Current first-party documentation and availability |
| 1Code | Desktop/multi-agent development environment | Canonical product/repository and execution model |
| Ramp Inspect / Open Inspect | Supervisor-style inspection of agent work | Canonical release/docs and current availability |
| Factory Droid | Autonomous software-development agent | Current orchestration, evidence, and mobile surfaces |
| Google Antigravity | Agent-oriented development environment | Current official docs and task-isolation model |
| Claude Deck | Browser command center for Claude Code/Codex and agent teams | Repository, state detection, and coordination semantics |
| OpenClaw | Fleet heartbeat / quiet-unless-needed monitoring | Canonical repository and current notification behavior |
| HumanLayer / ACE | Human approval and plan-review patterns | Current product boundary and coding-agent integration |
| AgentOps | Loop detection and agent observability | Primary detection semantics and self-hosting options |
| VibeTunnel / claude-squad | Lightweight terminal and worktree orchestration | Current maintenance status and patterns worth retaining |

New candidates should enter here rather than being presented as established facts.

## Retired or pivoted

### Omnara legacy CLI wrapper

**State changed:** the earlier open-source wrapper is no longer maintained. The maintainers describe
moving to a new Agent SDK-based platform after repeated upstream Claude Code changes made wrapper
maintenance unreliable. The current Omnara product remains in the active catalog above.

**Lesson:** an adapter that depends on terminal wording, undocumented process behavior, or private CLI
internals needs an explicit compatibility budget and a structured fallback path.

**Source:** [legacy repository notice](https://github.com/omnara-ai/omnara)

## Change log

- **2026-08-02:** Created the evergreen catalog from the Orca review. Seeded direct workspaces,
  remote/conversational companions, cloud agents, a repeatable evaluation frame, and a verification
  queue. Separated the current Omnara platform from its retired CLI-wrapper architecture.
