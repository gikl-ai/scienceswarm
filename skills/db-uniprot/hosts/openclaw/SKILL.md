---
name: db-uniprot
description: 'Fetch UniProtKB proteins by accession, or search UniProtKB'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [protein]
network: external
network_domains: [rest.uniprot.org, www.uniprot.org]
tools:
  - uniprot_fetch
  - uniprot_search
secrets: []
outputs:
  - protein entity pages at proteins/protein-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "UP"
---

# UniProt Database Wrapper

Use this skill when the user asks for a protein, UniProt accession, gene/protein
metadata, reviewed status, or UniProt search.

## Tools

- `uniprot_fetch`: exact UniProtKB accession lookup. Persists one protein entity.
- `uniprot_search`: free-text protein search. Persists one search-result page
  listing hit IDs. Pass the returned `cursor` as `page_token` to fetch the next
  UniProt result window.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
protein entity using UniProt accession as the primary ID. Search creates one
`searches/<hash>.md` page with hit IDs.

External protein names and comments are sanitized and size-capped before the
agent uses them. Reviewed and deprecated states surface lifecycle status.
