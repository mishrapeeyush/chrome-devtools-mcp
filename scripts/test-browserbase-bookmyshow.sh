#!/usr/bin/env bash
# Browserbase + BookMyShow end-to-end test via on-demand-goose-execution.
#
# Usage:
#   BROWSERBASE_API_KEY=xxx BROWSERBASE_PROJECT_ID=xxx bash scripts/test-browserbase-bookmyshow.sh
#
# Optional env:
#   EXECUTE_URL   (default http://localhost:3000/admin/v1/execute)
#   MCP_PORT      (default 8091)
#   SESSION_ID    (default sess-test-011)
#   MESSAGE_ID    (default msg-011)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BB_API_KEY="${BROWSERBASE_API_KEY:?Set BROWSERBASE_API_KEY}"
BB_PROJECT_ID="${BROWSERBASE_PROJECT_ID:?Set BROWSERBASE_PROJECT_ID}"
EXECUTE_URL="${EXECUTE_URL:-http://localhost:3000/admin/v1/execute}"
MCP_PORT="${MCP_PORT:-8091}"
SESSION_ID="${SESSION_ID:-sess-test-011}"
MESSAGE_ID="${MESSAGE_ID:-msg-011}"

PROMPT='Go to bookmyshow.com and book 2 movie tickets. Do the whole flow end-to-end without pausing to ask me for confirmation. Only stop if you hit a hard blocker (OTP, captcha, or a payment wall you cannot bypass).

Search criteria:
  City: Mumbai
  Movie: any currently showing movie with the highest rating and most reviews
  Date: tomorrow
  Time: evening show (6 PM or later)
  Seats: 2 seats, best available in the middle rows

Before proceeding, show me a table of the top 5 movies currently showing with:
  Movie name
  Rating
  Genre
  Available showtimes

Then proceed with #1.

Guest/contact details:
  Name: John Doe
  Email: john.doe@example.com
  Mobile: +91 8269091282

Checkout:
  Fill all required fields
  Do NOT actually submit payment or complete any OTP
  Stop at the payment screen

When done, report:
  Movie selected, showtime, seat numbers
  Total price
  Exact reason the PAY button is/isn'\''t enabled
  Output the checkout/payment URL as plain text immediately when you reach that page

Instructions:
  Use only Chrome DevTools MCP tools
  Take a snapshot before every click
  After every major step (movie selected, seats chosen, payment page reached) output a plain-text status line immediately
  Do not make more than 3 consecutive tool calls without outputting text
  As soon as you reach the payment page, IMMEDIATELY stop all tool calls and output the URL
  This follows the same pattern as the MakeMyTrip prompt but tailored for BookMyShow.'

echo "[bb-bms] Creating Browserbase session..."
SESSION_JSON=$(curl -sf -X POST "https://api.browserbase.com/v1/sessions" \
  -H "x-bb-api-key: $BB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\": \"$BB_PROJECT_ID\", \"browserSettings\": {\"viewport\": {\"width\": 1280, \"height\": 800}}}")

SESSION_ID_BB=$(echo "$SESSION_JSON" | jq -r '.id')
LIVE_VIEW_URL="https://www.browserbase.com/sessions/$SESSION_ID_BB"
CDP_WS="wss://connect.browserbase.com?apiKey=$BB_API_KEY&sessionId=$SESSION_ID_BB"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "  BROWSERBASE SESSION : $SESSION_ID_BB"
echo "  LIVE VIEW           : $LIVE_VIEW_URL"
echo "  MCP PORT            : $MCP_PORT"
echo "  EXECUTE URL         : $EXECUTE_URL"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Stop any prior MCP proxy on this port.
if lsof -ti ":$MCP_PORT" >/dev/null 2>&1; then
  echo "[bb-bms] Stopping existing process on port $MCP_PORT..."
  lsof -ti ":$MCP_PORT" | xargs kill 2>/dev/null || true
  sleep 1
fi

echo "[bb-bms] Starting MCP server on port $MCP_PORT..."
node "$ROOT/node_modules/.bin/mcp-proxy" \
  --port "$MCP_PORT" --host 0.0.0.0 --server stream --stateless -- \
  node "$ROOT/build/src/bin/chrome-devtools-mcp.js" \
  --wsEndpoint "$CDP_WS" \
  --experimental-vision \
  &
MCP_PID=$!

cleanup() {
  echo ""
  echo "[bb-bms] Shutting down MCP server (pid $MCP_PID)..."
  kill "$MCP_PID" 2>/dev/null || true
  echo "[bb-bms] Fetching session recording..."
  RECORDING=$(curl -sf "https://api.browserbase.com/v1/sessions/$SESSION_ID_BB" \
    -H "x-bb-api-key: $BB_API_KEY" | jq -r '.replayUrl // "not available yet"')
  echo "  RECORDING : $RECORDING"
}
trap cleanup EXIT

sleep 3
echo "[bb-bms] MCP server ready."

echo "[bb-bms] Dispatching BookMyShow prompt to goose-execution..."
RESP=$(curl -s -X POST "$EXECUTE_URL" \
  --header 'Content-Type: application/json' \
  --data "$(jq -n \
    --arg prompt "$PROMPT" \
    --arg session_id "$SESSION_ID" \
    --arg message_id "$MESSAGE_ID" \
    --argjson mcp_port "$MCP_PORT" \
    '{
      prompt: $prompt,
      provider: "gcp_vertex_ai",
      model: "gemini-3.5-flash",
      company_id: "smoke-test-company",
      session_id: $session_id,
      message_id: $message_id,
      speed: "",
      effort: "high",
      file_urls: [],
      mcp_port: $mcp_port
    }')")

echo "$RESP" | jq '.'
STATUS=$(echo "$RESP" | jq -r '.status // empty')
if [[ "$STATUS" != "accepted" ]]; then
  echo "[bb-bms] ERROR: execute request was not accepted" >&2
  exit 1
fi

echo ""
echo "[bb-bms] Request accepted. Watch the browser:"
echo "  $LIVE_VIEW_URL"
echo ""
echo "Subscribe to progress (optional):"
echo "  redis-cli subscribe message_${MESSAGE_ID}_stream_channel"
echo ""
echo "Press Ctrl+C when done to stop MCP and fetch recording URL."
wait "$MCP_PID"
