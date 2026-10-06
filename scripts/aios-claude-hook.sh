#!/usr/bin/env bash
# Supercalm claude lifecycle hook. Claude pipes typed lifecycle events and task snapshots on stdin.
# We POST the event to Supercalm so working/waiting detection is instant.
#
# Contract: MUST fail-open. Never block, never delay claude. Only exit 0. The curl is backgrounded with
# closed FDs and a sub-second timeout so a slow/down Supercalm can't stall the agent at fleet scale.
[ -n "${AIOS_URL:-}" ] || exit 0
[ -n "${AIOS_SESSION_ID:-}" ] || exit 0

input="$(cat 2>/dev/null || true)"
payload="$(printf '%s' "$input" | jq -c --arg session "$AIOS_SESSION_ID" '
  select(type == "object" and (.hook_event_name | type == "string")) |
  {session:$session, event:.hook_event_name, native_session_id:.session_id,
   transcript:.transcript_path, message:(.message // ""),
   notification_type, last_assistant_message, background_tasks, session_crons,
   error, error_details, agent_id, source, tool_name, tool_use_id, elicitation_id, url, action,
   tool_input:(if .tool_input then {description:.tool_input.description,command:.tool_input.command,file_path:.tool_input.file_path} else null end),
   sent_at:(now * 1000 | floor)} |
  with_entries(select(.value != null))
' 2>/dev/null || true)"
[ -n "$payload" ] || exit 0

curl -sS --connect-timeout 0.3 --max-time 1 -H 'content-type: application/json' \
  -d "$payload" "$AIOS_URL/api/hook/claude" </dev/null >/dev/null 2>&1 &
exit 0
