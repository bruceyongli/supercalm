# Auth Architecture

*How Supercalm authenticates claude sessions to a model. The arc: a sudden `401 · Please run /login`
epidemic → the realization that Supercalm should not run a **separate** login at all → a 5-mode
auto-detect resolver → a standalone, proxy-compatible auth package → hardening so recovered
sessions stop false-flagging.*
**Status:** ✅ Implemented (host runs in `proxy` mode). · Code: `src/authmode.js`, `src/auth/*`, `src/authapi.js`, `web/auth.{html,js}`.

See also: [[auth-providers]] · [[proxy-fleet]] · [[design-decisions]]

---

## 1. The problem that started it
Supercalm claude sessions began failing mid-conversation with:
```
⏺ Please run /login · API Error: 401 Invalid authentication credentials
```
An in-session `/login`, a dashboard re-login, and the `↻ Re-auth` button all appeared to "not take
effect." The user's key observation: *"I never had a problem with auth — I just logged into the CLIs
once, a week ago. Why all of a sudden? And the proxy is also using CLIs to access the models — do we
really need a separate auth in Supercalm?"*

## 2. Root cause (the pivotal diagnosis)
Two independent facts collided:

1. **Supercalm claude sessions were using the CLI's OWN OAuth** (`~/.claude/.credentials.json`), a ~8-hour
   access token that auto-refreshes. It worked for a week because refresh kept renewing it. It "suddenly"
   broke because the **refresh token got invalidated** — logging into the same Anthropic account
   elsewhere (or a session revocation) rotates/voids other sessions' refresh tokens. Once refresh
   fails, every claude process `401`s.
2. **A running process caches its token** — an in-session `/login` (or dashboard login) cannot fix an
   *already-running* process. Only a **fresh process** reloads credentials. That's why re-login "didn't
   take effect."

⛔ **The insight:** the **proxy** ([[proxy-fleet]]) does **not** use the CLI's `~/.claude` login. It has
its **own** OAuth (`~/.claude-proxy/oauth_creds.json`, dashboard-managed, auto-refreshing) and exposes a
full Anthropic `/v1/messages` on `127.0.0.1:8789`, ignoring the API key on localhost. So Supercalm should
**consume the proxy like everything else on host**, instead of maintaining a second login that expires
on its own schedule. → **One auth.**

## 3. The fix: route claude sessions through the proxy
`startPane` injects, per launch:
```
ANTHROPIC_BASE_URL = http://127.0.0.1:8789   # the proxy's claude endpoint
ANTHROPIC_API_KEY  = sk-aios-via-proxy        # dummy; proxy ignores it on localhost
```
This survives resume (rebuilt from the row like `--effort`/`--model`). Result: no ~8h token expiry,
no separate login. **Verified:** throwaway session replied `READY`; the user's stuck session
`s_8a4082e476` `/compact`-ed successfully through the proxy (a real model round-trip, no 401).

### Gotcha A — the custom-API-key gate
Setting `ANTHROPIC_API_KEY` makes claude ask, once: **"Detected a custom API key … Do you want to use
this API key? 1. Yes ❯2. No"**. Supercalm auto-confirms it for auto/full sessions via a `detect.js`
`CONFIRM_RULE` (keys `['up','enter']` → selects "1. Yes").

### Gotcha B — the benign dual-auth warning
With both the CLI's `~/.claude` login *and* `ANTHROPIC_API_KEY` present, claude prints
`⚠ Both claude.ai and ANTHROPIC_API_KEY set · auth may not work as expected`. It is **benign** — the
API-key→proxy path wins (proven repeatedly). It scrolls off-screen with use. ⛔ **Do not** "fix" it by
pointing `CLAUDE_CONFIG_DIR` at an empty dir: claude stores conversation transcripts under that dir, so
changing it **breaks `--continue`/resume** for every existing session. host's claude.ai creds are
**file-based** (`~/.claude/.credentials.json`), not Keychain — confirmed by probing.

## 4. Portability: the 5-mode resolver (`authmode.js`)
"Some machines run a proxy, some don't." `resolveClaudeEnv()` decides the env **per launch**, no
per-machine config:

| Order | Condition | Result mode | env injected |
|---|---|---|---|
| 1 | `AIOS_CLAUDE_BASE_URL` = a URL | `pinned` | that URL + dummy key |
| 2 | `AIOS_CLAUDE_BASE_URL` = `''` | `cli` | none (force CLI's own login) |
| 3 | external proxy reachable (probe `GET 127.0.0.1:8789/`, cached 45s) | `proxy` | proxy URL + dummy key — **host today** |
| 4 | Supercalm has its own login present | `aios` | local **shim** URL (`127.0.0.1:8799`) + dummy key |
| 5 | otherwise | `cli` | none (CLI's `~/.claude`) |

⛔ **The single-refresher rule:** Supercalm becomes the **refresher** (starts the shim + a background
refresh loop) **only in mode 4** — when no proxy is present. When the proxy is up, Supercalm defers entirely
to it. So Supercalm and the proxy **never race** on the rotating single-use refresh token. This is the
correctness guarantee that makes proxy-compatibility safe (see [[auth-providers]] §"why claude is special").

`claudeMode()` returns the same decision without launching anything (for the status badge);
`authStatus()` adds `proxyUp`, the shim state, and the claude login details.

## 5. Supercalm-managed login + shim (mode 4) — "avoid the 8-hour thing" anywhere
For machines **without** a proxy, Supercalm is self-sufficient (the user chose: auto-detect **+** status
indicator **+** an Supercalm login dashboard). The pieces:
- **`src/auth/` package** — own OAuth login, token store, refresh, and the shim. Self-contained, zero
  Supercalm-server coupling, daemon-ready (see [[auth-providers]] for the structure + the standalone-package
  decision in [[design-decisions]]).
- **`src/auth/shim.js`** — a minimal localhost Anthropic `/v1/messages` passthrough on **`127.0.0.1:8799`**.
  It injects `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` + the
  `"You are Claude Code…"` system marker (⛔ required, or the OAuth token is rejected), pipes SSE, and
  on a `401` force-refreshes once and retries. Started lazily, only in mode 4.
- **Login page** at **`/aios/auth`** + a header **Auth** link and a colored **mode badge**
  (`proxy`/`aios`/`cli`/`pinned`). API: `GET /api/auth/status` + `/api/auth/:provider/{start,complete,logout,refresh}`.

**Why a shim and not a creds-file env var:** claude's CLI cannot cleanly take an arbitrary
credentials-file path, and env-injecting a rotating token across many concurrent sessions reintroduces
the refresh-token contention. A single shim that owns refresh sidesteps both.

### Shim gotcha (fixed)
The shim once **false-aborted**: Node fires the request `'close'` event on a *normal* body-read end,
which the early code treated as a client disconnect → it returned a bogus abort instead of the real
response. Fixed by guarding on the **response** `'close'` + `!writableEnded` (commit `8c779c1`).

## 6. Recovered-session false-flag fix (`detect.js`)
After an auth-recovery relaunch, `claude --continue` **reprints the old conversation**, which can
include the historical `API Error: 401` lines. The bottom-up auth scan then **re-flagged a session that
was actually authenticated**, and the →waiting summarizer wrote "API authentication failed." Two guards:

1. **`HEALTHY_RX = /^[⏺⎿]/`** — scanning the tail bottom-up, if a healthy agent-output line (claude's
   `⏺` response / `⎿` tool-result) is **more recent** than any auth error, the model is reachable *now*
   → stop; the 401s above it are replayed history. Robust, no timer. (`AUTH_RX` is tested first each
   iteration, so a `⏺ …API Error: 401` line never counts as healthy.)
2. **Grace window** `AUTH_GRACE_MS` (120s, env `AIOS_AUTH_GRACE`) — stamped on `resume()`
   (`entry.authGraceUntil`, passed into `classify`); right after a relaunch the auth scan is skipped
   entirely so the reprint can't trip it.

NB the summarizer can still emit a stale auth summary that sticks until the next working→waiting
transition; it self-heals on the user's next message. (Direct DB edits to clear it are correctly blocked
by the harness's production-write guard.)

## 7. The recovery flow (codex/agy, and as a claude fallback)
`detect.js` classifies the expired-auth screen (`authNeeded`) and login-success (`loginOk`) bottom-up
(newest wins). `sessions.js` surfaces stuck sessions as an action item "🔑 Re-login required…"; a login
detected in any session of a tool triggers `recoverAuth(tool)`, which force-relaunches (`resume
--continue`) every stuck session of that **same** tool (debounced + per-session 30s guard).
`POST /api/reauth {tool?}` is the manual trigger (header `↻ Re-auth`). For claude this is now mostly
moot (proxy auth is centrally managed) but harmless; codex/agy still rely on it.

## 8. Quick reference — env knobs
| Env | Default | Effect |
|---|---|---|
| `AIOS_CLAUDE_BASE_URL` | unset | URL → pin; `''` → force CLI login; unset → auto-detect |
| `AIOS_CLAUDE_PROXY_URL` | `http://127.0.0.1:8789` | the proxy endpoint probed/used |
| `AIOS_CLAUDE_KEY` | `sk-aios-via-proxy` | the dummy `ANTHROPIC_API_KEY` |
| `AIOS_PROXY_PROBE_TTL` | `45000` | proxy-probe cache TTL (ms) |
| `AIOS_AUTH_GRACE` | `120000` | post-resume window where replayed 401s are ignored |
