# The Model-Proxy Fleet (`~/proxy`)

*Six local HTTP proxies on host that reuse each CLI/subscription's login and expose a unified
**OpenAI-compatible** API (claude additionally exposes the **Anthropic** `/v1/messages`). Its purpose:
let one CLI/agent call **other** models for cross-model validation & discussion. Supercalm is a pure
**consumer** of this fleet.*
**Status:** ✅ Exists & runs on host. ⛔ **`~/proxy` is OFF-LIMITS to edit** — Supercalm only consumes it.

See also: [[auth-architecture]] · [[usage-and-quota]] · [[cross-model-continuity]] · [[design-decisions]]

---

## The fleet (from `~/proxy/CLAUDE.md`)
| Proxy | Port | Credential | Notes |
|---|---|---|---|
| gemini | 8787 | `~/.gemini/oauth_creds.json` (CLI default) | ⛔ **channel shuts down 2026-06-18**; Gemini long-term goes via antigravity |
| codex | 8788 | `~/.codex/auth.json` (CLI default) | gpt-5.x; prepaid ChatGPT sub |
| claude | 8789 | `~/.claude-proxy/oauth_creds.json` (dashboard login, **not** Keychain) | **the only Anthropic `/v1/messages` surface**; prepaid Claude sub |
| aliyun | 8790 | `~/proxy/.dev.vars` `TOKEN_PLAN_CN_API_KEY` | qwen/kimi/deepseek/glm + image; **never put it behind a proxy** (CN endpoint) |
| antigravity | 8791 | `~/.antigravity-proxy/oauth_creds.json` (self-built OAuth, `scripts/login.js`) | **Google AI Ultra** ($250/mo); also the docs/dashboard host (root 443) |
| spark | 8792 | SSH key (`ssh spark`) | local vLLM `qwen36-a3b`; `max-num-seqs 1` (single concurrency) |

On host the API ports bind `0.0.0.0` (LAN + Tailscale reachable directly); ⛔ **API ports must NOT use
`tailscale serve`** (tailscaled would grab the same port → `EADDRINUSE`). Only the **dashboard/docs**
go through Serve (root `443` → 8791). This is why [[infra-and-networking]] keeps the `/aios` Serve
mapping strictly additive.

## ⛔ Routing default (important): antigravity-first
The proxy's own rule: everyday / single / small-to-mid jobs → **antigravity (8791) Gemini** first
(`gemini-pro-agent` = Gemini 3.1 Pro High for reasoning; `gemini-3-flash-agent` = Gemini 3.5 Flash High
for agent/doing). It's **already-paid Ultra quota — idle = wasted money.** Use **aliyun** only for
large-scale batch (hundreds/thousands of calls). codex/claude are prepaid subs, use normally.

## Per-provider capability limits (measured, don't assume)
- **gemini / antigravity**: text + vision + **web_search** ✓; image-gen/TTS ✗ on the OAuth channel.
  Code-Assist channel is **rate-limited per-user-per-day** (Ultra ~2000 req/day, all models shared) → bad
  for batch.
- **codex**: text + vision + web_search ✓; non-codex models (gpt-5/o4-mini) not supported.
- **claude**: text + vision + extended thinking + structured output ✓; only specific model ids
  (`*-latest` 404s). ⛔ Opus 4.8 **deprecates `temperature`** at the model level — don't send it.
- **aliyun**: text + vision (qwen3.6/kimi) + **image-gen** (wan/qwen-image) ✓.
- **spark**: local `qwen36-a3b` (Qwen3.6-35B-A3B), 8192 ctx, single concurrency.

### antigravity = Google AI Ultra (ToS grey area, but fine for normal use)
Unofficial OAuth client hitting `daily-cloudcode-pa`. ⛔ Bans in the wild trace to **high-frequency/
automated abuse**, not normal interactive use — *the user bought Ultra precisely to use it; don't scare
them off it.* Two gotchas: (a) UA must be the **real `agy` CLI version** (`agy --version`); the real CLI
does **not** send `X-Client-Version`/`X-Client-Name` — don't add them. (b) Ultra tier serves
`gemini-pro-agent` (3.1 Pro High), `gemini-3-flash-agent` (3.5 Flash High), default `gemini-3.5-flash-low`,
and **Claude Opus/Sonnet 4.6** (⛔ **no** Opus 4.8, **no** Gemini 3.5 Pro / `gemini-3-pro`). This Claude-4.6
availability matters for [[cross-model-continuity]].

## ⛔ The API-surface split (the crux for Claude Code continuity)
- **Only the claude proxy (8789) speaks the Anthropic `/v1/messages` API** — and it's backed by Anthropic
  (the quota that ran out). Files: `claude/src/{server,chatAdapter,anthropic}.js`.
- **All other proxies are OpenAI-compatible** (`/v1/chat/completions`).
- ⟹ Claude Code (which speaks **only** Anthropic) cannot point at gemini/qwen as-is — it needs a
  translation bridge. See [[cross-model-continuity]].

⛔ The claude proxy must inject `"You are Claude Code, Anthropic's official CLI for Claude."` as the
first system block or the OAuth token is rejected (`ensureClaudeCodeSystem`). The Supercalm shim copies this.

## Observability (already built — Supercalm just surfaces it)
- **Ledger:** every request → `~/.proxy-logs/requests.jsonl` (one JSON line: `ts, provider, proxy,
  model, endpoint, stream, status, latency_ms, usage{prompt,completion,cached,reasoning,total,cacheWrite},
  cost{…official rates…}, error, request, response`). Pricing in `shared/pricing.js`.
- **`GET /admin/overview`** (alias `/overview`) — one JSON: per-provider status + live quota, every model
  with official price, capabilities, base URLs, routing guidance, quick-start curl.
- **Dashboard:** `http://127.0.0.1:8791/admin/dashboard` (also `https://host.your-tailnet.ts.net/admin/dashboard`)
  — tabs: Subscription Usage / Request Records / Overview.
- **`GET /admin/quota`** per provider (antigravity exposes `remainingFraction` + `resetTime`); claude has
  `/api/oauth/usage` (the subscription %). See [[usage-and-quota]].

## How Supercalm touches the fleet
- **Auth:** claude sessions route through `:8789` ([[auth-architecture]]); Supercalm's own logins write the
  fleet's credential paths ([[auth-providers]]).
- **Voice brain:** `llm.js` fallback chain across `:8791` (gemini-3.1-flash-lite) → `:8790` (kimi) → `:8789`
  (claude-haiku). **Summaries:** `:8789` claude-haiku. **TTS/STT:** NOT the fleet — direct to the Spark
  device (see `CLAUDE.md`).
- ⛔ Never edit `~/proxy`. Never add `HTTPS_PROXY` to aliyun. Never `tailscale serve` an API port.
