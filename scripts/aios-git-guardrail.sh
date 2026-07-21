#!/usr/bin/env bash
# Supercalm git guardrail — a claude PreToolUse(Bash) hook that DENIES a small set of irreversible /
# destructive commands. BEST-EFFORT (not a security boundary): a determined agent can evade it; it
# catches the common foot-guns. Ships behind the gitGuardrails flag (default OFF).
#
# Fail-open: any parse problem -> exit 0 (no decision; normal permission flow applies). A deny is
# emitted as PreToolUse JSON on stdout with exit 0.
input="$(cat 2>/dev/null || true)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

# collapse newlines/tabs/runs of spaces so multi-line commands match
norm="$(printf '%s' "$cmd" | tr '\n\t' '  ' | tr -s ' ')"
m() { printf '%s' "$norm" | grep -Eq "$1"; }

reason=""
# force / mirror push (allow the safe --force-with-lease)
if m '(^|[;&| ])git( +-[A-Za-z]+| +-C +[^ ]+)* +push' \
   && m '(--force([^-=]|$)|[ ]-f([ ]|$)|--mirror)' \
   && ! printf '%s' "$norm" | grep -Eq -- '--force-with-lease'; then
  reason="force/mirror push"
fi
[ -z "$reason" ] && m 'git( +-C +[^ ]+)* +reset +--hard'           && reason="reset --hard (discards work)"
[ -z "$reason" ] && m 'git( +-C +[^ ]+)* +clean +-[A-Za-z]*[fF]'    && reason="git clean (removes untracked files)"
[ -z "$reason" ] && m 'git +checkout +(-- +)?\.([ ]|$)'             && reason="mass checkout discard"
[ -z "$reason" ] && m 'git +restore( +[^ ]+)* +\.([ ]|$)'           && reason="git restore . (discards changes)"
[ -z "$reason" ] && m 'git( +-C +[^ ]+)* +branch +-D'               && reason="branch -D (force delete)"
[ -z "$reason" ] && m 'git +update-ref +-d'                         && reason="update-ref -d (deletes refs)"
[ -z "$reason" ] && m 'git +reflog +expire'                         && reason="reflog expire (drops recovery)"
[ -z "$reason" ] && m 'git +gc +.*--prune=now'                      && reason="gc --prune=now"
[ -z "$reason" ] && m 'rm +-[rfRF]+ +[^ ]*\.git([ /]|$)'            && reason="removing .git"

# --- deploy-source guardrail (opt-in: active only when a release contract was injected at launch) --------
# Prevents the wrong-tree/wrong-branch deploy class (2026-07-17 OpenHand: a Pages deploy from the main
# checkout on the old branch served the old UI for 3 days). Best-effort + FAIL-OPEN: scoped to DIRECT deploy
# tools whose source IS the cwd (wrangler/vercel/netlify — NOT opaque `npm run deploy`), and any ambiguity
# (explicit dir arg, unresolvable path) -> allow, so a legitimate deploy is never blocked.
if [ -z "$reason" ] && [ -n "${AIOS_DEPLOY_SOURCE_DIR:-}" ] \
   && m '(^|[;&| ])(wrangler +(pages +)?deploy|vercel( +(deploy|--prod|-p)|$)|netlify +deploy)([ ]|$)'; then
  if printf '%s' "$norm" | grep -Eq -- '--(dir|cwd)[ =]|deploy +[^-][^ ]*/'; then
    : # explicit target dir on the command -> can't judge the source safely -> allow (fail-open)
  else
    cdd="$(printf '%s' "$norm" | sed -nE 's/^[[:space:]]*cd[[:space:]]+([^ ;&|]+).*/\1/p')"
    eff="${cdd:-$(pwd)}"
    effr="$(cd "$eff" 2>/dev/null && pwd -P || true)"
    srcr="$(cd "$AIOS_DEPLOY_SOURCE_DIR" 2>/dev/null && pwd -P || true)"
    if [ -n "$effr" ] && [ -n "$srcr" ]; then
      case "$effr/" in
        "$srcr/"*) : ;; # deploying from the declared product tree (or a subdir) -> OK
        *) reason="deploy from '$effr', but this project deploys ONLY from '$srcr' (Supercalm release contract). cd into the product tree first, or fix the contract in Projects." ;;
      esac
    fi
    if [ -z "$reason" ] && [ -n "${AIOS_DEPLOY_BRANCH:-}" ] && [ -n "$effr" ]; then
      br="$(git -C "$effr" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
      [ -n "$br" ] && [ "$br" != "$AIOS_DEPLOY_BRANCH" ] \
        && reason="deploy while on branch '$br', but this project deploys ONLY from '$AIOS_DEPLOY_BRANCH' (Supercalm release contract). Switch branches first."
    fi
  fi
fi

if [ -n "$reason" ]; then
  msg="Supercalm guardrail blocked: $reason. This is irreversible — use a safer alternative, or ask the operator to disable Supercalm git guardrails."
  jq -nc --arg r "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}' 2>/dev/null \
    || printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Supercalm guardrail blocked an irreversible git command"}}'
fi
exit 0
