---
name: db-arxiv
description: 'Fetch papers from arXiv by ID, or search arXiv by query'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [paper]
network: external
network_domains: [export.arxiv.org, arxiv.org]
tools:
  - arxiv_fetch
  - arxiv_search
secrets: []
outputs:
  - paper entity pages at literature/paper-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "AX"
---

# arXiv Database Wrapper

Use this skill when the user asks for an arXiv paper, arXiv ID, preprint,
or arXiv search.

## Tools

- `arxiv_fetch`: exact-ID lookup by arXiv ID. Persists one paper entity.
- `arxiv_search`: free-text search. Persists one search-result page listing
  hit IDs; it does not auto-persist every hit as a paper page.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
paper entity using DOI when present, then arXiv ID. Search creates one
`searches/<hash>.md` page with hit IDs.

External titles and abstracts are sanitized and size-capped before the agent
uses them.
