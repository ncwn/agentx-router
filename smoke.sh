#!/usr/bin/env bash
# smoke.sh [MODE] — connectivity check against the running router (single port).
# If MODE is given, switches to it first. Sends a tiny non-streaming
# /v1/messages for the opus + sonnet tiers and reports HTTP status + a snippet.
# Watch the ROUTER's stderr to confirm each request routed where you expect
# (native / gpt55 / gpt54). This proves the request path + auth — NOT tool-use
# fidelity (for that, run a real `claude` agentic task).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${AGENTX_PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
BODY_FILE="$(mktemp -t agentx_smoke.XXXXXX)"
trap 'rm -f "$BODY_FILE"' EXIT

if [ -n "${1:-}" ]; then
  "$HERE/agentx-mode" "$1" >/dev/null
  echo "switched to mode: $(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
fi

probe() {
  local model="$1"
  echo "── $model  ($BASE) ─────────────────────────────"
  curl -sS -o "$BODY_FILE" -w "HTTP %{http_code}\n" "$BASE/v1/messages" \
    -H 'content-type: application/json' \
    -H 'anthropic-version: 2023-06-01' \
    -H 'authorization: Bearer router-managed' \
    -d "{\"model\":\"$model\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: AGENTX_OK\"}]}" \
    || echo "curl failed"
  head -c 600 "$BODY_FILE" 2>/dev/null; echo
}

echo "Smoke test against $BASE  (router must be running: ./agentx-up)"
probe "claude-opus-4-8"
probe "claude-sonnet-4-6"
