---
name: db-semantic-scholar
description: 'Fetch papers from Semantic Scholar by ID, or search Semantic Scholar by query'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [paper]
network: external
network_domains: [api.semanticscholar.org, semanticscholar.org]
tools:
  - semantic_scholar_fetch
  - semantic_scholar_search
secrets:
  - SEMANTIC_SCHOLAR_API_KEY
outputs:
  - paper entity pages at literature/paper-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "SS"
---

# Semantic Scholar Database Wrapper

Use this skill when the user asks for Semantic Scholar paper metadata,
paper IDs, DOI/arXiv/PubMed identifier lookup, or citation-oriented search.

## Tools

- `semantic_scholar_fetch`: exact paper lookup. Persists one paper entity.
- `semantic_scholar_search`: free-text paper search. Persists one search-result
  page listing hit IDs.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
paper entity using DOI when present, then Semantic Scholar paper ID. Search
creates one `searches/<hash>.md` page with hit IDs.

`SEMANTIC_SCHOLAR_API_KEY` is required. External titles and abstracts are
sanitized and size-capped before the agent uses them.
