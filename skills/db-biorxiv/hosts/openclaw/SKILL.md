---
name: db-biorxiv
description: 'Fetch bioRxiv or medRxiv preprints by DOI, or search recent preprints'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [paper]
network: external
network_domains: [api.biorxiv.org, doi.org]
tools:
  - biorxiv_fetch
  - biorxiv_search
secrets: []
outputs:
  - paper entity pages at literature/paper-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "BX"
---

# bioRxiv / medRxiv Database Wrapper

Use this skill when the user asks for a bioRxiv or medRxiv preprint, DOI, or
recent preprint search.

## Tools

- `biorxiv_fetch`: exact DOI lookup on bioRxiv or medRxiv. Persists one paper entity.
- `biorxiv_search`: recent-date search with optional date range. Persists one
  search-result page listing hit IDs.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
paper entity using DOI as the primary ID. Search creates one `searches/<hash>.md`
page with hit IDs.

External titles and abstracts are sanitized and size-capped before the agent
uses them. Withdrawn and retracted preprints surface lifecycle status.
