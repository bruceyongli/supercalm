# The agents — what each one does and why

Supercalm is built on top of the most powerful coding CLIs — Codex CLI, Claude Code, and
friends. **We supervise those tools; we never become one.** The CLIs are sprinters: superhuman
inside a single session. A real project is a marathon of many sessions over weeks, and between
sessions the CLIs forget goals, drift, repeat failed fixes, and collide in the same repo.

Supercalm's agents are the **endurance layer**: they hold the goal, the quality bar, the
history, and the operator's taste, so the sprinters can keep running at superhuman level for
the whole project. None of them writes code. None of them picks the CLI's approach. That's the
point.

Each session's right-side panel has one tab per agent. Agents are opt-in per session (the
Supervisor) or always-on views (Knowledge, Map, Usage).

---

## Supervisor — the judgment agent

The star of the system, and the only agent that *acts*. Once enabled on a session it runs on
the server (keeps working when you close the page) and each tick picks **at most one**
intervention:

- **Answer** — the builder asked a question → answer it the way *you* would, or escalate to you.
- **Verify / Gate** — the builder claims something is done → check the claim against real
  evidence (git diff, terminal output, screenshots) before it counts. Never trusts prose.
- **Unstick / Keep-working** — the builder is stalled → a bounded nudge.
- **Recover** — the session died or wedged → resume it.
- **Escalate** — anything reserved for a human lands in your needs-you queue.

What shapes its judgment (each of these is visible in the panel):

| Organ | Plain meaning |
|---|---|
| **Task contract** (the Supervision Doc today; [task cards](specs/project-memory-plan.md) next) | *What are we trying to accomplish, and how do we know it's done?* The completion gate grills builders against this. |
| **Doctrine / Learning** | Rules the supervisor *learned from your real replies*. You approve each rule before it goes live — approval **is** deployment. Audit-type rules are actively checked against evidence; violations block sign-off. |
| **Send authority** (Off · Observe · Co-pilot · Autopilot) | What it may send without you: nothing / only what it's sure of / everything except reserved actions. |
| **Attention governor** (hot / warm / stale) | Supervision effort follows *your* engagement: sessions you've touched recently get full care; abandoned ones decay to detection-only instead of burning model calls forever. |
| **Operator stance & stage awareness** | Reads what you want right now (full-auto vs hold vs answer-only) and stands down while the builder is still planning. |
| **Decision memory** | Your past answers, retrieved as precedents so it answers like you did before. |

What it will never do: write code, choose implementations, merge, deploy, or approve
policy-level things on your behalf. Those stay yours.

## Project Knowledge — the descriptive layer

Everything an agent should know about the codebase *regardless of the current task*:
architecture, conventions, how to run things. Two artifacts, both per-project:

- **CONTEXT.md** — a compact project brief injected into builder launches.
- **Wiki** — a self-maintaining knowledge base (overview / components / decisions pages,
  plus your curated `docs/wiki/`), served to builders over MCP (`wiki_search` / `wiki_read`).

The dividing line against the Supervisor, in one test: *"Remove the current task — is this
still true and useful?"* Yes → Knowledge (builder-writable, descriptive). It's about a
decision, standard, verification, or outcome → Supervisor (builder can **never** write it —
the judged don't edit the judge's contract).

## Preflight — the misalignment filter

Before a *fresh* launch, it interrogates your task against the repo (README, manifests, git
history) and prepends a sharpened, advisory brief to the builder's first prompt — so the CLI
builds the right thing instead of a plausible wrong thing. Strictly time-boxed and fail-open:
if it can't help in seconds, the launch proceeds untouched. Its dual mode, **Council**, turns
the same machinery into a multi-model decision room whose conclusions are written into the
wiki and the supervision contract.

## Map — the session picture

A passive view: the session rendered as a live graph (requests → subtasks → tool calls, sized
by cost/time, 2D or 3D). No backend logic, no interventions — it exists so you can *see* what
the sprinter is doing at a glance.

## Usage — the meter

A passive view: token usage, cost, and limits for the session — including what each *agent*
(Supervisor included) spends. The supervisor is subject to the same accounting as everything
else.

## Agent Builder — the scaffolder (privileged, gated)

A global agent that scaffolds or edits *other* agents from a natural-language spec. Anything
it generates is written **disabled, with zero capabilities** — you review and grant. It's how
the agent roster grows without hand-writing boilerplate, with the same approval-gate philosophy
as everything else.

---

### Where this is heading

The Supervisor's memory is being re-architected from a per-session document into **project
memory** — task cards, project standards, typed history, multi-session awareness — so one
project supervised for months stays as sharp as one task supervised for an hour. The full
plain-language plan: [`docs/specs/project-memory-plan.md`](specs/project-memory-plan.md).
