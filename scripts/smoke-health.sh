#!/usr/bin/env bash
# Smoke-check InboxLink health on a deployed (or local) base URL.
# Default: require store=postgres (Production-safe). Pass --allow-memory for local.
set -euo pipefail

BASE="${BASE_URL:-${1:-}}"
ALLOW_MEMORY=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --allow-memory) ALLOW_MEMORY=1 ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) ARGS+=("$arg") ;;
  esac
done
if [[ -z "$BASE" ]]; then
  BASE="${ARGS[0]:-}"
fi
if [[ -z "$BASE" ]]; then
  echo "usage: BASE_URL=https://… $0 [--allow-memory]" >&2
  echo "   or: $0 <base-url> [--allow-memory]" >&2
  exit 2
fi
BASE="${BASE%/}"

fail=0
for path in / /health /health/; do
  url="${BASE}${path}"
  echo "=== GET ${path} ==="
  body="$(curl -sS -f -w "\nHTTP %{http_code}\n" "$url")" || {
    echo "FAIL: request error for ${url}" >&2
    fail=1
    continue
  }
  echo "$body"
  json="$(echo "$body" | sed '$d')"
  code="$(echo "$body" | tail -n1 | awk '{print $2}')"
  if [[ "$code" != "200" ]]; then
    echo "FAIL: expected HTTP 200, got ${code}" >&2
    fail=1
    continue
  fi
  ok="$(echo "$json" | sed -n 's/.*"ok"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n1)"
  store="$(echo "$json" | sed -n 's/.*"store"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [[ "$ok" != "true" ]]; then
    echo "FAIL: ok is not true" >&2
    fail=1
  fi
  if [[ "$ALLOW_MEMORY" -eq 0 && "$store" != "postgres" ]]; then
    echo "FAIL: store=${store:-missing} (want postgres). Set DATABASE_URL or pass --allow-memory." >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "smoke-health: FAILED" >&2
  exit 1
fi
echo "smoke-health: OK (${BASE})"
