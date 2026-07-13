# Configuring Supercalm

Everything has a working default in [`src/config.js`](../src/config.js). You only set what differs for
your machine. Machine-specific values (device IPs, keys, your tailnet host) go in a **gitignored**
`data/aios.env` so they never reach the repo:

```bash
cp .env.example data/aios.env      # then edit; an empty file is valid
```

`data/aios.env` is simple `KEY=VALUE` lines (`#` comments allowed). It's loaded into the environment at
boot, and a value already exported in your real environment always wins. **Never put secrets in tracked
source** — the [secret-scan hooks](#keeping-secrets-out-of-git) will block that anyway.

---

## Model providers & pricing (Auth & Models page)

- **One section for every model endpoint.** Built-in local proxies (when a fleet is present) appear
  as provider rows with auto keys — toggle "use" to include/exclude them from the catalog. Your own
  endpoints (Anthropic / any OpenAI-compatible) live in the same list.
- **Keyless endpoints work**: leave the API key blank for local/LAN servers without auth (vLLM,
  llama.cpp, LM Studio…). The probe tells you if the endpoint actually requires a key.
- **Cost stats are optional.** Point the pricing field at any price manifest URL —
  the one-click "Use Supercalm's list" (docs/model-prices.json in this repo, regenerate with
  `npm run gen-prices`, PRs welcome), a LiteLLM `model_prices_and_context_window.json` URL, or an
  `openhand-models.json`-style feed. Manifest prices override the built-in defaults per model id;
  skip it entirely and the Usage page still shows token stats (common models are priced by the
  built-in rules regardless). Env: `AIOS_PRICES_URL_DEFAULT`, `AIOS_PRICES_REFRESH_MS`.

## 1. Core

| Var | Default | Notes |
|---|---|---|
| `AIOS_PORT` | `8793` | HTTP port (binds loopback). |
| `AIOS_HOST` | `127.0.0.1` | Keep loopback; expose via Tailscale Serve / a reverse proxy, not by binding `0.0.0.0`. |
| `AIOS_DATA` | `./data` | sqlite, per-session logs, vapid keys. Gitignored. |
| `AIOS_SELF_URL` | `http://127.0.0.1:<port>` | Public base URL used in web-push payloads and links. |

## API model providers (no local proxy fleet)

Most users don't run a localhost model-proxy fleet. Add your own API endpoints on the
**Auth page → "API model providers"** card instead:

- **Anthropic API** (`https://api.anthropic.com` + your `sk-ant-…` key): models join every picker and
  power the supervisor/agents, **and claude sessions route through it automatically** (auth mode `API`)
  whenever no fleet or Supercalm login is available.
- **OpenAI-compatible API** (OpenAI, OpenRouter, together.ai, a local llama.cpp/ollama server — any
  `/v1/chat/completions` endpoint): models join the pickers and power the supervisor/agents.

### Voice: speech-to-text & text-to-speech

The same page configures one OpenAI-compatible **speech provider** for dictation (STT,
`/v1/audio/transcriptions`) and read-outs (TTS, `/v1/audio/speech`) — remote or local:

| Provider | Base URL | STT model | TTS model / voice |
|---|---|---|---|
| OpenAI | `https://api.openai.com` | `whisper-1` | `tts-1` / `alloy` |
| Groq (STT only) | `https://api.groq.com/openai` | `whisper-large-v3` | — |
| Kokoro-FastAPI (local TTS) | `http://127.0.0.1:8880` | — | `kokoro` / `af_heart` |
| speaches / whisper.cpp server (local) | your server | its whisper model | its TTS model |

Local servers usually need no API key (leave it blank). Fallback order: a Spark device
(`SPARK_IP`/`SPARK_HOST`) when configured → the speech provider → local macOS `say` (TTS only) →
the browser's built-in speech (client-side). "Test & save" synthesizes a clip before storing.

Providers are stored in `data/model_providers.json` (chmod 600; keys never leave the server — list
APIs redact them). "Test & add" verifies the key and auto-discovers the model list. Model ids collide?
Address a provider's model explicitly as `<provider-name>/<model>`.

## 2. System binaries

Supercalm shells out to a few tools. Paths are **auto-resolved** across `/opt/homebrew/bin` (macOS ARM),
`/usr/local/bin` (macOS Intel), and `/usr/bin` (Linux), then fall back to a `PATH` lookup. Override only
if yours live elsewhere (e.g. under launchd/systemd with a minimal `PATH`).

| Var | Needed for | Install |
|---|---|---|
| `AIOS_TMUX` | **required** — every agent runs in tmux | `brew install tmux` · `apt install tmux` |
| `AIOS_FFMPEG` | voice (audio transcode) | `brew install ffmpeg` · `apt install ffmpeg` |
| `AIOS_CHROME` | supervisor screenshots / headless verify (optional) | any Chrome/Chromium |
| `AIOS_TOOL_PATH` | the `PATH` used to find the agent CLIs inside tmux | colon-separated dirs |
| `AIOS_AGY_BIN` | the `agy` CLI, if named/located differently | — |

## 3. Coding-agent auth (claude / codex / agy)

**No env vars needed.** Each agent authenticates through its own CLI — run `claude`, `codex`, or `agy`
once in a terminal and complete its login, or use the in-app **Auth page** (`/aios/auth`) which drives
the same OAuth flows and writes the CLIs' own credential files. Supercalm never stores agent passwords;
it reads whatever the CLIs already have. See [`docs/wiki/auth-architecture.md`](wiki/auth-architecture.md).

## 4. External model proxy (optional)

Summaries, the voice brain, and the Supervisor agent reason with a local **OpenAI/Anthropic-compatible
model proxy**. Without one, those features degrade gracefully — the coding agents still run; you just
answer more yourself.

| Var | Default | Notes |
|---|---|---|
| `AIOS_PROXY_KEY` | *(auto/empty)* | **Bearer token, only if your proxy requires one.** A keyless local proxy needs nothing. If your proxy is key-gated, put the key here. |
| `AIOS_DEFAULT_PROXY_PORT` | `8789` | Port of your default chat proxy. |
| `AIOS_SUMMARY_PORT` / `AIOS_SUMMARY_MODEL` | `8789` / `claude-haiku-4-5` | The cheap "read the screen" summarizer. |
| `AIOS_VOICE_CHAIN` | *(built-in)* | Comma-separated fallback chain for the voice brain. |
| `AIOS_SUPERVISOR_DEFAULT_MODEL` | `gemini-pro-agent` | Model the Supervisor reasons with (prefer a vision model). |
| `AIOS_CLAUDE_BASE_URL` | *(auto-detect)* | Pin claude sessions to a proxy URL; `''` forces the claude CLI's own login. |

> Bring-your-own model: point these at any endpoint that speaks the OpenAI `/v1/chat/completions` (or
> Anthropic `/v1/messages`) shape — a local llama.cpp/Ollama/LM-Studio server, a hosted gateway, etc.

## 5. Voice — speech-to-text + text-to-speech (optional)

Voice uses an external device ("Spark": Whisper STT + Kokoro/Qwen TTS), reached by **IP + SNI** because
its MagicDNS often won't resolve on the server. Leave unset to disable voice — text control works
everywhere regardless.

| Var | Notes |
|---|---|
| `SPARK_IP` | The device's Tailscale IP (CGNAT range `100.64`–`100.127.x.x`). |
| `SPARK_HOST` | Its MagicDNS name — used as the TLS **SNI** and `Host` header. |
| `SPARK_PORT` | `443`. |
| `SPARK_LAN_IP` | Optional same-LAN IP for lower latency. |
| `AIOS_TTS_BACKEND` | `spark` \| `local` (`local` = macOS `say`, no device needed). |
| `AIOS_TTS_ENGINE` | `kokoro` \| `qwen`. |
| `AIOS_TTS_VOICE` / `AIOS_LOCAL_TTS_VOICE` | TTS voice ids. |
| `AIOS_STT_POLISH` | `false` (raw Whisper — best for code) \| `true` (grammar-cleaned). |

No voice device? Set `AIOS_TTS_BACKEND=local` for on-device macOS TTS, and the browser's built-in
speech-recognition still lets you dictate; only the Whisper-quality STT needs Spark.

## 6. Antigravity (Google) auth — only for the `agy` proxy provider

The `agy` provider uses the antigravity CLI's installed-app OAuth client. There is **no default** —
supply your own if you use it:

```
AG_CLIENT_ID=...
AG_CLIENT_SECRET=...
```

## 7. Update check

The server polls GitHub for the latest release (default: every 12 h, one anonymous request) and the UI
shows an **"Update available"** toast. On a clean git clone the toast is one-click: it POSTs `/api/update/apply` and the server pulls + reinstalls + restarts itself. Otherwise it links the release; update with `bin/update`.

| Var | Default | Notes |
|---|---|---|
| `AIOS_UPDATE_CHECK` | `1` | `0` disables the check (fully offline installs). |
| `AIOS_UPDATE_REPO` | `bruceyongli/supercalm` | Forks point this at their own `owner/repo`. |
| `AIOS_UPDATE_CHECK_MS` | `43200000` | Interval; floor 15 min. |

## 8. Session defaults & misc

| Var | Default |
|---|---|
| `AIOS_AUTONOMY` | `full` (`ask` \| `auto` \| `full`) |
| `AIOS_CLAUDE_MODEL` / `AIOS_CODEX_MODEL` / `AIOS_AGY_MODEL` | `opus` / `gpt-5.5` / `gemini-pro-agent` |
| `AIOS_PUSH_SUBJECT` | VAPID contact for web-push (a `mailto:` or `https:` URI) |
| `AIOS_IDLE_WAIT` | `4500` ms before a quiet session is "waiting" |
| `AIOS_BG_HOLD_MS` | `600000` ms a live background-terminals footer keeps a still session "working" before it settles to waiting |
| `AIOS_SUBMIT_DELAY` | `320` ms pause before Enter after pasting into an agent TUI |

There are ~130 further fine-tuning knobs (timeouts, limits, per-feature models) — all optional, all
prefixed `AIOS_`. Grep [`src/config.js`](../src/config.js) and the feature modules for `process.env.AIOS_`.

---

## Keeping secrets out of git

Supercalm ships a **secret-scanner** ([`scripts/scan-secrets.mjs`](../scripts/scan-secrets.mjs), zero
dependencies) wired at three layers so private data can't reach a remote:

1. **git hooks** — `pre-commit` and `pre-push` block the operation if a scan finds anything. Install once
   after cloning:
   ```bash
   bin/install-hooks
   ```
2. **CI** — the same scan runs on every push/PR (`.github/workflows/ci.yml`).
3. **GitHub push protection** — server-side secret scanning (keep it enabled on the repo).

It flags private keys, OAuth client secrets, cloud/API tokens (`ghp_`, `sk-`, `AKIA`, …), Tailscale IPs,
MAC addresses, and personal emails. Run it manually anytime:

```bash
node scripts/scan-secrets.mjs
```

A genuine false positive can be waived with an inline `secret-scan: allow` comment on that line — but the
right fix is almost always to move the value into `data/aios.env`.
