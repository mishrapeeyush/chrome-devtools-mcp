# Site Accessibility Report — Browser Automation (on-demand-goose-execution)

_Last updated: 2026-06-13_

This document records which websites the self-hosted browser-automation stack could
reach, which ones blocked it, the **exact block mechanism**, and **workaround options**
for each class of defense.

---

## 1. Test setup (what was tested)

| Aspect | Value |
|--------|-------|
| Browser mode | **Headful** Chrome on virtual X display (`Xvfb :99`), not `--headless` |
| Driver | Plain `puppeteer` 25.1.0 + `mcp-proxy` over raw CDP (`--browserUrl`) |
| Stealth | **Custom** CDP injection (`scripts/stealth-inject.js`) — NOT `puppeteer-extra-plugin-stealth` |
| Profile | **Fresh** ephemeral K8s pod + new profile per run; destroyed after session (no reuse) |
| Proxy (default) | **Webshare** — rotating **US residential** when no SOAX env is set |
| Proxy (UAE) | **SOAX** — UAE residential via `proxy.soax.com:5000` when `SOAX_PROXY_PASS` is set |
| Egress IP | US: AS7015 Comcast (Webshare). UAE: e& UAE / Ajman (SOAX, `83.110.129.29` verified) |
| Throughput | ~1.5–2 pages/min (gated by the LLM agent loop, not browser speed) |

> **Webshare (verified 2026-06-12):** default in `config.go` + `pod_manager.go` →
> `WEBSHARE_API_KEY` / `WEBSHARE_COUNTRY=US`. **No UAE exits** on the current plan (`AE count:0`).
>
> **SOAX (verified 2026-06-13):** when `SOAX_PROXY_PASS` is set, Webshare is disabled and pods
> get `CHROME_PROXY` / `CHROME_PROXY_USER` / `CHROME_PROXY_PASS` directly. Use the **exact Login**
> from the SOAX dashboard with `country-ae` in the username for a UAE exit:
>
> ```bash
> SOAX_PROXY_PASS=<from SOAX dashboard>
> SOAX_PROXY_USER=package-<id>-country-ae-sessionid-<sticky>-sessionlength-300
> SOAX_COUNTRY=ae
> SOAX_PROXY_HOST=http://proxy.soax.com:5000
> ```
>
> Dashboard login **without** `country-ae` exits in **UK** — always include country in username or
> set Country: AE in SOAX Quick Access before copying credentials.

Stealth patches applied: `navigator.webdriver` removed, `window.chrome` restored,
WebGL vendor/renderer spoofed, realistic `plugins`/`languages`/`permissions`,
`hardwareConcurrency=8`, `deviceMemory=8`, `--disable-blink-features=AutomationControlled`,
`--ignore-default-chrome-arg=--enable-automation`, spoofed Windows Chrome 124 UA.

> **Key caveat:** "Accessible" below means the **homepage/landing page rendered**.
> It does **not** guarantee a full transactional flow (search → checkout → payment)
> will pass deeper anti-bot gates. See Section 4 for deep-flow results.

---

## 2. Results — Global Tier-1 anti-bot sites (20)

**14 accessible · 1 partial · 5 blocked**

| # | Site | Verdict | Mechanism / Evidence |
|---|------|---------|----------------------|
| 1 | Skyscanner | BLOCKED | PerimeterX redirect to `/captcha-v2` |
| 2 | Ticketmaster | ACCESSIBLE | homepage rendered (~18 KB) |
| 3 | StubHub | ACCESSIBLE | homepage rendered |
| 4 | Nike SNKRS | ACCESSIBLE | launch calendar rendered |
| 5 | Supreme | ACCESSIBLE | shop catalog rendered |
| 6 | Cloudflare test (nowsecure.nl) | BLOCKED | Cloudflare/Turnstile challenge |
| 7 | LinkedIn | ACCESSIBLE | landing page rendered |
| 8 | Google Search | BLOCKED | reCAPTCHA redirect to `/sorry/` |
| 9 | Instagram | ACCESSIBLE | login/landing rendered |
| 10 | Twitter / X | ACCESSIBLE | landing/login rendered |
| 11 | Foot Locker | ACCESSIBLE | homepage rendered (~26 KB) |
| 12 | Best Buy | ACCESSIBLE | homepage rendered |
| 13 | Walmart | ACCESSIBLE | homepage rendered (~62 KB) |
| 14 | Target | ACCESSIBLE | homepage rendered (~52 KB) |
| 15 | Costco | ACCESSIBLE | homepage rendered |
| 16 | Amazon | ACCESSIBLE | homepage rendered (~51 KB) |
| 17 | Airbnb | PARTIAL | only a modal, near-empty body |
| 18 | Booking.com | BLOCKED | DataDome challenge redirect (`chal_t=...`) |
| 19 | Expedia | PARTIAL | Direct homepage **BLOCKED** ("Bot or Not?"). **Google → organic click → travel-guide page ACCESSIBLE** (Bright Data US, Jun 2026). Hotel-Search via deep link or quick widget click still triggers DataDome. Use 5-upgrade human flow (see Section 8). |
| 20 | eBay | ACCESSIBLE | homepage rendered (~33 KB) |

---

## 3. Results — UAE-based sites (20)

**14 accessible · 6 blocked**

| # | Site | Category | Verdict | Mechanism / Evidence |
|---|------|----------|---------|----------------------|
| 1 | Noon | E-commerce | ACCESSIBLE | full homepage (~158 KB) |
| 2 | Amazon.ae | E-commerce | ACCESSIBLE* | navigated OK; snapshot caught mid-load ("busy") |
| 3 | Carrefour UAE | Grocery | ACCESSIBLE | homepage (~48 KB) |
| 4 | Namshi | Fashion | ACCESSIBLE | shipping-country splash rendered |
| 5 | Talabat | Food delivery | ACCESSIBLE | homepage (~11 KB) |
| 6 | Careem | Ride-hailing | ACCESSIBLE | homepage (~20 KB) |
| 7 | Dubizzle | Classifieds | ACCESSIBLE | homepage (~19 KB) |
| 8 | Bayut | Real estate | BLOCKED | redirect to `/captchaChallenge` |
| 9 | Property Finder | Real estate | ACCESSIBLE | homepage (~36 KB) despite slow load |
| 10 | Emirates | Airline | ACCESSIBLE | homepage (~26 KB) |
| 11 | Etihad | Airline | ACCESSIBLE | homepage (~13 KB) |
| 12 | Emirates NBD | Bank | ACCESSIBLE | homepage (~166 KB) |
| 13 | ADCB | Bank | ACCESSIBLE | homepage (~75 KB) |
| 14 | First Abu Dhabi Bank | Bank | BLOCKED | `ERR_SSL_PROTOCOL_ERROR` (TLS handshake rejected) |
| 15 | Etisalat (e&) | Telecom | ACCESSIBLE | redirected to eand.ae, rendered (~46 KB) |
| 16 | du | Telecom | ACCESSIBLE | homepage (~33 KB) |
| 17 | u.ae (Govt portal) | Government | BLOCKED | `ERR_TIMED_OUT` |
| 18 | RTA Dubai | Government | BLOCKED | F5/BIG-IP WAF "Request Rejected" (support ID) |
| 19 | Gulf News | News | BLOCKED | navigation timeout (30s) |
| 20 | Khaleej Times | News | BLOCKED | snapshot/navigation timeout |

\* Amazon.ae opened but the snapshot fired while still "busy" — front door opened, slow render.

> **Note:** Section 3 results used **US Webshare** egress. See **Section 3a** for retests after
> fixing Webshare IP whitelist and switching to **SOAX UAE**.

---

## 3a. UAE retests — progressive fixes (6 previously blocked sites)

Three probe runs on the same 6 sites that failed in Section 3:

| # | Site | US Webshare (original) | After whitelist fix (Webshare US) | SOAX UAE (2026-06-13) |
|---|------|------------------------|-----------------------------------|------------------------|
| 1 | Bayut | BLOCKED (CAPTCHA) | BLOCKED | **BLOCKED** (still `/captchaChallenge`) |
| 2 | First Abu Dhabi Bank | BLOCKED (TLS) | BLOCKED (TLS) | **BLOCKED** (`ERR_TUNNEL_CONNECTION_FAILED`) |
| 3 | u.ae | BLOCKED (timeout) | BLOCKED (timeout) | **ACCESSIBLE** — full UAE Govt homepage |
| 4 | RTA Dubai | BLOCKED (F5 WAF) | BLOCKED (F5 WAF) | **ACCESSIBLE** — portal loaded (~5 KB) |
| 5 | Gulf News | BLOCKED (timeout) | **ACCESSIBLE** | **ACCESSIBLE** (~19 KB) |
| 6 | Khaleej Times | BLOCKED (timeout) | **ACCESSIBLE** | **ACCESSIBLE** (~31 KB) |

**Score progression:** 0/6 → 2/6 (whitelist fix) → **4/6 (SOAX UAE)**.

**What each fix addressed:**

| Fix | What changed | Sites fixed |
|-----|--------------|-------------|
| Remove Webshare IP whitelist on dev cluster | Proxy auth worked from cluster pods again | Gulf News, Khaleej Times |
| SOAX UAE proxy (`country-ae` in username) | Egress IP in UAE (e& / Ajman) | **u.ae**, **RTA Dubai** (+ news sites stay accessible) |

**Still blocked after SOAX:**

- **Bayut** — bot CAPTCHA wall (PerimeterX-style); needs warmed session / human-takeover, not geo alone.
- **First Abu Dhabi Bank** — TLS/tunnel failure through SOAX proxy; try direct egress (no proxy) or TLS diagnostic.

---

## 4. Deep-flow results (beyond homepage → toward checkout)

| Site | Flow | Result | Notes |
|------|------|--------|-------|
| MakeMyTrip | Flight search → checkout | BLOCKED | Deep-link returned bare `200-OK` body; homepage `net::ERR_HTTP2_PROTOCOL_ERROR` (TLS/HTTP2 fingerprint block) |
| **ixigo** | Flight search → checkout | **WORKED** | Reached "Review & Traveller Details" → stopped at login **OTP gate** (Akasa QP1127 BOM→DEL) |
| BookMyShow | Movie booking | BLOCKED | Cloudflare challenge (earlier run) |
| OpenTable | Restaurant reservation | BLOCKED | Homepage OK, but `/s?` search endpoint → Akamai `Access Denied` (`errors.edgesuite.net`) |
| Resy | Restaurant reservation | PARTIAL | Homepage/listings loaded (~10 KB); flow not completed (run interrupted) |

**Takeaway:** Sites that allow the homepage often still block the **functional endpoint**
(search/checkout). Homepage accessibility ≠ flow accessibility.

---

## 5. Block mechanisms observed → workaround options

| Defense (seen on) | How it blocked us | Workaround options (cheapest → strongest) |
|-------------------|-------------------|-------------------------------------------|
| **PerimeterX / HUMAN** (Skyscanner, Bayut) | Redirect to captcha challenge page | 1. Residential/mobile proxy (the wired-in Webshare path). 2. Warmed persistent profile + cookies. 3. Human-like pacing / mouse movement. 4. CAPTCHA-solver service (2Captcha/CapSolver) for the challenge. |
| **DataDome** (Booking.com) | `chal_t` challenge redirect, near-empty body | 1. Residential proxy with good IP reputation (DataDome is heavily IP-driven). 2. Real TLS/JA3 fingerprint (see TLS row). 3. Solve interstitial via human-takeover live view. |
| **Cloudflare Turnstile / JS challenge** (nowsecure.nl, news sites) | JS challenge / managed challenge | 1. Keep headful + real UA (already done). 2. Residential proxy. 3. Let the challenge auto-solve with a warmed session; use human-takeover for managed challenge. 4. `cloudflare`-friendly fetchers for read-only data. |
| **Akamai Bot Manager** (OpenTable `/s?`, likely Walmart/Target/BestBuy checkout) | Edge `Access Denied` (`errors.edgesuite.net`) on functional endpoints | 1. Residential proxy (Akamai scores datacenter ASNs harshly). 2. Correct TLS fingerprint (Akamai inspects JA3/JA4). 3. Navigate via on-page clicks (not deep-linked `/s?`) to carry referer + sensor cookies. 4. Persist Akamai `_abck`/`bm_sz` cookies in a warmed profile. |
| **F5 BIG-IP ASM WAF** (RTA Dubai) | "Request Rejected" + support ID | 1. Residential/local-geo proxy (UAE IP). 2. Slow request rate. 3. Clean header order via real browser nav (already headful). 4. Often geo/ASN reputation — a UAE residential exit usually passes. |
| **reCAPTCHA v3 / behavioral** (Google) | `/sorry/` IP-reputation block | 1. Residential proxy (datacenter IPs are flagged instantly). 2. Avoid scraping Google directly — use an official Search API or SerpAPI. |
| **TLS / HTTP2 fingerprint** (MakeMyTrip `ERR_HTTP2_PROTOCOL_ERROR`, FAB `ERR_SSL_PROTOCOL_ERROR`) | Server rejects the client's TLS/H2 handshake | 1. Use a Chrome build whose JA3/JA4 matches a real browser (real headful Chrome mostly does — these failures suggest proxy/MITM or H2 setting mismatch). 2. Disable any TLS-altering proxy. 3. Try `--disable-http2` as a diagnostic. 4. `curl-impersonate` / uTLS for read-only fetches. |
| **Network timeout / geo-fence** (u.ae, Gulf News, Khaleej) | 30s nav timeout on US egress | **Fixed for u.ae + RTA with SOAX UAE** (verified 2026-06-13). Gulf News/Khaleej fixed by removing Webshare IP whitelist. Use `SOAX_PROXY_*` env vars for UAE government sites. |
| **SOAX tunnel failure** (FAB via SOAX) | `ERR_TUNNEL_CONNECTION_FAILED` | 1. Route FAB without proxy (direct TLS). 2. Try different SOAX exit or mobile proxy. 3. TLS/H2 diagnostic (`--disable-http2`). |
| **Login / OTP gate** (ixigo, most booking flows) | Requires phone OTP before payment | 1. Expected — not a bot block. Use human-takeover live view to enter OTP. 2. Supply a real verified phone + receive OTP out-of-band. |

---

## 6. Recommended next steps (priority order)

> **Done:** SOAX UAE wired into `goose-execution` (`config.go` + `pod_manager.go`). u.ae and RTA
> confirmed accessible. **Still open:** Bayut CAPTCHA, FAB TLS, global Tier-1 sites.

1. **Use SOAX for UAE targets** — set `SOAX_PROXY_*` env vars (see Section 1). Match
   `SOAX_COUNTRY` / username to target region. Webshare remains default for non-UAE when SOAX
   env is unset.
2. **Route TLS-sensitive sites without proxy** — FAB (and possibly MakeMyTrip) fail through
   SOAX tunnel; add per-domain "direct egress" bypass for banking/TLS-fingerprint hosts.
3. **Persist a warmed profile per target** for Bayut/DataDome/Akamai — biggest remaining lever
   for CAPTCHA walls now that geo is fixed.
4. **Prefer on-page navigation** over deep-linked functional endpoints on Akamai-protected sites.
5. **Pin sticky SOAX session** (`sessionid-*` in username) per goose session for multi-step flows.
6. **Keep human-takeover live view** for OTP/CAPTCHA on Bayut and booking flows.
7. **Monitor SOAX trial quota** — 400 MB trial; block images in Chrome to reduce GB burn.

---

## 7. Quick scorecard

| Test set | Accessible | Partial | Blocked | Total |
|----------|-----------|---------|---------|-------|
| Global Tier-1 anti-bot (US Webshare) | 14 | 1 | 5 | 20 |
| UAE full probe (US Webshare) | 14 | 0 | 6 | 20 |
| UAE 6-site retest (SOAX UAE) | **4** | 0 | **2** | 6 |
| Deep booking flows | 1 (ixigo) | 1 (Resy) | 3 (MMT, BMS, OpenTable) | 5 |

**UAE government/news geo blocks: fixed with SOAX UAE** (u.ae, RTA, Gulf News, Khaleej).

**Remaining UAE hard blocks:** Bayut (CAPTCHA), FAB (TLS/tunnel).

**Deep transactional flow success** still low on global Tier-1 sites — needs warmed profiles +
TLS work beyond geo proxy alone.

---

## 8. Expedia / DataDome — five-upgrade human flow (Jun 2026)

Validated on Bright Data Scraping Browser (`BRIGHTDATA_COUNTRY=us`):

| Step | Method | Result |
|------|--------|--------|
| Direct `navigate_page` → expedia.com | goto() | ❌ "Bot or Not?" immediately |
| Google → organic Expedia link | Human entry | ✅ Travel-guide page with full UI |
| Dwell 8–12s + scroll on guide page | Session trust | ✅ `datadome` cookie set |
| Click "Next weekend" / widget (same tab) | Widget, not URL | ❌ DataDome on `Hotel-Search?...` |
| `navigate_page` → `Hotel-Search?regionId=...` | goto() deep link | ❌ Known bot pattern — never use |

**Agent rules (goose `prompt.go` + skill `expedia-datadome`):**

1. **Never goto() Hotel-Search URLs** — use the on-page search widget.
2. **Google → organic click** before any Expedia page.
3. **Same tab/session** — carry `datadome` cookies; no `new_page` for search.
4. **Intercept XHR/fetch** (`list_network_requests` → `get_network_request`) for hotel JSON.
5. **Decision tree** — if blocked: check cookie, dwell time, widget vs goto(); captcha → noVNC handoff.

Test script: `node scripts/test-expedia-human-flow.mjs` (Bright Data auth required).
