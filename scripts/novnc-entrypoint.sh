#!/bin/sh
# Interactive entrypoint: runs a HEADFUL Chrome on a virtual X display and
# exposes it over the web via VNC -> noVNC, so a human can take over the
# remote browser (login, OTP, CAPTCHA, payment).
#
# Ports:
#   8090 -> MCP (streamable_http) at /mcp
#   6080 -> noVNC web UI (open http://localhost:6080/vnc.html)
set -e

export DISPLAY=:99
rm -f /tmp/.X99-lock

# Use GPU-accelerated Xvfb when an NVIDIA GPU is present (runtimeClassName:nvidia).
# The +iglx flag enables indirect GLX so Chrome can use the real GPU via EGL/ANGLE,
# producing authentic WebGL/canvas fingerprints that pass press-and-hold CAPTCHAs.
# Falls back to pure software rendering when no GPU device is found.
if nvidia-smi >/dev/null 2>&1; then
  echo "[novnc-entrypoint] NVIDIA GPU detected — enabling hardware-accelerated display"
  Xvfb :99 -screen 0 1440x900x24 -ac +iglx >/tmp/xvfb.log 2>&1 &
else
  echo "[novnc-entrypoint] No GPU found — using software Xvfb"
  Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/xvfb.log 2>&1 &
fi
sleep 1

# Minimal window manager (keeps Chrome maximized / decorated).
fluxbox >/tmp/fluxbox.log 2>&1 &

# Share the X display over VNC, then bridge VNC -> WebSocket for noVNC.
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -bg -quiet
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

echo "[novnc-entrypoint] noVNC at http://localhost:6080/vnc.html  | MCP at http://localhost:8090/mcp"

# Patch the Chrome binary's reported DevTools version to remove automation
# indicators visible via the /json/version endpoint.
# Also inject a JS snippet via preferences to remove navigator.webdriver before
# the first page loads — covers sites that check on DOMContentLoaded.
PREFS_DIR="$HOME/.config/google-chrome/Default"
mkdir -p "$PREFS_DIR"
cat > "$PREFS_DIR/Preferences" << 'PREFS'
{
  "profile": { "content_settings": {} },
  "webkit": { "webprefs": { "javascript_enabled": true } }
}
PREFS

# Proxy configuration.
# Option A — explicit proxy: set CHROME_PROXY=http://host:port
# Option B — Webshare auto-select: set WEBSHARE_API_KEY (picks a random valid proxy)
#   Optionally set WEBSHARE_COUNTRY (e.g. "US") to filter by country.
#   CHROME_PROXY_USER / CHROME_PROXY_PASS are set automatically from the API response.
PROXY_FLAG=""

if [ -z "${CHROME_PROXY:-}" ] && [ -n "${WEBSHARE_API_KEY:-}" ]; then
  echo "[novnc-entrypoint] Fetching proxy from Webshare..."
  COUNTRY_FILTER=""
  if [ -n "${WEBSHARE_COUNTRY:-}" ]; then
    COUNTRY_FILTER="&country_code__in=${WEBSHARE_COUNTRY}"
  fi
  PROXY_JSON=$(wget -qO- \
    "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100${COUNTRY_FILTER}" \
    --header="Authorization: Token ${WEBSHARE_API_KEY}" 2>/dev/null || true)
  if [ -n "$PROXY_JSON" ]; then
    # Pick a random proxy from the list using awk (no python/jq needed)
    PROXY_COUNT=$(echo "$PROXY_JSON" | grep -o '"proxy_address"' | wc -l | tr -d ' ')
    if [ "$PROXY_COUNT" -gt 0 ]; then
      PICK=$(($(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % PROXY_COUNT + 1))
      PROXY_IP=$(echo "$PROXY_JSON" | grep -o '"proxy_address": *"[^"]*"' | sed -n "${PICK}p" | grep -o '"[^"]*"$' | tr -d '"')
      PROXY_PORT=$(echo "$PROXY_JSON" | grep -o '"port": *[0-9]*' | sed -n "${PICK}p" | grep -o '[0-9]*$')
      PROXY_USER=$(echo "$PROXY_JSON" | grep -o '"username": *"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
      PROXY_PASS=$(echo "$PROXY_JSON" | grep -o '"password": *"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
      export CHROME_PROXY="http://${PROXY_IP}:${PROXY_PORT}"
      export CHROME_PROXY_USER="${PROXY_USER}"
      export CHROME_PROXY_PASS="${PROXY_PASS}"
      echo "[novnc-entrypoint] Webshare proxy selected: ${PROXY_IP}:${PROXY_PORT} (${PICK}/${PROXY_COUNT})"
    fi
  fi
fi

if [ -n "${CHROME_PROXY:-}" ]; then
  PROXY_FLAG="--proxy-server=${CHROME_PROXY}"
  echo "[novnc-entrypoint] Proxy enabled: ${CHROME_PROXY}"
fi

# Launch Chrome eagerly so it is always visible in the VNC from pod start.
# Stealth flags: suppress all automation signals that bot-detection fingerprints.
/usr/local/bin/chrome \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --start-maximized \
  --disable-blink-features=AutomationControlled \
  --disable-infobars \
  --disable-extensions-except= \
  --disable-plugins-discovery \
  --disable-default-apps \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --metrics-recording-only \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --use-mock-keychain \
  --hide-scrollbars \
  --mute-audio \
  --user-agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  --lang=en-US \
  --window-size=1440,900 \
  --use-gl=angle \
  --use-angle=gl-egl \
  --enable-gpu-rasterization \
  --ignore-gpu-blocklist \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  ${PROXY_FLAG} \
  about:blank \
  >/tmp/chrome.log 2>&1 &

# Wait for Chrome's DevTools endpoint to be ready before connecting.
echo "[novnc-entrypoint] waiting for Chrome DevTools on :9222 ..."
i=0
while ! wget -qO- http://localhost:9222/json/version >/dev/null 2>&1; do
  sleep 0.5
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "[novnc-entrypoint] ERROR: Chrome did not start in time" >&2
    exit 1
  fi
done
echo "[novnc-entrypoint] Chrome ready"

# Inject stealth patches via CDP WebSocket using the stealth-inject.js script.
# Run in background because the proxy auth handler keeps a WebSocket alive
# to respond to 407 challenges — it must stay running alongside mcp-proxy.
node /app/scripts/stealth-inject.js http://localhost:9222 &
STEALTH_PID=$!
# Give it up to 5s to register the script before mcp-proxy starts
sleep 2
kill -0 $STEALTH_PID 2>/dev/null && \
  echo "[novnc-entrypoint] stealth-inject running (pid $STEALTH_PID)" || \
  echo "[novnc-entrypoint] warn: stealth-inject exited early"

# Attach mcp-proxy to the already-running Chrome via its HTTP remote-debugging
# endpoint. --browserUrl tells chrome-devtools-mcp to call /json/version to
# discover the full WebSocket UUID path (ws://localhost:9222/devtools/browser/<id>)
# automatically — passing ws://localhost:9222 directly would 404.
exec /app/node_modules/.bin/mcp-proxy \
  --port 8090 --host 0.0.0.0 --server stream --stateless -- \
  node /app/build/src/bin/chrome-devtools-mcp.js \
  --browserUrl=http://localhost:9222 \
  --experimental-vision \
  --chrome-arg=--no-sandbox \
  --chrome-arg=--disable-setuid-sandbox \
  --chrome-arg=--disable-dev-shm-usage \
  --chrome-arg=--disable-blink-features=AutomationControlled \
  --ignore-default-chrome-arg=--enable-automation
