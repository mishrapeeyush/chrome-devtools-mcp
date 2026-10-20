#!/bin/sh
# Bright Data Browser API entrypoint — sole browser backend for this deployment.
#
# Uses Bright Data's managed Chrome over CDP (no local Chrome, Xvfb, or proxy).
#
# Required env (one of):
#   BRIGHTDATA_AUTH=brd-customer-XXX-zone-YYY:password
#   BRIGHTDATA_USER + BRIGHTDATA_PASS
#
# Optional:
#   BRIGHTDATA_COUNTRY=ae
#   BRIGHTDATA_HOST=brd.superproxy.io
#   BRIGHTDATA_PORT=9222
#   PORT=8080              MCP port (default 8090 for interactive pods, 8080 for goose-http)
#   HOST=0.0.0.0
#   ENABLE_SCREENCAST=1    CDP live view on :6080 (default 1; set 0 for MCP-only goose-http)
#   SCREENCAST_MAX_WIDTH / SCREENCAST_MAX_HEIGHT
set -e

if [ -z "${BRIGHTDATA_AUTH:-}" ] && { [ -z "${BRIGHTDATA_USER:-}" ] || [ -z "${BRIGHTDATA_PASS:-}" ]; }; then
  echo "[brightdata-entrypoint] ERROR: set BRIGHTDATA_AUTH or BRIGHTDATA_USER+BRIGHTDATA_PASS" >&2
  exit 1
fi

PORT="${PORT:-8090}"
HOST="${HOST:-0.0.0.0}"
ENABLE_SCREENCAST="${ENABLE_SCREENCAST:-1}"

CHROME_WS_ENDPOINT="$(node /app/scripts/brightdata-config.mjs --print-endpoint)"
export CHROME_WS_ENDPOINT

echo "[brightdata-entrypoint] Bright Data Browser API mode"
echo "[brightdata-entrypoint] MCP at http://${HOST}:${PORT}/mcp"
if [ -n "${BRIGHTDATA_COUNTRY:-}" ]; then
  echo "[brightdata-entrypoint] geo country=${BRIGHTDATA_COUNTRY}"
fi

if [ "$ENABLE_SCREENCAST" = "1" ] || [ "$ENABLE_SCREENCAST" = "true" ] || [ "$ENABLE_SCREENCAST" = "yes" ]; then
  echo "[brightdata-entrypoint] live view will attach to MCP browser on :6080"
fi

exec /app/node_modules/.bin/mcp-proxy \
  --port "$PORT" \
  --host "$HOST" \
  --server stream \
  --connectionTimeout "${MCP_CONNECTION_TIMEOUT:-120000}" \
  --requestTimeout "${MCP_REQUEST_TIMEOUT:-3600000}" \
  -- \
  node /app/build/src/bin/chrome-devtools-mcp.js \
  --wsEndpoint "$CHROME_WS_ENDPOINT" \
  --experimental-vision
