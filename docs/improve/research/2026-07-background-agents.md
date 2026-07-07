Ramp's Inspect & Open-Inspect vs
  Supercalm

  Are we solving the same problem? The same
  mission — "agents do real work in the
  background; humans steer from anywhere" — but
  from opposite ends, with one deep philosophical
  split:

  ▎ Ramp closes the verification loop by giving
  ▎ the agent tools to verify itself (run tests,
  ▎ screenshot, query telemetry). We close it with
  ▎ an independent supervisor that doesn't trust
  ▎ the agent. Open-Inspect has no needs-input
  ▎ detection, no independent completion check
  ▎ (the control plane trusts execution_complete),
  ▎ no voice, and its "supervisor" is a process
  ▎ manager. Our whole verify-path exists because
  ▎ our data shows self-reports lie (the
  ▎ merlin/engelsbench fake-dones: 0/7 criteria
  ▎ met, agent said "done").

  Architecturally they're cloud-native (Cloudflare
  Durable Objects + Modal microVM sandboxes +
  OpenCode, Terraform, ~80k-line control plane):
  sessions are ephemeral VMs restored from
  snapshots, prompts are fire-and-forget with
  queued follow-ups, output is a PR. We're
  self-hosted on your real machine: agents are the
  interactive CLIs you already pay for, in tmux,
  with live terminals, waiting-detection, voice
  answering, and a learning supervisor. They're
  team-multiplayer; we're operator-centric.

  What we genuinely do better (their gaps, our
  core): needs-you detection + the queue;
  skeptical evidence-demanding verification with
  reopen labels; the operator stance/doctrine
  system (nothing like it exists there — their
  agent never learns you); voice + phone control;
  the send-authority ladder; and radical
  deployability — npm install && npm start vs
  Terraform + Cloudflare + Modal + a GitHub App.
  Ramp's own metric is 30% of merged PRs —
  impressive, but their model only fits orgs that
  can run that stack. Supercalm is the answer for
  the individual/small team, and our pitch should
  say so explicitly.

  What they do better, and what I'd adopt —
  ranked:

  1. Triggers & automations (their strongest
  product idea we lack entirely): cron / webhook /
  Sentry / GitHub / Slack events → spawn a
  session, with dedup keys, per-repo fan-out, and
  auto-pause after 3 failures. "CI failed → a
  supervised fix session starts" is a killer
  feature for us, and our supervisor makes it
  safer than theirs.
  2. Evidence contracts with anti-hallucination
  guardrails: their visual-verification skill
  literally forbids claiming success without the
  ▎ (the merlin/engelsbench fake-dones: 0/7 criteria met, agent said "done").

  Architecturally they're cloud-native (Cloudflare Durable Objects + Modal microVM sandboxes + OpenCode, Terraform, ~80k-line control plane): sessions are ephemeral VMs restored from snapshots, prompts are fire-and-forget with queued follow-ups, output is a PR. We're self-hosted on your real machine: agents are the interactive CLIs you already pay for, in tmux, with live terminals, waiting-detection, voice answering, and a learning supervisor. They're team-multiplayer; we're operator-centric.

  What we genuinely do better (their gaps, our core): needs-you detection + the queue; skeptical evidence-demanding verification with reopen labels; the operator stance/doctrine system (nothing like it exists there — their agent never learns you); voice + phone control; the send-authority ladder; and radical deployability — npm install && npm start vs Terraform + Cloudflare + Modal + a GitHub App. Ramp's own metric is 30% of merged PRs — impressive, but their model only fits orgs that can run that stack. Supercalm is the answer for the individual/small team, and our pitch should say so explicitly.

  What they do better, and what I'd adopt — ranked:

  1. Triggers & automations (their strongest product idea we lack entirely): cron / webhook / Sentry / GitHub / Slack events → spawn a session, with dedup keys, per-repo fan-out, and auto-pause after 3 failures. "CI failed → a supervised fix session starts" is a killer feature for us, and our supervisor makes it safer than theirs.
  2. Evidence contracts with anti-hallucination guardrails: their visual-verification skill literally forbids claiming success without the returned artifact ID. Our completion-gate challenges should name the required artifact form the same way ("paste the test command's output; a claim without it is unverified").
  3. Sub-session fan-out as an agent tool (spawn-task with depth caps, repo pinning, concurrency limits): a natural extension of Council — builders spawn parallel subtasks, each under our supervisor.
  4. Three-stage intake classifier (deterministic rules → channel context → cheap LLM with confidence + explicit clarify path): the right template if/when we add a Slack/Telegram intake, and a good upgrade for the voice brain's routing.
  5. Engineering patterns worth stealing regardless: pure decision functions separated from effects (they do it for sandbox lifecycle; we already did it for send-policy/stance/decide — extend it to detect.js's watchdog thresholds), ack+buffer+replay event delivery for reconnects, host-scoped fail-loud git credential brokering, and the <user_content> prompt-injection envelope for any external text we feed agents.
  6. Their maturity bar: ~3,400 tests, ADRs, real-workerd integration tests. Our replay-fixture harness is the same instinct — keep compounding it.

  One-line verdict: they built a superb dispatch-and-PR factory for a trusted org on cloud infra; we built a supervised, learning command center for the agents you already run. The biggest wins available to us are their triggers/automations and their evidence-contract discipline — both of which slot into our supervisor rather than replacing anything. If you want, I can turn #1 and #2 into a concrete proposal next.