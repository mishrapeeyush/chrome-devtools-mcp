#!/usr/bin/env bash
# Expedia DataDome human-flow test (5 upgrades) via Bright Data Scraping Browser.
#
# Usage:
#   BRIGHTDATA_AUTH='brd-customer-XXX-zone-scraping_browser1:pass' \
#   BRIGHTDATA_COUNTRY=us \
#     bash scripts/test-expedia-human-flow.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BRIGHTDATA_AUTH="${BRIGHTDATA_AUTH:-}"
export BRIGHTDATA_COUNTRY="${BRIGHTDATA_COUNTRY:-us}"
export EXPEDIA_DWELL_MS="${EXPEDIA_DWELL_MS:-10000}"

if [ -z "$BRIGHTDATA_AUTH" ]; then
  echo "Set BRIGHTDATA_AUTH" >&2
  exit 1
fi

echo "[expedia-flow] Running 5-upgrade human flow test (dwell=${EXPEDIA_DWELL_MS}ms)"
node "$ROOT/scripts/test-expedia-human-flow.mjs"
