# Usage & Quota Monitoring

*"80% of my usage burned without any knowledge of how." The data to explain it already exists in the
proxy; Supercalm needs to **surface** it. Includes the incident post-mortem (what actually burned the Claude
quota) and the proposed Supercalm usage page.*
**Status:** 🟡 Data sources confirmed; Supercalm usage page **proposed, not yet built**. Trigger: Anthropic quota exhausted.

See also: [[proxy-fleet]] · [[cross-model-continuity]] · [[design-decisions]]

---

## The incident (2026-06, post-mortem)
The user reported 80% of usage gone with no visibility. Investigation of `~/.proxy-logs/requests.jsonl`
found the Anthropic quota was in fact **fully exhausted** — the latest claude request failed with:
```
Anthropic /v1/messages failed (400): "You're out of extra usage. Add more at claude.ai/settings/usage…"
```
**The culprit, visible in the ledger:** an agent identifying as **"OpenClaw"** (a personal-assistant
harness — *not* Supercalm) calling **`claude-opus-4`** with **~265,000-character system prompts**. Opus at
that context size is the most expensive call there is; a handful drains a plan. The ledger captured the
model, token counts, cost, **and the request body** — i.e. exactly which app made each call.

**Lesson:** burn was invisible only because nobody was *looking* at the ledger that already exists. The
fix is surfacing + alerting, not new tracking.

## Where the data lives (all already in the fleet — [[proxy-fleet]])
| Source | What it gives | Scope |
|---|---|---|
| `~/.proxy-logs/requests.jsonl` | per-request `usage{prompt,completion,cached,reasoning,total,cacheWrite}` + `cost{…}` + `model` + `request` body | everything that goes **through the proxy** |
| `GET 8791/admin/overview` | per-provider live status + **quota** + per-model official price + capabilities | fleet-wide snapshot |
| `GET 8789/api/oauth/usage` | the **Claude subscription window %** (the real "80%") | claude only; needs `user:profile` scope |
| `GET <proxy>/admin/quota` | `remainingFraction` + `resetTime` (antigravity exposes this) | per-provider |
| `8791/admin/dashboard` | human dashboard: Subscription Usage / Request Records / Overview | fleet-wide |

⚠️ **Coverage caveat:** the ledger only sees traffic **through the proxy**. Supercalm claude sessions *do* go
through the proxy (mode `proxy`), so they're covered. Anything calling Anthropic directly (a stray CLI,
another machine) is not — note that gap if/when building the page.

## Proposed Supercalm usage page (the user's ask: "monitor all token usage for all CLI/subscriptions")
- **Read the ledger** (`requests.jsonl`) → aggregate burn by **app / model / time / cost**; attribute it
  (the `request` body reveals the source harness, e.g. "OpenClaw").
- **Per-provider subscription %** from `/admin/overview` + `/api/oauth/usage` + `/admin/quota`, with
  reset windows.
- **Push alert at ~80%** (reuse the existing web-push plumbing) so exhaustion never blindsides again.
- Lives alongside the existing `/aios/records` (messages) + `/aios/decisions` pages.

## Practical guidance baked in
- Opus 4.8 at huge context = the dominant cost driver — watch system-prompt size, not just call count.
- For cheap/idle capacity, prefer **antigravity Gemini** (already-paid Ultra, idle = wasted) over
  metered paths — see the routing default in [[proxy-fleet]].
- Pricing in `shared/pricing.js` is "what it *would* cost" on official APIs (today everything is
  subscription-reuse, so per-call cost is $0) — useful as a relative burn signal, not a real bill.
