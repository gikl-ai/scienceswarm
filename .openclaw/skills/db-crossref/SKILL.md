---
name: db-crossref
description: 'Fetch scholarly works from Crossref by DOI, or search Crossref by query'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [paper]
network: external
network_domains: [api.crossref.org, doi.org]
tools:
  - crossref_fetch
  - crossref_search
secrets:
  - CROSSREF_MAILTO
outputs:
  - paper entity pages at literature/paper-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "CR"
---

# Crossref Database Wrapper

Use this skill when the user asks for DOI metadata, publication venue details,
or Crossref search.

## Tools

- `crossref_fetch`: exact DOI lookup. Persists one paper entity.
- `crossref_search`: free-text work search. Persists one search-result page
  listing hit IDs.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
paper entity using DOI as the primary ID. Search creates one `searches/<hash>.md`
page with hit IDs.

`CROSSREF_MAILTO` is optional but recommended for Crossref polite-pool access.
External metadata is sanitized and size-capped before the agent uses it.
