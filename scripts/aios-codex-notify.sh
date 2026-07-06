#!/usr/bin/env bash
# Supercalm codex notify program. codex invokes it with a single JSON argument ($1) on lifecycle events
# (e.g. {"type":"agent-turn-complete",...}). We POST the event type to Supercalm for instant detection.
# Fail-open: only exit 0; backgrounded curl with closed FDs and sub-second timeout.
[ -n "${AIOS_URL:-}" ] || exit 0
[ -n "${AIOS_SESSION_ID:-}" ] || exit 0

event="$(printf '%s' "${1:-}" | jq -r '.type // .event // empty' 2>/dev/null || true)"
[ -n "$event" ] || exit 0

payload="$(jq -nc --arg session "$AIOS_SESSION_ID" --arg event "$event" \
  '{session:$session,event:$event}' 2>/dev/null || true)"
[ -n "$payload" ] || exit 0

curl -sS --connect-timeout 0.3 --max-time 1 -H 'content-type: application/json' \
  -d "$payload" "$AIOS_URL/api/hook/codex" </dev/null >/dev/null 2>&1 &
exit 0
