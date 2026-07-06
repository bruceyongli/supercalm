# Auth Providers — the standalone `src/auth/` package

*The three OAuth flows Supercalm can drive from its dashboard, faithfully matching the proxy fleet so a
credential minted by Supercalm is a **drop-in for the proxy** (same file path, scopes, on-disk shape). An
independent re-implementation of `~/proxy/{claude,codex,antigravity}/src/oauthLogin.js` — which is
**read-only reference** ([[proxy-fleet]] is off-limits to edit).*
**Status:** ✅ Implemented. · Code: `src/auth/{index,providers,store,shim}.js`.

See also: [[auth-architecture]] · [[proxy-fleet]] · [[design-decisions]]

---

## Package structure (the standalone-package decision)
The user chose **"clean standalone package, in-process"** over a separate daemon (rationale in
[[design-decisions]]). Zero coupling to Supercalm's web server; the Supercalm side is two thin adapters
(`authmode.js` + `authapi.js`).

| File | Role |
|---|---|
| `providers.js` | **Registry** — pure config + flow functions per provider. No file I/O, no caching. |
| `store.js` | Credential file read/write (atomic, chmod-600) + token lifecycle (`getAccessToken`, `forceRefresh`, refresh loop). |
| `shim.js` | The claude-only localhost Anthropic passthrough (`:8799`). See [[auth-architecture]] §5. |
| `index.js` | Public API + pending-PKCE map: `startLogin`, `completeLogin`, `status`, `logout`, `loggedIn`, `getAccessToken`, `ensureShim`, `startRefreshLoop`. |

Every provider is a **dashboard "paste" flow**: the browser lands on a localhost/callback page that
won't load; the user copies the `code` (bare, `CODE#STATE`, query string, or full URL — `parseCodeState`
handles all) and pastes it back. This works even for codex/antigravity whose redirect is
`localhost:1455`/`:51121` — the proxy's own dashboard does exactly the same.

---

## ⛔ Why claude is the special one
The other CLIs share their default credential file with the proxy; claude cannot, for **two hard
reasons** the user articulated:

1. **macOS Keychain locks headless.** The Claude Code CLI's *default* store is the login Keychain. On
   host (driven over SSH/AnyDesk, no GUI session) the Keychain locks → the `security` CLI hangs on a GUI
   unlock prompt, and even token refresh stalls. A plain chmod-600 **file** sidesteps it entirely.
2. **Rotating single-use refresh tokens.** Claude's refresh tokens are single-use/rotating. If two
   things share one credential, whichever refreshes first **rotates the token and silently invalidates
   the other** — proxy and CLI knock each other offline. So the proxy mints its **own** token in its
   **own** file (`~/.claude-proxy/oauth_creds.json`) and never shares with the CLI.

→ Supercalm follows the same rule: it writes the **proxy's** path (so one login serves both) but **only
refreshes when no proxy is present** (mode 4). This is the single-refresher rule from [[auth-architecture]].

---

## The three providers (exact, from `providers.js`)

### claude — Anthropic OAuth · PKCE · JSON token body · **refreshable + shim-served**
| Field | Value |
|---|---|
| `credPath` | `AIOS_CLAUDE_CREDS_FILE` → `CLAUDE_CREDS_FILE` → `<AIOS_CLAUDE_CREDS_DIR\|CLAUDE_CREDS_DIR\|~/.claude-proxy>/oauth_creds.json` |
| `clientId` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| `scope` | `org:create_api_key user:profile user:inference` (⛔ `user:profile` required or `/api/oauth/usage` 403s) |
| `authorizeUrl` | `https://claude.com/cai/oauth/authorize` (+ `code=true`, `response_type=code`, PKCE S256) |
| `tokenUrl` | `https://platform.claude.com/v1/oauth/token` |
| `redirectUri` | `https://platform.claude.com/oauth/code/callback` |
| on-disk shape | `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes[], subscriptionType } }` |
| `serves` | `claude` → the Anthropic **shim** serves sessions this token |
| `refreshable` | **true** (refresh = form body `grant_type=refresh_token`) |

### codex — ChatGPT/OpenAI OAuth · PKCE · form token body · **login-only**
| Field | Value |
|---|---|
| `credPath` | `AIOS_CODEX_AUTH_FILE` → `<CODEX_HOME\|~/.codex>/auth.json` — **the Codex CLI default** |
| `clientId` | `app_EMoamEEZ73f0CkXaXp7hrann` |
| `scope` | `openid profile email offline_access api.connectors.read api.connectors.invoke` |
| `authorizeUrl` | `https://auth.openai.com/oauth/authorize` (+ `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs`) |
| `tokenUrl` | `https://auth.openai.com/oauth/token` |
| `redirectUri` | `http://localhost:1455/auth/callback` (paste-flow: copy `code` from the won't-load page) |
| on-disk shape | `{ OPENAI_API_KEY:null, tokens:{ id_token, access_token, refresh_token, account_id }, last_refresh }` |
| `account_id` | the `chatgpt_account_id` claim decoded from the `id_token` JWT (⛔ login fails if it can't derive one) |
| `serves` / `refreshable` | `null` / **false** — codex sessions read `~/.codex/auth.json` directly; codex CLI + proxy refresh it themselves (OpenAI tokens tolerate sharing). Supercalm is **login-only**. |

### antigravity — Google OAuth · **client-secret, NO PKCE** · form token body · **login-only**
| Field | Value |
|---|---|
| `credPath` | `AIOS_AG_CREDS_FILE` → `<AG_CREDS_DIR\|~/.antigravity-proxy>/oauth_creds.json` |
| `clientId` | `<AG_CLIENT_ID — set in data/aios.env if you use antigravity auth>` |
| `clientSecret` | `<AG_CLIENT_SECRET — set in data/aios.env>` (the Antigravity CLI installed-app client; supply your own) |
| `scope` | `cloud-platform` + `userinfo.email` + `userinfo.profile` + `cclog` + `experimentsandconfigs` (full Google URLs) |
| `authorizeUrl` | `https://accounts.google.com/o/oauth2/v2/auth` (+ `access_type=offline`, `prompt=consent`) |
| `tokenUrl` | `https://oauth2.googleapis.com/token` |
| `redirectUri` | `http://localhost:51121/oauth-callback` |
| on-disk shape | `{ access_token, refresh_token, expiry, email }` (email fetched from `userinfo`) |
| `serves` / `refreshable` | `null` / **false** — the closed-source `agy` CLI keeps an opaque store Supercalm can't reuse, so this login serves the **antigravity PROXY** (the voice brain on `:8791`), not `agy` sessions. |
| gotcha | the `code` is single-use; reusing/expiring it → "no refresh_token" → generate a fresh link. |

---

## What "compatible with proxy-managed" means here (the user's request)
1. **Same path** — Supercalm writes the proxy's credential files (above), respecting the proxy's own env
   overrides (`CLAUDE_CREDS_*`, `CODEX_HOME`, `AG_CREDS_DIR`). `AIOS_*` vars still let you split them if
   ever needed.
2. **Same scopes/shape** — byte-compatible on-disk objects, so a login minted in Supercalm is immediately
   usable by the proxy and vice-versa.
3. **No contention** — guaranteed by the single-refresher rule ([[auth-architecture]] §4): Supercalm only
   refreshes claude in mode 4; codex/antigravity are login-only (their CLI/proxy own refresh).

## Pending verification
The fully-automated paths are verified; the **interactive Supercalm login** (user pastes a fresh
`CODE#STATE` at `/aios/auth`, independent of the proxy's token, then a session forced onto the shim
responds + survives a refresh) is the one step that needs the user — the shim's real-token passthrough
wasn't self-tested to avoid rotating the proxy's live token.
