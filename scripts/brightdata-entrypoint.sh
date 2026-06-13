#!/bin/sh
# Bright Data Browser API entrypoint for on-demand goose pods.
#
# Uses Bright Data's managed Chrome over CDP (no local Chrome / Xvfb / proxy).
# Serves the same ports as novnc-entrypoint.sh:
#   8090 -> MCP at /mcp
#   6080 -> interactive live view (screencast-bridge over the same BD session)
#
# Required env (one of):
#   BRIGHTDATA_AUTH=brd-customer-XXX-zone-YYY:password
#   BRIGHTDATA_USER + BRIGHTDATA_PASS
#
# Optional:
#   BRIGHTDATA_COUNTRY=ae
#   BRIGHTDATA_HOST=brd.superproxy.io
#   BRIGHTDATA_PORT=9222
#   SCREENCAST_MAX_WIDTH / SCREENCAST_MAX_HEIGHT
set -e

if [ -z "${BRIGHTDATA_AUTH:-}" ] && { [ -z "${BRIGHTDATA_USER:-}" ] || [ -z "${BRIGHTDATA_PASS:-}" ]; }; then
  echo "[brightdata-entrypoint] ERROR: set BRIGHTDATA_AUTH or BRIGHTDATA_USER+BRIGHTDATA_PASS" >&2
  exit 1
fi

CHROME_WS_ENDPOINT="$(node /app/scripts/brightdata-config.mjs --print-endpoint)"
export CHROME_WS_ENDPOINT

echo "[brightdata-entrypoint] Bright Data Browser API mode"
echo "[brightdata-entrypoint] live view at http://localhost:6080/  | MCP at http://localhost:8090/mcp"
if [ -n "${BRIGHTDATA_COUNTRY:-}" ]; then
  echo "[brightdata-entrypoint] geo country=${BRIGHTDATA_COUNTRY}"
fi

SCREENCAST_MAX_WIDTH="${SCREENCAST_MAX_WIDTH:-1280}" \
SCREENCAST_MAX_HEIGHT="${SCREENCAST_MAX_HEIGHT:-800}" \
  node /app/scripts/screencast-bridge.mjs >/tmp/screencast.log 2>&1 &
echo "[brightdata-entrypoint] screencast bridge started (pid $!)"

# Give the bridge a moment to connect to Bright Data before MCP attaches.
sleep 2

exec /app/node_modules/.bin/mcp-proxy \
  --port 8090 \
  --host 0.0.0.0 \
  --server stream \
  --stateless \
  --connectionTimeout "${MCP_CONNECTION_TIMEOUT:-120000}" \
  --requestTimeout "${MCP_REQUEST_TIMEOUT:-3600000}" \
  -- \
  node /app/build/src/bin/chrome-devtools-mcp.js \
  --wsEndpoint "$CHROME_WS_ENDPOINT" \
  --experimental-vision
