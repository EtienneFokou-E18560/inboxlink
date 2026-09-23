#!/usr/bin/env bash
# Create an InboxLink Connect session (any host).
# Requires: curl, jq (optional — falls back to raw JSON).
set -euo pipefail

# Default to documented Production. Override for local InboxLink.
BASE_URL="${INBOXLINK_BASE_URL:-https://inboxlink-two.vercel.app}"
# Optional — only required when the server runs INBOXLINK_MODE=multi.
API_SECRET="${INBOXLINK_API_SECRET:-}"
EXTERNAL_USER_ID="${EXTERNAL_USER_ID:-host-user-1}"
# Your host's post-Connect callback — InboxLink appends public_token & link_token.
# Use a URL you control (not example.com). Google OAuth redirect stays on InboxLink.
REDIRECT_URI="${REDIRECT_URI:-http://127.0.0.1:9999/done}"

BODY=$(printf '{"externalUserId":"%s","redirectUri":"%s","products":["messages"]}' \
  "$EXTERNAL_USER_ID" "$REDIRECT_URI")

AUTH_HEADERS=()
if [[ -n "$API_SECRET" ]]; then
  AUTH_HEADERS=(-H "authorization: Bearer ${API_SECRET}")
fi

RESP=$(curl -sS -X POST "${BASE_URL%/}/v1/link/sessions" \
  "${AUTH_HEADERS[@]}" \
  -H "content-type: application/json" \
  -d "$BODY")

if command -v jq >/dev/null 2>&1; then
  echo "$RESP" | jq .
  echo
  echo "Open connectUrl:"
  echo "$RESP" | jq -r .connectUrl
else
  echo "$RESP"
  echo
  echo "(Install jq to pretty-print; look for connectUrl in the JSON above.)"
fi
