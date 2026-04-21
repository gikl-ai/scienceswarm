---
name: db-pubmed
description: 'Fetch papers from PubMed by PMID or DOI, or search PubMed by query'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [paper]
network: external
network_domains: [eutils.ncbi.nlm.nih.gov, pubmed.ncbi.nlm.nih.gov]
tools:
  - pubmed_fetch
  - pubmed_search
secrets:
  - NCBI_API_KEY
outputs:
  - paper entity pages at literature/paper-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "PM"
---

# PubMed Database Wrapper

Use this skill when the user asks for a biomedical paper, PMID, DOI, author
paper lookup, or PubMed search.

## Tools

- `pubmed_fetch`: exact-ID lookup by PMID or DOI. Persists one paper entity.
- `pubmed_search`: free-text search. Persists one search-result page listing
  hit IDs; it does not auto-persist every hit as a paper page.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
paper entity using DOI as the preferred primary ID, then PMID. Search creates
one `searches/<hash>.md` page with hit IDs.

External titles and abstracts are sanitized, size-capped, and wrapped as
external source content before the agent uses them.
