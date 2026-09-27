#!/usr/bin/env bash
# InboxLink proof / contributor smoke curls.
# Never prints or requires refresh tokens. Do not commit command output that
# contains public_token or API secrets.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
BASE_URL="${BASE_URL%/}"
EXTERNAL_USER_ID="${EXTERNAL_USER_ID:-proof-user-1}"
REDIRECT_URI="${REDIRECT_URI:-https://example.com/oauth-done}"
AUTH_HEADER=()

if [[ -n "${INBOXLINK_API_SECRET:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${INBOXLINK_API_SECRET}")
fi

usage() {
  cat <<EOF
Usage: $(basename "$0") [health|session|exchange|grants|messages|revoke|all]

Env:
  BASE_URL            API origin (default http://localhost:8787)
  EXTERNAL_USER_ID    Host user id (default proof-user-1)
  REDIRECT_URI        Post-Connect redirect (default https://example.com/oauth-done)
  INBOXLINK_API_SECRET  Bearer when INBOXLINK_MODE=multi (required for Production)
  PUBLIC_TOKEN        Required for: exchange
  GRANT_ID            Required for: messages, revoke

Examples:
  ./scripts/proof-curl.sh
  BASE_URL=https://inboxlink-two.vercel.app ./scripts/proof-curl.sh health
  BASE_URL=https://inboxlink-two.vercel.app INBOXLINK_API_SECRET=… ./scripts/proof-curl.sh session
  PUBLIC_TOKEN=… ./scripts/proof-curl.sh exchange
  GRANT_ID=grant_… ./scripts/proof-curl.sh messages
EOF
}

cmd_health() {
  echo "=== health ==="
  for p in / /health /health/; do
    echo "--- $p ---"
    curl -sS -w "\nHTTP %{http_code}\n" "${AUTH_HEADER[@]}" "${BASE_URL}${p}" || true
    echo
  done
}

cmd_session() {
  echo "=== create link session ==="
  curl -sS -X POST "${BASE_URL}/v1/link/sessions" \
    -H "content-type: application/json" \
    "${AUTH_HEADER[@]}" \
    -d "{\"externalUserId\":\"${EXTERNAL_USER_ID}\",\"redirectUri\":\"${REDIRECT_URI}\",\"products\":[\"messages\"]}"
  echo
  echo
  echo "Next: open connectUrl in a browser, complete Google Connect, then:"
  echo "  PUBLIC_TOKEN=<from redirect> $0 exchange"
}

cmd_exchange() {
  if [[ -z "${PUBLIC_TOKEN:-}" ]]; then
    echo "Set PUBLIC_TOKEN from the Connect redirect query string." >&2
    exit 1
  fi
  echo "=== exchange public_token ==="
  curl -sS -X POST "${BASE_URL}/v1/grants/exchange" \
    -H "content-type: application/json" \
    "${AUTH_HEADER[@]}" \
    -d "{\"publicToken\":\"${PUBLIC_TOKEN}\"}"
  echo
}

cmd_grants() {
  echo "=== list grants ==="
  curl -sS "${AUTH_HEADER[@]}" \
    "${BASE_URL}/v1/grants?externalUserId=${EXTERNAL_USER_ID}"
  echo
}

cmd_messages() {
  if [[ -z "${GRANT_ID:-}" ]]; then
    echo "Set GRANT_ID from exchange or list grants." >&2
    exit 1
  fi
  echo "=== list messages ==="
  curl -sS -w "\nHTTP %{http_code}\n" "${AUTH_HEADER[@]}" \
    "${BASE_URL}/v1/grants/${GRANT_ID}/messages?limit=5"
  echo
}

cmd_revoke() {
  if [[ -z "${GRANT_ID:-}" ]]; then
    echo "Set GRANT_ID to revoke." >&2
    exit 1
  fi
  echo "=== revoke grant ==="
  curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X DELETE \
    "${AUTH_HEADER[@]}" \
    "${BASE_URL}/v1/grants/${GRANT_ID}"
}

cmd_all() {
  cmd_health
  cmd_session
  echo
  echo "Browser step required before exchange/messages/revoke."
  echo "Re-run with: PUBLIC_TOKEN=… $0 exchange"
}

main() {
  local action="${1:-all}"
  case "$action" in
    -h|--help|help) usage ;;
    health) cmd_health ;;
    session) cmd_session ;;
    exchange) cmd_exchange ;;
    grants) cmd_grants ;;
    messages) cmd_messages ;;
    revoke) cmd_revoke ;;
    all) cmd_all ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
