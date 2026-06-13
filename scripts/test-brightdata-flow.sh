#!/usr/bin/env bash
# Bright Data end-to-end flow test (MCP + live view + optional execute API)
#
# Usage:
#   BRIGHTDATA_AUTH='brd-customer-XXX-zone-YYY:password' \
#   BRIGHTDATA_COUNTRY=ae \
#     bash scripts/test-brightdata-flow.sh
#
# Optional:
#   MCP_PORT=8091 LIVE_PORT=6081
#   EXECUTE_URL=http://localhost:3000/admin/v1/execute
#   PROMPT="Go to bayut.com and take a snapshot"
#   SKIP_EXECUTE=1   # only start MCP + live view
#
# Opens:
#   Live view  -> http://localhost:$LIVE_PORT/
#   MCP        -> http://localhost:$MCP_PORT/mcp
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIGHTDATA_AUTH="${BRIGHTDATA_AUTH:-}"
BRIGHTDATA_USER="${BRIGHTDATA_USER:-}"
BRIGHTDATA_PASS="${BRIGHTDATA_PASS:-}"

if [ -z "$BRIGHTDATA_AUTH" ] && { [ -z "$BRIGHTDATA_USER" ] || [ -z "$BRIGHTDATA_PASS" ]; }; then
  echo "Set BRIGHTDATA_AUTH or BRIGHTDATA_USER+BRIGHTDATA_PASS" >&2
  exit 1
fi

MCP_PORT="${MCP_PORT:-8091}"
LIVE_PORT="${LIVE_PORT:-6081}"
EXECUTE_URL="${EXECUTE_URL:-http://localhost:3000/admin/v1/execute}"
PROMPT="${PROMPT:-Go to https://www.bayut.com/ and take a snapshot. Report the page title and whether you see a captchaChallenge redirect.}"
SKIP_EXECUTE="${SKIP_EXECUTE:-0}"

export BRIGHTDATA_AUTH BRIGHTDATA_USER BRIGHTDATA_PASS BRIGHTDATA_COUNTRY BRIGHTDATA_HOST BRIGHTDATA_PORT

CHROME_WS_ENDPOINT="$(node "$ROOT/scripts/brightdata-config.mjs" --print-endpoint)"
export CHROME_WS_ENDPOINT

echo "[bd-flow] Bright Data Browser API flow test"
echo "[bd-flow] ws endpoint host: $(printf '%s' "$CHROME_WS_ENDPOINT" | sed 's|:.*@|:***@|')"
echo ""

SCREENCAST_PORT="$LIVE_PORT" node "$ROOT/scripts/screencast-bridge.mjs" >/tmp/bd-screencast.log 2>&1 &
LIVE_PID=$!

node "$ROOT/node_modules/.bin/mcp-proxy" \
  --port "$MCP_PORT" --host 0.0.0.0 --server stream --stateless -- \
  node "$ROOT/build/src/bin/chrome-devtools-mcp.js" \
  --wsEndpoint "$CHROME_WS_ENDPOINT" \
  --experimental-vision \
  &
MCP_PID=$!

cleanup() {
  kill "$MCP_PID" "$LIVE_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 4
echo "╔══════════════════════════════════════════════════════════════╗"
echo "  LIVE VIEW  : http://localhost:${LIVE_PORT}/"
echo "  MCP        : http://localhost:${MCP_PORT}/mcp"
echo "  (open live view for human OTP/CAPTCHA takeover)"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [ "$SKIP_EXECUTE" = "1" ]; then
  echo "[bd-flow] SKIP_EXECUTE=1 — press Ctrl+C to stop"
  wait "$MCP_PID"
  exit 0
fi

SESSION_ID="bd-flow-$(date +%s)"
echo "[bd-flow] Dispatching prompt to ${EXECUTE_URL} ..."
curl -s -X POST "$EXECUTE_URL" \
  --header 'Content-Type: application/json' \
  --data "$(jq -n \
    --arg prompt "$PROMPT" \
    --arg session_id "$SESSION_ID" \
    --arg mcp_port "$MCP_PORT" \
    '{
      prompt: $prompt,
      provider: "gcp_vertex_ai",
      model: "gemini-3.5-flash",
      company_id: "smoke-test-company",
      session_id: $session_id,
      message_id: "msg-bd-flow-001",
      speed: "",
      effort: "high",
      file_urls: [],
      mcp_port: $mcp_port
    }')" | jq '.'

echo ""
echo "[bd-flow] Running. Live view: http://localhost:${LIVE_PORT}/"
echo "Press Ctrl+C to stop."
wait "$MCP_PID"
