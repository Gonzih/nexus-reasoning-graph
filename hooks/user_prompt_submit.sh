#!/usr/bin/env bash
# Nexus Provenance — UserPromptSubmit hook
# Fires when the user submits a prompt. Posts an "intent" node to the graph service.
# Claude Code passes JSON on stdin; we fire-and-forget to localhost:7702.

set -euo pipefail

INPUT="$(cat)"

SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"
PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // ""')"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build payload with jq to avoid injection
PAYLOAD="$(jq -n \
  --arg session_id "$SESSION_ID" \
  --arg content "$PROMPT" \
  --arg timestamp "$TIMESTAMP" \
  '{
    session_id: $session_id,
    type: "intent",
    tool_name: null,
    content: $content,
    timestamp: $timestamp
  }')"

# Fire-and-forget; never block Claude Code
curl -s -f -X POST "http://localhost:7702/node" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 2 \
  >/dev/null 2>&1 &

# Always exit 0 so Claude Code is never blocked by this hook
exit 0
