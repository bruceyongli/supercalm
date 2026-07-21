# General deploy/release safety — for ANY project AIOS supervises

## Why
AIOS supervises coding agents that deploy **their own** projects (Cloudflare Pages/Workers, Vercel, npm,
docker, `bin/deploy`, …). AIOS's autonomous pipeline is AIOS-self-only and always will be (a universal
deploy executor is out of scope) — but the **safety layer must be general**. The 2026-07-17 OpenHand
incident: an agent ran a Pages deploy from the **wrong tree** (its cwd `/Users/bb1/openhand/share` on the
old `codex/new-ui-ux-parity` branch) instead of the product tree `/var/tmp/oh-build/packages/web`; the old
UI served for **3 days undetected**. Root failure classes, all project-agnostic:

| Class | Failure | Layer |
|---|---|---|
| A. Wrong source | deploy from the wrong dir/branch | **prevention** (guardrail) |
| B. Undetected stale | deployed, but the live surface didn't move / served old build | **detection** (monitor) |
| C. Isolation gap | `isolation:1` but sessions share one checkout (predate it) → clobber | **surfacing** |
| D. Config nonsense | `auto_publish:1` on a project the pipeline can't serve (share, proxy) | **sanity** |

## One config, per project — `release_targets`
Declarative, operator-owned (modelled on `project_context`): `{ live_url, expect, forbid, source_dir,
source_branch, interval_sec, enabled }` + status columns. Feeds BOTH mechanisms below. Nothing
project-specific in code — the project declares its own truth.

## Slice 1 — Release-health monitor (detection; the 3-day-blindness fix) — SHIP FIRST
`src/release_monitor.js`: poll `live_url` on `interval_sec` (+ on demand + after a detected deploy), assert
`expect` present and `forbid` absent in the live response. Transition to `stale`/`down` (debounced) →
`bus.emit('notify')` + event, surfaced on the project. Recovery clears it. Fail-open (network error =
`down`, alert once, never crash). Prefer the **direct deployment URL** over the cached custom domain
(edge-cache gotcha). This alone turns "3 days" into "one interval".
- Routes: `GET/POST /api/project/:id/release`, `POST /api/project/:id/release/check`.

## Slice 2 — Deploy-source guardrail (prevention)
Extend the git-guardrail PreToolUse(Bash) hook: recognize deploy commands (`wrangler … deploy`,
`pages deploy`, `bin/deploy`, `npm|pnpm|yarn run deploy`, `vercel`, `netlify deploy`, `gcloud … deploy`)
and DENY when `pwd` ≠ `source_dir` or the current git branch ≠ `source_branch`. The contract is injected as
env (`AIOS_DEPLOY_SOURCE_DIR`/`AIOS_DEPLOY_BRANCH`) at launch (like the other launch-scoped hooks); the hook
reads pwd + `git rev-parse --abbrev-ref HEAD`. Fires under `--dangerously-skip-permissions`. Best-effort
(agent can evade) — catches the foot-gun. Fail-open.

## Slice 3 — Config sanity + isolation surfacing
- `auto_publish`: `helperEnabled(pid,'autoPublish')` returns false unless the project is self-deployable
  (sameRepo AIOS) OR has a valid release target with a source contract; the toggle is refused server-side
  with a clear reason, so it can't give false "autonomous deploy is handling this". Clear it off share/proxy.
- Isolation gap: `/api/state` / the project view flags **live sessions whose `worktree_path` is null while
  the project has `isolation:1`** ("N sessions not isolated — launched before isolation; share one tree").
  Optionally retrofit a worktree on resume. Stops "isolation on" giving false safety.

## Non-goals
Universal deploy executor; deploying non-AIOS projects through the AIOS pipeline; auto-fixing a project's
deploy scripts. AIOS provides the *guardrail + monitor + surfacing*; the project's own agent deploys.

## Critique — self-review (fleet proxy timed out twice; applied the hardening a critique would raise)
- **Monitor false-alarms**: require **N consecutive bad checks** (debounce, default 2) before alerting;
  distinguish `down` (fetch failed/timeout) from `stale` (fetched OK but marker missing); **alert once** per
  bad episode (tag), and emit a `recovered` event when it clears. Never crash — fail-open to `unknown`.
- **SSRF / abuse**: operator-set URLs only, but still bound to `http(s)`, hard fetch **timeout**, **response
  size cap** (read ≤512 KB), `redirect: 'manual'`-ish (don't chase cross-host redirects blindly), no creds.
- **Edge-cache gotcha**: append a cache-buster + `cache-control: no-store`; doc that the **direct deployment
  URL** beats the CDN-cached custom domain.
- **Guardrail**: `realpath` both sides of the cwd compare (symlinks); best-effort only (documented — an agent
  can `cd`/evade); fail-open on any parse issue; injected env is per-launch and rebuilt on resume like the
  other launch flags.
- **Slice order**: Monitor (detection) first — it's the safety net that would have caught THIS incident and
  is the least likely to false-block; guardrail (prevention) second; config-sanity third.
