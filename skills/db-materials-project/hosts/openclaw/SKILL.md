---
name: db-materials-project
description: 'Fetch materials from Materials Project by mp-id or search summaries by formula'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [material]
network: external
network_domains: [api.materialsproject.org, materialsproject.org]
tools:
  - materials_project_fetch
  - materials_project_search
secrets:
  - MATERIALS_PROJECT_API_KEY
outputs:
  - material entity pages at materials/material-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "MP"
---

# Materials Project Database Wrapper

Use this skill when the user asks for a Materials Project material, mp-id,
crystal formula, band gap, hull energy, or material stability.

## Tools

- `materials_project_fetch`: exact lookup by mp-id. Requires
  `MATERIALS_PROJECT_API_KEY`.
- `materials_project_search`: formula or mp-id search. Persists one
  search-result page; it does not auto-persist every hit.

## Persistence Contract

All writes go through `db-base` and gbrain. Missing API keys fail with an
actionable `.env` and `/api/health` hint. External fields are sanitized and
stored as a material entity with `entity_type: material`.
