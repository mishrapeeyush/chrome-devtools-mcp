#!/bin/sh
# Goose HTTP MCP entrypoint — Bright Data Browser API only.
#
# Serves streamable HTTP MCP at http://$HOST:$PORT/mcp?redis_channel=...
# Optional CDP live view (screencast-bridge) on :6080 when ENABLE_SCREENCAST=1.
# Requires BRIGHTDATA_AUTH (or BRIGHTDATA_USER+BRIGHTDATA_PASS).
#
# K8s pods (goose-execution PodManager) set PORT=8090. Local docker smoke:
#   docker run --rm -e BRIGHTDATA_AUTH -e ENABLE_SCREENCAST=1 \
#     -p 8090:8090 -p 6080:6080 -e PORT=8090 chrome-devtools-mcp:local
set -e

export PORT="${PORT:-8090}"
export HOST="${HOST:-0.0.0.0}"
ENABLE_SCREENCAST="${ENABLE_SCREENCAST:-1}"

if [ -z "${BRIGHTDATA_AUTH:-}" ] && { [ -z "${BRIGHTDATA_USER:-}" ] || [ -z "${BRIGHTDATA_PASS:-}" ]; }; then
  echo "[goose-mcp] ERROR: set BRIGHTDATA_AUTH or BRIGHTDATA_USER+BRIGHTDATA_PASS" >&2
  exit 1
fi

CHROME_WS_ENDPOINT="$(node /app/scripts/brightdata-config.mjs --print-endpoint)"
export CHROME_WS_ENDPOINT

# Live view starts inside chrome-devtools-mcp when ENABLE_SCREENCAST=1 (same browser as MCP).
if [ "$ENABLE_SCREENCAST" = "1" ] || [ "$ENABLE_SCREENCAST" = "true" ] || [ "$ENABLE_SCREENCAST" = "yes" ]; then
  echo "[goose-mcp] live view will attach to MCP browser on :6080"
fi

exec node /app/scripts/goose-http-entrypoint.mjs
