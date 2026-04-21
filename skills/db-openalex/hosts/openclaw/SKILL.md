---
name: db-openalex
description: 'Fetch OpenAlex works or authors, or search OpenAlex by query'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [paper, person]
network: external
network_domains: [api.openalex.org, openalex.org]
tools:
  - openalex_fetch
  - openalex_search
secrets:
  - OPENALEX_MAILTO
outputs:
  - paper entity pages at literature/paper-*.md
  - person entity pages at people/person-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "OA"
---

# OpenAlex Database Wrapper

Use this skill when the user asks for OpenAlex works, authors, institutions
through author metadata, or broad scholarly graph search.

## Tools

- `openalex_fetch`: exact lookup for a work or author. Persists one entity page.
- `openalex_search`: free-text search across works or authors. Persists one
  search-result page listing hit IDs.

## Persistence Contract

All writes go through `db-base` and gbrain. Work lookups use DOI when present,
then OpenAlex work ID. Author lookups use ORCID when present, then OpenAlex
author ID. Search creates one `searches/<hash>.md` page with hit IDs.

`OPENALEX_MAILTO` is optional but recommended for OpenAlex polite-pool access.
External metadata is sanitized and size-capped before the agent uses it.
