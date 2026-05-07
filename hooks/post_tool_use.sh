#!/usr/bin/env bash
# Nexus Provenance — PostToolUse hook
# Fires after every tool call. Posts a tool node to the graph service.
# Claude Code passes JSON on stdin; we fire-and-forget to localhost:7702.

set -euo pipefail

INPUT="$(cat)"

SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"')"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""')"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Map Claude Code tool names to Nexus node types
case "$TOOL_NAME" in
  WebSearch|web_search)       NODE_TYPE="web_search" ;;
  WebFetch|web_fetch)         NODE_TYPE="web_fetch" ;;
  Read|read|cat)              NODE_TYPE="file_read" ;;
  Write|Edit|write|edit)      NODE_TYPE="file_read" ;;
  Bash|bash|Shell)            NODE_TYPE="bash" ;;
  Agent|agent|SubAgent)       NODE_TYPE="agent" ;;
  *)                          NODE_TYPE="bash" ;;
esac

# Extract tool response content — handle both string and object responses
TOOL_RESPONSE="$(printf '%s' "$INPUT" | jq -r '
  if .tool_response | type == "string" then .tool_response
  elif .tool_response | type == "object" then (.tool_response | tostring)
  else ""
  end
')"

# Truncate very large responses to 32 KB to keep DB manageable
CONTENT="${TOOL_RESPONSE:0:32768}"

PAYLOAD="$(jq -n \
  --arg session_id "$SESSION_ID" \
  --arg type "$NODE_TYPE" \
  --arg tool_name "$TOOL_NAME" \
  --arg content "$CONTENT" \
  --arg timestamp "$TIMESTAMP" \
  --arg cwd "$CWD" \
  '{
    session_id: $session_id,
    type: $type,
    tool_name: $tool_name,
    content: $content,
    timestamp: $timestamp,
    cwd: (if $cwd == "" then null else $cwd end)
  }')"

# Fire-and-forget
curl -s -f -X POST "http://localhost:7702/node" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 2 \
  >/dev/null 2>&1 &

exit 0
