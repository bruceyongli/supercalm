# Supercalm

A self-hosted "operating system" for driving CLI coding agents (`claude`, `codex`, `agy`) on your own
machine. Supercalm launches each agent in a persistent tmux session, streams the raw terminal to a web
dashboard, detects when a session is **waiting for your input**, and lets you answer by **voice** or text
from any device — so your projects keep moving while you're away from the keyboard. A **supervisor** agent
can run sessions on your behalf (Observe → Co-pilot → Autopilot) and learns to respond the way you do.

> Runs at `https://<your-node>.<your-tailnet>.ts.net/aios` (tailnet-only); direct `:8793` is a fallback.

> **Note:** Supercalm is a personal, self-hosted tool — a working *reference implementation*, not a turnkey
> product. It assumes you run your own tmux host and, optionally, a local model-proxy fleet and a
> Whisper/TTS device. All of that is configurable (`.env.example`); the voice/proxy features degrade
> gracefully when unconfigured.

## What it does

Supercalm is built on top of the most powerful coding CLIs — it **supervises** them instead of
becoming one. The goal: prolong their superhuman autonomy on long-term, complex projects.
→ [**What each agent does and why**](docs/agents.md)

- **Supervise** — an opt-in, per-session Supervisor answers builder questions the way *you* would,
  verifies claimed completions against real evidence (diff / terminal / screenshots) before they
  count, unsticks stalls, recovers crashes, escalates only what's truly yours — and **learns your
  judgment** from your real replies (you approve every learned rule before it goes live).
- **Run agents** — start `claude` / `codex` / `agy` sessions per project; they run in tmux so they
  survive restarts and disconnects.
- **See everything** — live raw terminal (xterm.js over SSE), full saved transcripts, and the
  status of every session (working / waiting / exited).
- **Needs-you queue** — a dashboard list of sessions blocked on you, with the extracted question.
- **Answer by voice** — record on any device → a Whisper dictation device (optional) → text → routed
  straight into the waiting session.
- **Push notifications** — your devices get a web-push alert the moment a session needs input
  (installable PWA, so iPhone/iPad work too).

## Architecture

```
browser (laptop/phone/iPad, tailnet)
        │  HTTPS via Tailscale Serve /aios on 443
        ▼
   Supercalm  (Node, host, 127.0.0.1:8793)
   ├─ src/server.js   node:http router · static · SSE
   ├─ src/sessions.js tmux: launch/capture/tail/send/keys/discover + poll/tail loops
   ├─ src/detect.js   idle+pattern classifier → working/waiting + question
   ├─ src/hooks.js    /api/hook/{claude,codex,agy} precise lifecycle signals
   ├─ src/spark.js    /api/transcribe → Spark (ffmpeg→wav, IP+SNI override)
   ├─ src/push.js     web-push (VAPID) → notify on →waiting
   └─ src/store.js    node:sqlite (projects/sessions/events/messages/push_subs)
        │ spawns
        ▼
   tmux sessions  →  claude / codex / agy   (per project dir)
```

- **No framework, small dependency set.** Node 22+ built-ins (`http`, `node:sqlite`, `child_process`)
  + system `tmux`/`ffmpeg`/`tailscale`; npm runtime deps are `web-push` plus the AG-UI packages used by
  Agent View. xterm.js and graph libraries are vendored.
- **`~/proxy` is off-limits** — that's the shared multi-model proxy fleet; Supercalm only *uses* it.

## Setup

```bash
git clone https://github.com/bruceyongli/supercalm.git && cd supercalm
npm install
bin/install-hooks               # secret-scan on every commit + push (keeps private data out of git)
cp .env.example data/aios.env   # optional — set device IPs / keys (all optional; gitignored)
npm start                        # http://127.0.0.1:8793   (npm run dev for --watch)
```

Requires **Node 22+** plus system `tmux` (and `ffmpeg` for voice). It binds to loopback — expose it to
your devices over Tailscale Serve or an authenticated reverse proxy (never the public internet).

- **Installing via a coding agent?** Point Claude Code / Codex at **[`docs/INSTALL.md`](docs/INSTALL.md)** —
  a step-by-step, self-verifying guide written for an agent to execute.
- **Configuring for your setup?** See **[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)** — external model
  proxy (+ token), voice STT/TTS, binaries, and agent auth.

## Updating

**One click:** when a new release is out, every open Supercalm page shows an **"Update available
vX.Y.Z — click to update now"** toast. Clicking it makes the server pull, reinstall, and restart itself;
the page then offers a reload. (The server checks GitHub ~every 12 h with one anonymous request —
disable with `AIOS_UPDATE_CHECK=0`, point forks elsewhere with `AIOS_UPDATE_REPO=owner/repo`.)

**Or from a terminal:**

```bash
bin/update        # fast-forward pull → npm install → restart the service
```

Safe by design: both paths refuse if you have local edits and only ever fast-forward. The one-click
button appears only when the server confirms it can self-update (a clean git clone).

## Versioning & releases

- **`package.json` is the single source of truth**; the server reads it at boot and serves it at
  `/api/version` + `/healthz`. Nothing else hardcodes the version — never edit it by hand.
- **`bin/version [patch|minor|major|X.Y.Z]`** is the only thing that bumps it (commit `release: vX.Y.Z`
  + annotated tag `vX.Y.Z`). Semver-ish while 0.x: **patch** = routine release (default), **minor** =
  notable feature sets, **major** = breaking config/API changes.
- **`bin/release`** (maintainers) = secret-scan → version bump → push with tags → GitHub Release with
  generated notes (needs `GITHUB_TOKEN`; without it the tag still ships and installs discover the new
  version via the `package.json` fallback).
- Distribution is **git-based** — no build step, vendored front-end deps, tiny npm footprint — so
  `bin/update` is the whole upgrade story. (Prebuilt binaries may come later; they'd still need `tmux` +
  the agent CLIs, so they add little today.)

## Run / deploy (reference deployment)

```bash
# one-time: install as a launchd/systemd service (auto-start + restart on crash)
bin/install-service
# one-time: publish on the tailnet
bin/expose                              # tailscale serve /aios on 443 -> 127.0.0.1:8793
```

From your dev machine:

```bash
bin/deploy        # bump version, git push, fast-forward host, restart
bin/logs          # tail the host log
```

## Using it

1. Open the dashboard, **+ Project** (name + absolute path on host).
2. **+ Session** → pick the project + tool (`claude`/`codex`/`agy`), **Autonomy** (ask/auto/**full**) and **Effort** (medium/high/**xhigh**), + an initial task → Launch.
3. Watch it work in the live terminal. When it needs you it appears in **Needs you**.
4. Reply by text, or hold **🎙** to dictate. Tap **🔔** once per device to get push alerts.

**Autonomy** maps to each tool's flags — `full` = codex `--dangerously-bypass-approvals-and-sandbox`,
claude `--dangerously-skip-permissions`, agy `--dangerously-skip-permissions`; `auto` = sandboxed,
no prompts; `ask` = approvals on. For `auto`/`full`, Supercalm auto-accepts known one-time gates (the
directory-trust prompt and claude's bypass-permissions warning) so sessions truly run hands-off.
Defaults: `AIOS_AUTONOMY=full`, `AIOS_EFFORT=xhigh`.

## Key endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | dashboard snapshot (projects, sessions, queue, counts) |
| GET | `/api/events` | SSE: dashboard live updates |
| POST | `/api/projects` | register a project `{name, path}` |
| POST | `/api/session` | launch `{project_id\|path, tool, task?}` |
| GET | `/api/session/:id` | detail + messages + snapshot |
| GET | `/api/session/:id/stream` | SSE: raw terminal bytes |
| POST | `/api/session/:id/input` | send a reply `{text, source}` |
| POST | `/api/session/:id/key` | send a control key `{key}` (enter/esc/up/…/ctrl-c) |
| POST | `/api/session/:id/{stop,kill,resize}` | interrupt / kill / resize |
| POST | `/api/transcribe` | audio (raw body) → `{text}` via Spark |
| GET/POST | `/api/vapidPublicKey` · `/api/subscribe` | web-push |
| POST | `/api/hook/{claude,codex,agy}` | tool lifecycle signals |

## Config (env)

Everything has a working default in `src/config.js`; set only what differs for your setup. Machine-specific
values (device IPs, keys) go in a gitignored `data/aios.env` (loaded at boot) so they stay out of the repo
— see **[`.env.example`](.env.example)** and the full **[configuration reference](docs/CONFIGURATION.md)**.
Common knobs: `AIOS_PORT` · `AIOS_DATA` · `AIOS_PROXY_KEY` (if your model proxy needs a token) ·
`SPARK_IP`/`SPARK_HOST` (optional voice device) · `AIOS_PUSH_SUBJECT`.

## Keeping secrets out of git

Machine-specific secrets live only in gitignored `data/aios.env`. A zero-dependency **secret-scanner**
([`scripts/scan-secrets.mjs`](scripts/scan-secrets.mjs)) runs as a **pre-commit + pre-push git hook**
(`bin/install-hooks`) and in **CI**, blocking private keys, OAuth secrets, API tokens, Tailscale IPs, MACs,
and personal emails from ever reaching a remote. Run it anytime: `node scripts/scan-secrets.mjs`.

## License

[MIT](LICENSE). See `CONTRIBUTING.md` to hack on it, `SECURITY.md` for the threat model,
**[`docs/INSTALL.md`](docs/INSTALL.md)** to install via an agent, **[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)**
to configure, and `CLAUDE.md` + `docs/` for implementation notes and architecture.
