#!/bin/sh
# Goose HTTP MCP entrypoint — Bright Data Browser API only.
#
# Serves streamable HTTP MCP at http://$HOST:$PORT/mcp
# Requires BRIGHTDATA_AUTH (or BRIGHTDATA_USER+BRIGHTDATA_PASS).
#
# Live view is disabled by default on port 8080. For interactive pods with
# screencast on :6080, set PORT=8090 ENABLE_SCREENCAST=1 and expose 8090+6080.
set -e

export PORT="${PORT:-8080}"
export HOST="${HOST:-0.0.0.0}"
export ENABLE_SCREENCAST="${ENABLE_SCREENCAST:-0}"

exec /app/scripts/brightdata-entrypoint.sh
