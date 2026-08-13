# Orca (stablyai) vs Supercalm — deep-read, comparison, and battle plan

*2026-08-13 · sources: full clone of github.com/stablyai/orca (2.74M lines TS/TSX — 1.34M excluding tests — read via 4 parallel code explorations), their first-party docs, third-party reviews, market search. Companion to [2026-07 product landscape](2026-07-product-landscape.md).*

## 1. What Orca is

**Orca** ("The AI Orchestrator for 100x builders", onorca.dev) is an MIT-licensed **Electron desktop app** (macOS/Windows/Linux) + **native mobile companion** (iOS App Store / Android APK) by **Stably AI (YC W22)**, founder Jinjing Liang (ex-Google Chrome senior eng). It runs any CLI coding agent (30+ listed: Claude Code, Codex, Cursor, Grok, OpenCode, Pi, …) in parallel git worktrees, tracked in one place.

**Traction:** ~20k GitHub stars by July 2026 → ~43k within 5 months of launch; topped GitHub Trending repeatedly; ships daily (PR numbers past #14,000); README localized into 6 languages; active Discord + 7 WeChat groups (deliberate China distribution). This is the "cmux-class competitor" tripwire from the launch plan — fired, at scale.

**Positioning:** BYO-subscription orchestration layer. $0, no markup, no hosted inference. "If it runs in a terminal, it runs in Orca."

### Feature inventory (verified in code)

- **Parallel worktrees** — N agents, each in an isolated worktree, tracked in dashboards/lineages. **The README's "fan one prompt across five agents, compare, merge the winner" is marketing shorthand**: in code there is no N-way fan-out primitive (`createWorktree` takes exactly one agent), no scoring, and no git-merge-of-winner — the workflow is manual worktree creation → per-worktree diff viewer → `gh pr merge`.
- **Coordinator orchestration + federation** — the real multi-agent machinery: a **user-supplied coordinator agent** parses a spec into a task DAG in a SQLite bus (`decision_gates`, `worker_done`, questions, mailboxes) and dispatches worker agents via generated preambles + heartbeats; **federation** lets a "run home" desktop dispatch supervised workers onto another Orca instance (`orca serve` box / SSH runtime) with ACK-checkpointed mailboxes and authoritative lifecycle settlement. Orca supplies plumbing; all judgment runs on the user's own agent tokens.
- **Terminal engine** — WebGL "Ghostty-class" rendering, infinite splits, background PTY daemon (forked child owning node-pty over a unix socket) that survives app restarts/updates and replays scrollback.
- **Agent status** — hooks-first via an ephemeral loopback HTTP server (`ORCA_AGENT_HOOK_ENDPOINT`), with **14 per-CLI hook adapters** (bespoke waiting semantics for Claude/Codex/Kimi/Droid/Grok/…, three distinct install strategies); OSC 9999 escape fallback, then title-regex last resort ("never inferred from terminal titles"); fixed enum `working|blocked|waiting|done`; "Smart attention" = a 4-class deterministic sort.
- **Design Mode ("grab")** — click an element in embedded Chromium → sanitized HTML + computed CSS + cropped screenshot + **React component/source-file mapping** into the agent prompt, behind an explicit review sheet.
- **Orca CLI** — agents drive Orca over a unix-socket RPC: `worktree|terminal|browser (snapshot/click/fill/eval/intercept)|computer use|orchestration|linear|automations|artifacts`, with an `agent-context --json` self-describing schema.
- **Orchestration primitives** — a SQLite message bus (`decision_gates`, `worker_done`, `answerQuestion`) + skills that teach a **user-supplied coordinator agent** to dispatch/gate/answer worker agents. Orca supplies plumbing; the supervising LLM is the user's own agent.
- **Skills pipeline** — Anthropic-style SKILL.md packages generated from authored guides, version-locked into the CLI binary, installed into hosted agents (`skills add …`).
- **VCS/PM integrations** — deep in-app GitHub PR review (stacked PRs, checks, review threads) + GitLab/Bitbucket/Gitea/Azure DevOps/Jira peers + Linear (~23 CLI subcommands); paste an issue URL → create worktree.
- **Automations** — cron-style scheduled agent runs with shell-command prechecks and usage collection (scheduling, not supervision).
- **Accounts & usage** — per-provider rate-limit fetchers (Claude/Codex/Gemini/Grok/Kimi/MiniMax/OpenCode), local JSONL cost scanning with a price table, **account hot-swap** via keychain/credential-dir swapping gated on live PTYs.
- **Voice** — local **STT dictation only** (sherpa-onnx: Parakeet/Zipformer EN·ZH·KO/SenseVoice/Whisper-tiny; optional OpenAI transcription with user key). **No TTS, no voice assistant.**
- **Mobile** — Expo/React Native companion (App Store + APK), **full steering**: real PTY input, permission approvals, PR review, task dispatch, file browse, dictation. Pairing = QR bearer offer with pinned Curve25519 key; transports race LAN/Tailscale WebSocket vs an opt-in Stably cloud relay (director + cells, E2EE inside TLS — the relay forwards ciphertext). Push = the paired socket → **local** notifications (no APNs/FCM), templated title/body, 256-entry replay ring. Their own findings doc records relay-UX bugs (dead Host pages, grey-dot stalls, 5–12s pairing blackouts).
- **SSH worktrees** — content-hash-versioned relay bundle SFTP'd to `~/.orca-remote/`, npm-installs node-pty on the remote, plain SSH transport; `orca serve` = the **full Electron runtime headless** (Xvfb on Linux, no auto-updater), same pairing-token auth.

### First-party admissions & third-party criticism

- **Renderer scale pain** (their own docs): 100-worktree lineages melt the Zustand store fanout; remote hosts triggered production slowdowns; reconnect repaints every attached remote pane.
- **Mobile relay UX debt** (their own findings doc): dead "Host" pages, grey-dot stalls, 5–12s relay pairing blackouts.
- **Electron mass:** ~250MB download, 400–800MB idle RAM (reviewer-measured). 2.74M lines / 123 npm deps (Supercalm: 73k lines / 1 runtime dep — a 23× non-test code-mass ratio).
- **"Closed laptop = dark phone"** — the desktop app is the brain. `orca serve` exists but is the full Electron runtime under Xvfb with no auto-updater — an ops project, not a resident service.
- **Cost surprise** — parallel fan-out multiplies subscription burn 3–5×, with no intelligence about which model to burn where.
- **Security default criticized** — launches agents with `--dangerously-skip-permissions`-class flags, "worktree as sandbox" (reviewers note the filesystem is not a permission boundary).
- **The most-requested missing feature (per reviews): cross-agent pipelines/automation** — "one agent plans, another writes tests, a third implements" does not exist.

## 2. The decisive architectural fact — stated carefully

**Orca makes zero first-party LLM calls** (verified in code: no model SDK in 2.7M lines; the only inference is optional dictation transcription; titles are `slice(0,160)`; attention is a 4-value enum). All judgment runs on the *user's own foreground agent and tokens* via the coordinator/skills plumbing.

What this is **not** (per adversarial review): a permanent ceiling. Adding a model call is a product decision away — a sidecar, a supervisor skill, a hosted tier. The honest claim is narrower: **today, nobody owns the supervision loop as a first-party, evaluated product** — not Orca, and (per the July landscape) not the rest of the cockpit class. Supercalm has a working head start (supervisor brains, summarizer, doctrine, incident lab, gated deploys) and the durable version of that lead is not "we call LLMs" but: **accumulated per-project policy and accepted/rejected-decision history, measured supervision reliability (precision/abstention/escalation), and deploy-outcome evidence tying task → change → tests → release → health.** Those take calendar time and real usage to copy — but only if we actually accumulate and measure them. Treat this section as a hypothesis with a head start, not a moat deed.

They optimized the cockpit. We're building the autopilot. Their bet: better glass and more levers scale a human. Our bet: the human is the bottleneck, and the system should absorb decisions — with the burden of proof that absorbed decisions are *right*.

## 3. Side-by-side

| Dimension | Orca | Supercalm |
|---|---|---|
| Form factor | Electron desktop app + native mobile companion (+ headless Electron/Xvfb serve mode) | Headless daemon (launchd) + web/PWA over tailnet; phone works while laptop is closed |
| Footprint | 2.74M lines TS (1.34M non-test), 123 deps, 400–800MB idle | 73k lines JS (57k non-test), **1 runtime dep**, ~tens of MB |
| Agent state | Hooks + OSC enum (`working/blocked/waiting/done`); title-regex fallback | Hooks + stabilized-snapshot idle/pattern detection + **LLM summary & category per waiting episode** (action/decision/review) |
| Supervision | **None** (bus + skills for a user-run coordinator agent) | First-party supervisor: auto-answer, dig-for-truth, stage awareness, completion gating, doctrine, operator-stance, incident lab |
| Attention UX | 4-class sort, unread booleans, templated notifications | Needs-you queue with plain-language summaries, category badges, push with substance, voice briefings |
| Voice | Local STT dictation only | Full concierge: TTS briefings (Kokoro), grounded+guarded STT, intent brain, confirm-before-send, **visual check** (auto-prepared desktop/iPad/phone screenshots) |
| Multi-agent | Manual N worktrees + diff viewer + `gh pr merge` (no fan-out primitive, no scoring); coordinator-agent DAG bus + cross-instance federation (user's tokens do the thinking) | Worktree isolation + **gated autonomous integrate→deploy pipeline** (tests → merge → restart → health-verify → auto-rollback); no N-way fan-out UI yet |
| Verification | None (user reviews diffs) | Supervisor evidence (git diff/status, screenshots, test-file tracking), release gates, live-URL monitors, deploy-source guardrails |
| Knowledge | Skills shipped to agents (static, hand-authored) | Per-project CONTEXT.md + self-maintaining wiki over MCP + lessons distilled from sessions + Council decision memory |
| Terminal | WebGL splits, restart-surviving daemon (excellent) | tmux-backed, faithful mirror, web xterm (solid, fewer frills) |
| Editor/browser | VS Code editor, embedded Chromium, Design Mode grab | None (by design — the CLI agent is the editor) |
| VCS/PM | Deep: GitHub/GitLab/Bitbucket/Gitea/AzureDevOps/Jira/Linear in-app | Thin: git evidence + gh CLI via agents |
| Remote | SSH worktrees (installs agent), `orca serve`, opt-in cloud relay for mobile | Tailnet-native: one URL everywhere, no relay, no cloud dependency |
| Usage/accounts | 7-provider rate-limit fetchers, JSONL cost scan, account hot-swap | Per-session/agent usage metering to Usage panel; fleet-proxy model routing; no account hot-swap |
| Onboarding | DMG/installer, brew, AUR, app stores | git clone + launchd (operator-grade; no packaged installer) |
| Distribution | 43k stars, daily ships, 6-language README, WeChat groups | Public repo, zero marketing |

## 4. Honest scorecard — where Orca is ahead

1. **Packaging & onboarding** — signed installers, brew/AUR, app-store mobile. Minutes to first value.
2. **Per-CLI integration depth** — 14 hook adapters with bespoke waiting semantics per CLI, trust presets, account hot-swap, 7-provider rate-limit dashboards. Our detection covers claude/codex/agy well; theirs covers the long tail.
3. **In-app editor/browser/Design Mode** — Chrome-team DNA; grab-to-prompt with React source-file mapping is genuinely novel.
4. **VCS/PM breadth** — five git providers + Jira/Linear, stacked PRs, in-app review.
5. **Terminal engineering** — WebGL rendering, restart-surviving PTY daemon, split ergonomics.
6. **Engineering machine** — 0.74 test-to-source ratio, 28 CI workflows (crash-survival, IME, Wayland), lint ratchets, perf budget gates. Their velocity is real and disciplined; never bet on them being unable to build something.
7. **Distribution machine** — 43k stars in 5 months, daily ships, 6-language README, WeChat groups, mobile store presence.
8. **Cross-instance federation** — dispatching supervised workers onto another Orca box with ACK-checkpointed mailboxes; we have nothing equivalent (our multi-machine story is "the tailnet reaches one host").

## 5. Where Supercalm is ahead today (hypotheses to prove externally)

*Each item is real in code and daily operator use; none has external-user evidence yet. The public versions of these claims must carry metrics (see §7 gates).*

1. **The supervision loop** (their #1 requested missing feature, our core): auto-answering routine prompts, evidence-based verification of done-claims, completion gating, doctrine learned from operator replies, incident-replay lab. Orca's architecture (no first-party LLM) cannot follow without reversing a founding constraint.
2. **Autonomous shipping (for a narrow, reversible class)** — the gated integrate→deploy pipeline with health verify + rollback, running Supercalm's own releases daily. Honest scope: web services with scriptable tests and reversible deploys; not migrations, not billing/auth, not infra. The reviewers are right that "unattended production" must never be marketed beyond that contract.
3. **Attention intelligence** — plain-language "what happened / what's needed" per event vs their enum. Push notifications that carry substance.
4. **Voice as an interface** — end-to-end hands-free triage with grounded STT and auto-prepared visual evidence. They have a dictation box.
5. **Always-on by construction** — daemon + tailnet PWA: phone works with the laptop closed, no relay servers, no pairing state machines (their documented bug farm).
6. **Project memory** — self-maintaining wiki, lessons, Council decisions — the fleet gets smarter per project; Orca's skills are static docs.
7. **Radical lean** — 57k non-test lines/1 dep vs 1.34M/123. We can turn the whole codebase over in days of agent time; they carry Electron+React+Expo mass and a 38k-line runtime god-file their own lint ratchet grandfathers.
8. **Honest autonomy containment** — provenance, AIOS_NO_DEPLOY interlocks, release guardrails, deploy-source checks — vs "worktree as sandbox".

## 6. Strategy — how to be better (post-critique)

**Do not chase their cockpit.** Editor, embedded browser, five VCS UIs, WebGL terminals — their home turf, 1.3M lines deep, staffed, funded, shipping daily. Chasing it burns our lean agility on their strongest ground.

**Own the layer above — as an *interoperable* layer, not a rival island.** Orca's cockpit class teaches people to run 10 agents; the recurring cost they then carry is triage, judgment, and delivery. Supercalm's claim on that layer must be earned with measured reliability, and its distribution should ride existing runners rather than demand replacement. Position, sharpened per critique: not the abstract "autopilot", but the concrete promise —

> **"Wake up to a reviewed queue of small, safely-landed changes — with the evidence, not a dashboard of terminals."**

The ICP for the next two quarters (forced by both reviewers, adopted): **technical solo founders / tiny teams already running Claude Code or Codex on web-app repos with scriptable tests and reversible deploys, on an always-on box.** Everything else (teams, RBAC, enterprises, Windows) is explicitly out of scope for now.

Three moves:

- **A. Make supervision provably reliable before making it louder.** The moat is a measured system: auto-answer precision by prompt class, calibrated abstention, correct-escalation rate, false-done acceptance rate, prompt-injection resistance, and an autonomy ladder (observe → act-in-branch → merge-with-approval → allowlisted autodeploy → never-classes) with policy-as-code per project. We already generate this data daily; instrument it, benchmark it, and publish the report card.
- **B. One golden onboarding path with a zero-trust-hurdle first value.** macOS + launchd, one supported agent, localhost-only: "connect an existing Claude Code/Codex session; within 10 minutes get a grounded *what-needs-you-and-what-I'd-answer* briefing." No tailnet, no deploy credentials, no demo theater required for first value. Tailnet, memory, deploys, voice are progressive activations. Metric: **time to first trusted saved action**, not time-to-dashboard.
- **C. Distribution = interop + design partners, not collateral.** Ship the supervision layer against a *generic runner-hook protocol* (our hooks already speak claude/codex; Orca's 14 adapters prove the shape) so Supercalm can supervise sessions regardless of which cockpit spawned them — including, potentially, Orca's own hook stream. Their installed base is a channel, not only a threat. Recruit 5 named design partners from Claude Code/Codex power-user communities *now*, before P1 hardens; one public weekly build-log/postmortem artifact; success = activated, retained partners — never stars.

**Judged fan-out** (the earlier draft's P2) is demoted to a demand-gated experiment: it's competitor-reactive, cost-multiplying, and the evaluation I proposed was circular (both reviewers, independently). It returns only when design partners repeatedly run competing attempts by hand and a blind benchmark beats trivial baselines (test-pass selection, single flagship agent).

## 7. Execution plan (rebuilt after critique)

*Calendar-week cycles with uncertainty, one externally observable outcome each; WIP limit = one product bet + one reliability/security track + one distribution motion at a time. Every cycle ships through the existing gated pipeline. Effort assumes the operator reviews everything; agent-days are the fleet's, weeks are the operator's.*

### C0 — Validation + threat model (2–3 wks, starts now, runs alongside C1)
- **Design partners first, building second:** recruit 5 named partners from Claude Code/Codex power-user communities (people publicly discussing unattended runs / prompt fatigue). Watch them install *today's* product; their failures define C1's installer scope. The falsifiable question: *for which recurring tasks will they let the system answer/verify/deliver with exception-based review only?*
- **Supervision safety baseline:** measure current auto-answer precision by prompt class, false-done acceptance, escalation correctness on the existing lab corpus + live history; define the autonomy ladder (observe → act-in-branch → merge-with-approval → allowlisted autodeploy → never-classes) and encode the never-classes (migrations, auth/billing, secrets, infra, destructive ops) as policy.
- **Prompt-injection red team:** repo text is adversarial input to a system that *acts*. Lab scenarios: injected CONTEXT.md/test-log/comment attempts to steer supervisor approval or deploy; document the provenance rules that block them.
- **Gate to C2:** baseline metrics exist; ≥3 partners actively trialing; kill/continue thresholds agreed (below).

### C1 — One golden install + first trusted value (4–6 wks)
- macOS + launchd, self-contained: `brew install` or one script; connect ONE existing claude/codex session; localhost-only mode with zero tailnet/deploy setup; first-run ends at a real grounded briefing of the user's own session within 10 minutes. Clean upgrade + uninstall. Linux only after outsiders finish the macOS path unassisted.
- Extend the fresh-install E2E tester to assert the full journey on a cold VM. **Metric: time-to-first-trusted-saved-action** (a recommendation accepted or an answer approved), install-to-activation conversion. *(The old "demo fleet" idea is cut — partners' real sessions are the demo.)*

### C2 — The trusted supervisory loop, measured (4–6 wks)
- Productize what exists into the evidence packet: blocker detected → grounded recommended reply with cited basis → approve-by-default (per-class policy opt-in to auto) → done-claim verified against explicit acceptance criteria → PR/deploy packet with diff/test/screenshot evidence → immutable audit log. The "report card" = this ledger, weekly digest included.
- Reliability gates published per class: auto-answer precision ≥ target, calibrated abstention, zero never-class violations in the lab + live. Production autodeploy stays approval-required for partners until their own data crosses thresholds (Supercalm's self-hosting continues as the existence proof).
- **Gate:** ≥60% recommendations accepted (raw or lightly edited); ≥3 partners returning weekly ×4; ≥2 partners grant branch/PR authority.

### C3 — Runner interop = distribution (4–6 wks, only after C2 gate)
- Generalize the hook ingestion into a documented **runner-hook protocol** (claude/codex today; the shape matches Orca's own hook adapters) so Supercalm supervises sessions spawned by any cockpit — tmux, raw CLI, and evaluate an Orca-sidecar spike honestly (their unix-socket CLI + hook server look ingestible; if their ToS/architecture blocks it, the generic protocol still stands).
- GitHub as machine surface (not UI): checks/PR-comment output of the evidence packet — meets users where review actually happens, answers the "thin gh evidence" critique with policy-grade read integration.
- One distribution motion every week throughout: partner recruitment, a public build-log/postmortem, or a migration guide (from tmux/Orca/hand-scripts).

### C4 — Earned autonomy + demand-gated extras (after C3 metrics)
- Widen auto-answer/auto-deploy per class only where partner data crossed thresholds; publish the autonomy contract publicly (task → change → tests → release → health → rollback ledger, with at least one abstention and one blocked deploy on record — a system that always approves is not credible).
- **Fan-out returns only here**, if partners demonstrably run competing attempts by hand: blind benchmark (dozens of tasks, hidden acceptance), must beat test-pass-selection and single-flagship baselines on false-selection and severe-error rate before any UI exists. Budget controller (per-task cost ceiling, quota awareness, stop-early) is a precondition, not a feature.
- Voice remains an output channel we dogfood (already built, zero new investment) — promoted in marketing only if partner usage shows it reduces decision latency vs push/text.

### Non-goals (hard fence, /decisions to breach)
Embedded editor · embedded browser/design-mode · VCS review **UIs** (machine integration is in-scope) · WebGL terminal work · native mobile apps · Windows · enterprise (RBAC/SSO/audit) — until C2–C3 gates are met with the narrow ICP.

### Tripwires — business first, competitor second
**Kill/continue (primary):** C1 install-to-activation < 50% after fixes → rework onboarding before anything else. C2 acceptance < 60% or any never-class violation live → freeze autonomy widening, fix the brain. No partner grants branch authority by C2 exit → the wedge is triage, not delivery; re-plan C3/C4. Inference cost per supervised session exceeding what a subscription user would plausibly pay → re-architect model routing before scaling.
**Competitor watch (secondary):** stablyai/orca release feed watched for first-party LLM calls, auto-answer/verify features, or a real daemon mode; any → accelerate C2/C3 and lean harder into interop + accumulated policy/evaluation data (the parts a feature launch can't copy). Also watch: platform vendors (Anthropic/OpenAI/GitHub) absorbing supervision into the agent itself — the strongest squeeze; interop posture is the hedge.

## 8. Adversarial critique — resolutions (gpt-5.6-sol, gpt-5.6-terra; kimi/qwen/glm routes 403-de-escalated, opus route thinking-locked)

**Adopted (drove the §6–§7 rewrite):**
1. "Structural ceiling" → narrowed to *currently-unowned loop + head start*; durable asset = measured reliability + accumulated policy/decision data (sol#1, terra#1).
2. **Judged fan-out demoted from P2 to demand-gated C4** with blind benchmarking vs trivial baselines; the seeded-bug 4/5 metric was circular (sol#7–8, terra#5).
3. **Sequencing inverted:** supervision reliability measurement precedes any new headline feature (sol#10).
4. **One ICP, one golden path** (macOS/launchd/localhost-first, real session not demo fleet), metric = time-to-first-trusted-action (sol#6,#18, terra#3,#7).
5. **Design partners before P1**, kill/continue business tripwires primary (sol#19,#27, terra#8,#14).
6. **Autonomy ladder + never-classes + prompt-injection threat model + deploy-authority separation** made an explicit C0 workstream (sol#11–14, terra#4).
7. **Interop/complement-Orca distribution posture**: generic runner-hook protocol + GitHub-checks machine surface + honest Orca-sidecar spike (sol#24, terra#9,#11) — independently proposed by both reviewers.
8. Calendar-week estimates with WIP limits replacing agent-day optimism (sol#17, terra#6).
9. Evidence hygiene: claims tagged verified-in-code vs reviewer-reported vs hypothesis; "no competitor can film that" deleted (sol#4).
10. LOC ratios kept as descriptive fact, removed from strategic-advantage claims; outcome metrics substituted (sol#16, terra#10).
11. Voice demoted to dogfooded output channel pending usage evidence (sol#22, terra#13).

**Rejected / bounded:**
1. *"A capable Orca user's coordinator can already do this"* (sol#3) — partially. Verified-in-code stands: no first-party judge, no supervision, and the coordinator burns the user's own tokens/context with zero measured reliability. Adopted the actionable half: C0 includes reproducing their coordinator workflow hands-on before we claim comparative numbers publicly.
2. *Drop the autopilot framing entirely* (terra#3) — bounded, not dropped: the concrete promise ("wake up to a reviewed queue of safely-landed changes") leads; autopilot/control-tower survives as internal shorthand.
3. *Monetization plan now* (sol#25) — deferred deliberately: this is a dogfooded open project first; pricing hypotheses become real at C3 exit when partner willingness-to-pay is observable. Noted as an open operator decision, not silently skipped.
4. *Voice as expensive novelty* — half-adopted (see Adopted#11); the existing investment is sunk and operator-used daily; no NEW voice scope is planned, so the demotion costs nothing.
