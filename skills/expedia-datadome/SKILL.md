---
name: expedia-datadome
description: |
  Expedia and DataDome/PerimeterX session-trust workflow. Use for expedia.com / expedia.ae
  hotel or flight search. Overrides generic booking deep-link rules — never goto() Hotel-Search URLs.
---

Canonical skill: `on-demand-goose-execution/skills/expedia-datadome/SKILL.md`

Load via `load_skill("expedia-datadome")` in goose before any Expedia task. Uses `click_human` /
`human_hover_path` (Gaussian-smoothed morphed mouse paths) for search intent trust.

**Never** `navigate_page` to `Hotel-Search?regionId=...&startDate=...` — use the on-page search widget
on the same tab after Google → organic click → 8–12s dwell.

Success = URL contains `Hotel-Search` or hotel JSON in xhr/fetch after search click.
