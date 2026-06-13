---
name: expedia-datadome
description: |
  Expedia and DataDome workflow on Bright Data Scraping Browser. Use for expedia.com /
  expedia.ae hotel or flight search. Never goto() Hotel-Search URLs — use the on-page widget.
---

Load via `load_skill("expedia-datadome")` in goose before any Expedia task.

## Entry (Bright Data)

Mirror the BD Playground pattern — **direct homepage**, no Google warm-up:

1. `navigate_page` → `https://www.expedia.com/` with `waitUntil: domcontentloaded`
2. Dismiss popups (Close / Dismiss buttons)
3. Short settle (~3s) for DataDome sensor scripts
4. Fill destination/dates in the **on-page search widget** (same tab)
5. **`click_human`** on Search with `useBaseline: true` — not `click` or deep-link goto

Do **not** CDP-inject WebGL/UA stealth patches on BD — BD manages fingerprint coherence.

## Hard rules

- **Never** `navigate_page` to `Hotel-Search?regionId=...&startDate=...`
- **Same tab** throughout — carry cookies through search
- **`list_network_requests`** + **`get_network_request`** for hotel JSON (Hotel-Search DOM may be BD robots.txt restricted)
- Captcha → `request_user_input` + live view screencast handoff (`:6080`)

## Smoke test

```bash
BRIGHTDATA_AUTH='...' BRIGHTDATA_COUNTRY=us node scripts/test-expedia-playground.mjs
EXPEDIA_SUBMIT=1 node scripts/test-expedia-playground.mjs  # includes widget submit
```

Success = homepage `ACCESSIBLE`, or search navigates to `Hotel-Search` without DataDome block.
