#!/usr/bin/env bash
# Supercalm claude lifecycle hook. claude runs this on Stop / Notification / UserPromptSubmit and pipes the
# hook JSON on stdin. We POST the event to Supercalm so working/waiting detection is instant.
#
# Contract: MUST fail-open. Never block, never delay claude. Only exit 0. The curl is backgrounded with
# closed FDs and a sub-second timeout so a slow/down Supercalm can't stall the agent at fleet scale.
[ -n "${AIOS_URL:-}" ] || exit 0
[ -n "${AIOS_SESSION_ID:-}" ] || exit 0

input="$(cat 2>/dev/null || true)"
event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
[ -n "$event" ] || exit 0
msg="$(printf '%s' "$input" | jq -r '.message // .prompt // empty' 2>/dev/null || true)"

payload="$(jq -nc --arg session "$AIOS_SESSION_ID" --arg event "$event" --arg message "$msg" \
  '{session:$session,event:$event,message:$message}' 2>/dev/null || true)"
[ -n "$payload" ] || exit 0

curl -sS --connect-timeout 0.3 --max-time 1 -H 'content-type: application/json' \
  -d "$payload" "$AIOS_URL/api/hook/claude" </dev/null >/dev/null 2>&1 &
exit 0
