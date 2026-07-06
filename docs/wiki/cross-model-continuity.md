# Cross-Model Continuity — "Can I run Claude Code on Gemini / qwen?"

*When the Anthropic quota is exhausted, can you keep using the **Claude Code harness** on a different
model? Short answer: not directly (API mismatch), but yes via a translation bridge — and there's a
zero-build stopgap.*
**Status:** 🔵 Bridge proposed (not built). Immediate fallback (codex/agy) ✅ available now.

See also: [[proxy-fleet]] · [[usage-and-quota]] · [[auth-architecture]] · [[design-decisions]]

---

## The wall (⛔ the core constraint)
- **Claude Code speaks only the Anthropic `/v1/messages` API.**
- In the fleet, **only the claude proxy (8789) serves that** — and it's backed by Anthropic, i.e. the
  quota that ran out.
- gemini / qwen / codex proxies are **OpenAI-compatible** (`/v1/chat/completions`) — a different request/
  response shape. Claude Code can't point `ANTHROPIC_BASE_URL` at them as-is.

⟹ To run the Claude Code harness on a non-Claude model you need an **Anthropic ↔ OpenAI translation
bridge** in front of the OpenAI endpoints the fleet already exposes.

## Live capacity check (2026-06)
- **antigravity (Google Ultra) is UP and idle** — `gemini-3-flash-agent` (Gemini 3.5 Flash High) answered
  fine. This is the user's already-paid $250/mo quota the proxy notes call "wasted if unused." **Best
  bridge target.**
- antigravity Ultra also serves **Claude Opus/Sonnet 4.6** → a bridge could run Claude Code on *Claude
  4.6 via the Ultra quota* (closest to native) instead of Gemini.
- codex (gpt-5.5) and aliyun (qwen) are up too (qwen model ids vary — `qwen3-max` 404'd; check
  `/admin/overview`).

## Three options
1. 🔵 **Translation bridge (the real ask).** Extend the `src/auth/` shim ([[auth-architecture]] §5) into
   an Anthropic-`/v1/messages` front end that translates to the fleet's OpenAI `/v1/chat/completions`
   and back (incl. tool-use + streaming SSE), routing to antigravity (Gemini, or Claude 4.6 via Ultra)
   or aliyun (qwen). Set `ANTHROPIC_BASE_URL` → the bridge. High value (keeps the Claude harness), real
   work — Anthropic↔OpenAI tool/stream translation is finicky. On-brand with the shim we already have.
   *Existing routers (claude-code-router / y-router) do this but add a non-vanilla dependency.*
2. ✅ **Immediate stopgap (zero build):** run the task in a **codex (gpt-5.5)** or **agy (Gemini)** Supercalm
   session — separate subscriptions, available right now. You lose the Claude harness, not momentum.
3. **Switch model family within Claude:** not possible while Anthropic is out, since Anthropic is the
   only native `/v1/messages` backend.

## Recommendation
For continuity *today*, option 2. To preserve the Claude Code harness specifically, build option 1
pointed at the idle Ultra quota. (The priority between this and the [[usage-and-quota]] page was the
open question when the conversation was interrupted — see [[design-decisions]].)
