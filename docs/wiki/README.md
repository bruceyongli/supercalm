# Supercalm Wiki

*LLM-oriented knowledge base for Supercalm — the tailnet agent-supervision OS on **host** — and its
surrounding ecosystem (the model-proxy fleet, auth, usage, infra). Distilled from the design
conversations and incidents of 2026-05 → 2026-06. Companion to the repo's [`CLAUDE.md`](../../CLAUDE.md)
(implementation rules) and the per-machine `~/.claude` memory; this wiki holds the *why*,
the *decisions*, and the *cross-system* knowledge.*

**Audience:** an LLM agent (or human) picking up Supercalm cold. Each article is self-contained and
fact-dense. Cross-references use double-bracket wiki-links naming the target file without its `.md`
extension (e.g. the link to [[auth-architecture]] points at `auth-architecture.md`).

---

## Status legend
- ✅ **Implemented** — built + (usually) verified live on host.
- 🟡 **Decided** — agreed, not yet built.
- 🔵 **Proposed / Open** — discussed, no decision yet.
- ⛔ **Constraint** — a hard rule or external limit; do not violate.

---

## Articles

| Article | What it covers |
|---|---|
| [[auth-architecture]] | Why claude sessions kept hitting `401 · Please run /login`, the pivotal "route through the proxy = one login" fix, the 5-mode auto-detect resolver, the standalone `src/auth/` package, and the recovered-session false-flag fix. **Start here for auth.** |
| [[auth-providers]] | The three OAuth flows Supercalm can drive (claude / codex / antigravity): exact endpoints, scopes, PKCE vs client-secret, on-disk credential shapes, proxy-shared paths, and **why claude is the special one** (Keychain + rotating refresh tokens). |
| [[proxy-fleet]] | The 6-proxy local model gateway on host (`~/proxy`, **off-limits to edit**): ports, credentials, routing guidance (antigravity-first), per-provider capability limits, the Anthropic-vs-OpenAI API-surface split, and the request ledger + dashboard. |
| [[usage-and-quota]] | How token usage is *already* tracked (`~/.proxy-logs/requests.jsonl`, `/admin/overview`, `/api/oauth/usage`), the **"OpenClaw burned the Claude quota" incident**, and the proposed Supercalm usage page + 80% alert. |
| [[cross-model-continuity]] | "Can I run Claude Code on Gemini/qwen?" — the Anthropic-vs-OpenAI API mismatch, the translation-bridge plan, the idle Google-Ultra fallback, and the zero-build stopgap (codex/agy sessions). |
| [[infra-and-networking]] | host (the always-on Mac), Tailscale Serve routing (`/aios` on 443, additive to the off-limits proxy root), how Supercalm is deployed/run, and the bind model (why Supercalm is `127.0.0.1`-only). |
| [[release-system]] | Versioning (one source: `package.json`), the two release paths (`bin/deploy` every-release vs `bin/release` stable), **release channels + the new-version toast** (Stable only / Every release / Off), the headless `GITHUB_PAT_AIOS` push, and the forthcoming **autonomous integrate-&-deploy** pipeline. **Start here for deploy/release.** |
| [[runbook-host-unreachable]] | **Ops runbook.** The diagnostic methodology that distinguishes *app-down* vs *machine-down* vs *network-path*, the **"host asleep" incident** (control-plane up, data-plane dead), and the robust never-sleep + self-heal fix. |
| [[design-decisions]] | ADR-style log of every architecture decision + open question from these conversations, with the reasoning and current status. |
| [[supervisor-agent-full-review-2026-06-25]] | Full product/architecture review of the Supervisor agent: prompts, learning, context, rules, state, UI transparency, design debt, and the recommended refactor path. |
| [[supervisor-comprehensive-refactor-contract]] | Controlling contract for the full Supervisor redesign: one complete refactor program with workstreams, dependency rules, and definition of done. |

## Pre-existing subsystems (depth lives in [`CLAUDE.md`](../../CLAUDE.md))
Voice concierge + TTS, the decision log (`/aios/decisions`), per-session orchestration
(`ultracode`/`workflow`), the detection state-machine, and resume — all predate this wiki and are
documented in `CLAUDE.md`. They're referenced here where auth/usage/infra touches them.

---

## The one-paragraph orientation
Supercalm supervises CLI coding agents (claude/codex/agy) in tmux on **host**, surfaces ones waiting for
input, and lets the user answer by voice/text from any tailnet device. It is a **consumer** of two
things it does not own: the **model-proxy fleet** ([[proxy-fleet]]) that turns each CLI subscription
into a local model endpoint, and the **auth** ([[auth-architecture]]) those endpoints need. The
through-line of 2026-06 was making auth *robust and portable* (one login, no 8-hour expiry, works
with or without a proxy) and gaining *visibility + continuity* over a finite, exhaustible token
budget ([[usage-and-quota]], [[cross-model-continuity]]).
