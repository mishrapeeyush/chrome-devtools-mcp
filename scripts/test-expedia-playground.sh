#!/usr/bin/env bash
# Minimal Expedia Playground-mirror test (homepage only by default).
#
# Usage:
#   BRIGHTDATA_AUTH='brd-customer-XXX-zone-scraping_browser1:pass' \
#   BRIGHTDATA_COUNTRY=us \
#     bash scripts/test-expedia-playground.sh
#
# Optional — also fill widget and submit search:
#   EXPEDIA_SUBMIT=1 bash scripts/test-expedia-playground.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRIGHTDATA_COUNTRY="${BRIGHTDATA_COUNTRY:-us}"
export EXPEDIA_SETTLE_MS="${EXPEDIA_SETTLE_MS:-3000}"

if [ -z "${BRIGHTDATA_AUTH:-}" ] && { [ -z "${BRIGHTDATA_USER:-}" ] || [ -z "${BRIGHTDATA_PASS:-}" ]; }; then
  echo "Set BRIGHTDATA_AUTH or BRIGHTDATA_USER+BRIGHTDATA_PASS" >&2
  exit 1
fi

echo "[expedia-playground] minimal test country=${BRIGHTDATA_COUNTRY} submit=${EXPEDIA_SUBMIT:-0}"
node "$ROOT/scripts/test-expedia-playground.mjs"
