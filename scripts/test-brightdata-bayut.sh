#!/usr/bin/env bash
# Bright Data Bayut hCaptcha probe
#
# Prerequisites (Bright Data Control Panel):
#   1. Create a "Browser API" zone (Proxies & Scraping → Browser API → Add)
#   2. Copy from zone Overview tab:
#        Username: brd-customer-{id}-zone-{name}
#        Password: zone password (NOT necessarily the REST API UUID)
#   3. Optionally grant your API key Admin permissions for zone management
#
# Usage:
#   BRIGHTDATA_AUTH='brd-customer-XXX-zone-scraping_browser1:YOUR_ZONE_PASSWORD' \
#     bash scripts/test-brightdata-bayut.sh
#
# Optional:
#   BRIGHTDATA_API_KEY=d9ed...   # for REST zone listing only
#   BRIGHTDATA_COUNTRY=ae        # UAE exit (appended to username)
#   TARGET_URL=https://www.bayut.com/
set -euo pipefail

API_KEY="${BRIGHTDATA_API_KEY:-}"
TARGET_URL="${TARGET_URL:-https://www.bayut.com/}"

echo "[bd-bayut] Bright Data Bayut probe"
echo ""

if [[ -n "$API_KEY" ]]; then
  echo "[bd-bayut] Checking active zones via REST API..."
  ZONES=$(curl -sf -m 15 "https://api.brightdata.com/zone/get_active_zones" \
    -H "Authorization: Bearer $API_KEY" 2>/dev/null || echo '[]')
  echo "  Active zones: $ZONES"
  if [[ "$ZONES" == "[]" ]]; then
    echo ""
    echo "  No zones on this account yet. Create Browser API zone in dashboard first:"
    echo "  https://brightdata.com/cp/zones"
    echo ""
  fi
fi

if [[ -z "${BRIGHTDATA_AUTH:-}" ]]; then
  echo "ERROR: Set BRIGHTDATA_AUTH=brd-customer-XXX-zone-YYY:ZONE_PASSWORD"
  echo ""
  echo "Your REST API key (UUID) authenticates /request and zone APIs but:"
  echo "  - get_active_zones returned [] (no zones provisioned)"
  echo "  - Browser API needs zone username + password on wss://...@brd.superproxy.io:9222"
  echo ""
  echo "What to test once zone exists:"
  echo "  1. Bayut homepage bypass (hCaptcha / captchaChallenge redirect)"
  echo "  2. UAE geo: BRIGHTDATA_COUNTRY=ae"
  echo "  3. Property search flow after first page loads"
  exit 1
fi

export TARGET_URL
node "$(dirname "$0")/test-brightdata-bayut.mjs"
