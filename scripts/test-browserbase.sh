#!/usr/bin/env bash
# Quick Browserbase integration test
# Usage: BROWSERBASE_API_KEY=xxx BROWSERBASE_PROJECT_ID=xxx bash scripts/test-browserbase.sh
#
# What it does:
#   1. Creates a Browserbase session via REST API
#   2. Prints the live view URL → open this in your browser NOW
#   3. Starts the MCP server connected to that session's CDP endpoint
#   4. Fires a test prompt at your execute service
#   5. On exit, fetches the session recording URL
#
# Requirements: curl, jq, node (built project at ./build)
set -e

BB_API_KEY="${BROWSERBASE_API_KEY:?Set BROWSERBASE_API_KEY}"
BB_PROJECT_ID="${BROWSERBASE_PROJECT_ID:?Set BROWSERBASE_PROJECT_ID}"
EXECUTE_URL="${EXECUTE_URL:-http://localhost:3000/admin/v1/execute}"
MCP_PORT="${MCP_PORT:-8091}"   # use 8091 to avoid colliding with your noVNC container on 8090

# ── 1. Create Browserbase session ─────────────────────────────────────────────
echo "[bb-test] Creating Browserbase session..."
SESSION_JSON=$(curl -sf -X POST "https://api.browserbase.com/v1/sessions" \
  -H "x-bb-api-key: $BB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\": \"$BB_PROJECT_ID\", \"browserSettings\": {\"viewport\": {\"width\": 1280, \"height\": 800}}}")

SESSION_ID=$(echo "$SESSION_JSON" | jq -r '.id')
LIVE_VIEW_URL="https://www.browserbase.com/sessions/$SESSION_ID"
CDP_WS="wss://connect.browserbase.com?apiKey=$BB_API_KEY&sessionId=$SESSION_ID"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "  SESSION ID : $SESSION_ID"
echo "  LIVE VIEW  : $LIVE_VIEW_URL"
echo "  (open the URL above in your browser to watch live)"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── 2. Start MCP server pointing at the Browserbase CDP endpoint ───────────────
echo "[bb-test] Starting MCP server on port $MCP_PORT connected to Browserbase..."
node "$(dirname "$0")/../node_modules/.bin/mcp-proxy" \
  --port "$MCP_PORT" --host 0.0.0.0 --server stream --stateless -- \
  node "$(dirname "$0")/../build/src/bin/chrome-devtools-mcp.js" \
  --wsEndpoint "$CDP_WS" \
  --experimental-vision \
  &
MCP_PID=$!

cleanup() {
  echo ""
  echo "[bb-test] Shutting down MCP server (pid $MCP_PID)..."
  kill "$MCP_PID" 2>/dev/null || true

  echo "[bb-test] Fetching session recording..."
  RECORDING=$(curl -sf "https://api.browserbase.com/v1/sessions/$SESSION_ID" \
    -H "x-bb-api-key: $BB_API_KEY" | jq -r '.replayUrl // "not available yet"')
  echo "  RECORDING : $RECORDING"
}
trap cleanup EXIT

# Give MCP server 3 seconds to connect
sleep 3
echo "[bb-test] MCP server ready."

# ── 3. Fire test prompt at execute service ─────────────────────────────────────
echo "[bb-test] Sending test prompt to execute service..."
curl -s -X POST "$EXECUTE_URL" \
  --header 'Content-Type: application/json' \
  --data "$(jq -n \
    --arg session_id "bb-test-$SESSION_ID" \
    --arg mcp_port "$MCP_PORT" \
    '{
      prompt: "Go to google.com. Take a snapshot. Then search for \"browserbase live view test\" and take another snapshot. Report the top 3 search results with their titles and URLs.",
      provider: "gcp_vertex_ai",
      model: "gemini-3.5-flash",
      company_id: "smoke-test-company",
      session_id: $session_id,
      message_id: "msg-bb-001",
      speed: "",
      effort: "high",
      file_urls: [],
      mcp_port: $mcp_port
    }')" | jq '.'

echo ""
echo "[bb-test] Prompt dispatched. Watch the browser at:"
echo "  $LIVE_VIEW_URL"
echo ""
echo "Press Ctrl+C when done to stop the MCP server and get recording URL."
wait "$MCP_PID"
