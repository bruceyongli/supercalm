# Design Decisions (ADR log)

*Every architecture decision and open question from the 2026-06 auth/proxy/usage conversations, with the
reasoning and current status. Lightweight ADR format. Newest context first within each entry.*

See also: [[auth-architecture]] · [[auth-providers]] · [[proxy-fleet]] · [[usage-and-quota]] · [[cross-model-continuity]]

---

## ADR-1 — Route claude sessions through the proxy (one auth) ✅ DECIDED & IMPLEMENTED
**Context:** Supercalm claude sessions used the CLI's own `~/.claude` OAuth, which expired/`401`d when its
rotating refresh token was invalidated. The proxy already has its own managed, auto-refreshing OAuth.
**Decision:** Inject `ANTHROPIC_BASE_URL=http://127.0.0.1:8789` + dummy key per launch; do **not** run a
separate Supercalm login on host. **One auth = the proxy's.**
**Consequences:** auto-confirm the "use this API key?" gate; tolerate the benign dual-auth warning; never
touch `CLAUDE_CONFIG_DIR`. Full detail: [[auth-architecture]].
**Alternatives rejected:** keep the CLI login (expires independently); `claude setup-token` everywhere
(per-machine toil).

## ADR-2 — Portable auth: auto-detect + Supercalm login dashboard ✅ DECIDED & IMPLEMENTED
**Context:** "Some machines run a proxy, some don't — and we still need to avoid the 8-hour thing."
**Decision (user picked all three):** auto-detect the proxy **+** a status indicator **+** an Supercalm-managed
login. → the 5-mode `resolveClaudeEnv()` resolver + `src/auth/` package + `/aios/auth` page + mode badge.
**Key safety property:** Supercalm refreshes **only when no proxy is present** (mode 4) → never races the
proxy's rotating token (the single-refresher rule). Detail: [[auth-architecture]].

## ADR-3 — Auth as a standalone in-process package (not a daemon) ✅ DECIDED & IMPLEMENTED
**Context:** Should auth be a shared standalone **process** both proxy and Supercalm consume?
**Decision:** A clean standalone **package** (`src/auth/`), run **in-process**, daemon-*ready* but not a
daemon. **Why not a daemon now:** (a) `~/proxy` is off-limits to me, so the proxy can't be made to consume
a new daemon without the user refactoring it; (b) on host the proxy already *is* the auth authority, so a
daemon would overlap it; (c) the current design already avoids contention via mutual exclusion. The
package is structured so it *could* be promoted to a daemon later if the user refactors the proxy onto it.
**Alternatives rejected:** shared library only (doesn't solve runtime contention); full daemon now
(premature, needs proxy edits I can't make).

## ADR-4 — Supercalm credentials are proxy-compatible (same path, scopes, shape) ✅ DECIDED & IMPLEMENTED
**Context:** "Make Supercalm-managed compatible with proxy-managed — same file path, same permissions/scopes."
**Decision:** Each provider writes the **proxy's** credential path, respecting the proxy's env overrides,
with byte-compatible on-disk shapes and identical scopes. A login minted in Supercalm is a drop-in for the
proxy and vice-versa. Safe because of the single-refresher rule (ADR-2). Detail: [[auth-providers]].

## ADR-5 — Extend logins to codex + antigravity ✅ DECIDED & IMPLEMENTED
**Context:** "Extend the login page to Codex and antigravity too, also proxy-compatible."
**Decision:** Both added to the provider registry as dashboard **paste flows** (confirmed feasible by
reading `~/proxy/{codex,antigravity}/src/oauthLogin.js` — they're paste flows despite localhost-redirect
URIs). codex = ChatGPT PKCE → `~/.codex/auth.json` (CLI default); antigravity = Google client-secret OAuth
→ `~/.antigravity-proxy/oauth_creds.json` (serves the **proxy**, since the closed `agy` CLI's store can't
be reused). Both **login-only** (refresh owned by CLI/proxy). Detail: [[auth-providers]].

## ADR-6 — The recovered-session false-flag guards ✅ DECIDED & IMPLEMENTED
**Context:** `claude --continue` reprints old `401` lines → Supercalm re-flagged a healthy session as
`authNeeded`.
**Decision:** `HEALTHY_RX` (a more-recent `⏺`/`⎿` line ⇒ auth fine) + a 120s post-resume grace window.
Robust, mostly timer-free. Detail: [[auth-architecture]] §6.

## ADR-7 — Move the proxy into Supercalm as an opt-in module? 🔵 OPEN (discussed, no decision)
**Context:** "The proxy is mostly for cross-model validation. Should we move it into Supercalm as an opt-in
module/package for users with multiple subscriptions or a local model?"
**Framing:** The proxy is a mature, hardened, multi-provider system. Three paths discussed:
1. **Reuse:** package the proxy + have Supercalm *supervise* it (start/stop/health/endpoints/usage), fed by the
   auth logins Supercalm already manages. *Recommended long-term* — Supercalm is a supervisor by nature; reuse over
   rewrite; the packaging refactor is the user's (since `~/proxy` is off-limits to me).
2. **Native proxy-lite:** extend the auth-package shim into a small self-contained gateway for the
   providers Supercalm already auths + a local-model passthrough. Self-contained; a deliberate subset; some
   duplication.
3. **Keep separate:** Supercalm consumes the proxy where present; revisit when distribution actually matters.
**Status:** the choosing question was **interrupted** — no decision recorded. Note: on host this is moot
(proxy already runs); it's really an **Supercalm-as-a-product-for-other-machines** decision. Detail rationale:
[[proxy-fleet]], [[cross-model-continuity]].

## ADR-8 — Usage monitor vs continuity bridge: which first? 🔵 OPEN (interrupted)
**Context:** Anthropic quota exhausted ("OpenClaw" incident). Two asks: (a) a usage monitor, (b) keep
using Claude Code on another model.
**Options surfaced:** build the Claude-Code-on-Gemini **bridge** first / build the **usage page** first /
just switch to **codex/agy now** (zero build).
**Status:** the priority question was **interrupted** — no decision. Immediate zero-build continuity
(codex/agy sessions) is always available. Detail: [[usage-and-quota]], [[cross-model-continuity]].

## ADR-9 — Robust never-sleep fix for host 🟡 SPECIFIED, pending application
**Context:** Supercalm went unreachable because **host was asleep** (not an app bug). Remote WoL didn't wake it.
**Decision:** apply `pmset` never-sleep + `caffeinate` keep-awake + a watchdog + disable Tailscale key
expiry; optionally LAN-bind Supercalm. Blocked only on host being awake to apply it. Detail + the diagnostic
methodology: [[runbook-host-unreachable]].

---

## Standing constraints referenced throughout
- ⛔ **`~/proxy` is OFF-LIMITS to edit** — Supercalm only consumes it.
- ⛔ **host's 443 root `/`** is the proxy dashboard — the `/aios` Serve mapping is strictly additive.
- ⛔ **API proxy ports must never `tailscale serve`** (EADDRINUSE with tailscaled).
- ⛔ **Never blanket `tmux kill-session aios-*`** — it kills the user's live sessions.
- Git-only deploy; commit/push only when asked; commits co-authored per `CLAUDE.md`.
