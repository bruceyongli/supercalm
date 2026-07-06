# Supercalm

A remote "operating system" for driving CLI coding agents (`claude`, `codex`, `agy`) on the
Tailscale node **host**. Supercalm launches each agent in a persistent tmux session, streams the raw
terminal to a web dashboard, detects when a session is **waiting for your input**, and lets you
answer by **voice** or text from any device on the tailnet — so your projects keep moving while
you're away from the keyboard.

> Runs at `https://<your-node>.<your-tailnet>.ts.net/aios` (tailnet-only); direct `:8793` is a fallback.

> **Note:** Supercalm is a personal, self-hosted tool — a working *reference implementation*, not a turnkey
> product. It assumes you run your own tmux host and, optionally, a local model-proxy fleet and a
> Whisper/TTS device. All of that is configurable (`.env.example`); the voice/proxy features degrade
> gracefully when unconfigured.

## What it does

- **Run agents** — start `claude` / `codex` / `agy` sessions per project; they run in tmux so they
  survive restarts and disconnects.
- **See everything** — live raw terminal (xterm.js over SSE), full saved transcripts, and the
  status of every session (working / waiting / exited).
- **Needs-you queue** — a dashboard list of sessions blocked on you, with the extracted question.
- **Answer by voice** — record on any device → [Spark](https://spark.your-tailnet.ts.net) Whisper
  dictation → text → routed straight into the waiting session.
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
git clone <this-repo> aios && cd aios
npm install
cp .env.example data/aios.env   # optional — set device IPs / tailnet host / keys (all optional; gitignored)
npm start                        # http://127.0.0.1:8793   (npm run dev for --watch)
```

Requires **Node 22+** plus system `tmux` (and `ffmpeg` for voice). It binds to loopback — expose it to
your devices over Tailscale Serve or an authenticated reverse proxy (never the public internet).

## Run / deploy (reference — the author runs it on a node named `host`)

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
values (device IPs, tailnet host, keys) go in a gitignored `data/aios.env` (loaded at boot) so they stay
out of the repo — see **`.env.example`**. Common knobs: `AIOS_PORT` (8793) · `AIOS_DATA` ·
`SPARK_IP`/`SPARK_HOST` (your optional voice device) · `AIOS_IDLE_WAIT` (4500ms) ·
`AIOS_SUBMIT_DELAY` (320ms) · `AIOS_PUSH_SUBJECT`.

## License

[MIT](LICENSE). See `CONTRIBUTING.md` to hack on it, `SECURITY.md` for the threat model, and `CLAUDE.md`
+ `docs/` for implementation notes, gotchas, and architecture.
