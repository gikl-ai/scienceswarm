---
name: db-chembl
description: 'Fetch ChEMBL compounds by molecule ID, or search ChEMBL molecules'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [compound]
network: external
network_domains: [www.ebi.ac.uk]
tools:
  - chembl_fetch
  - chembl_search
secrets: []
outputs:
  - compound entity pages at compounds/compound-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "CH"
---

# ChEMBL Database Wrapper

Use this skill when the user asks for a compound, ChEMBL molecule ID, InChIKey,
drug-like molecule metadata, or ChEMBL search.

## Tools

- `chembl_fetch`: exact molecule lookup by ChEMBL ID. Persists one compound entity.
- `chembl_search`: free-text molecule search. Persists one search-result page
  listing hit IDs.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
compound entity using ChEMBL ID, with InChIKey as an alias when present. Search
creates one `searches/<hash>.md` page with hit IDs.

External molecule names and summaries are sanitized and size-capped before the
agent uses them. Withdrawn compounds surface discontinued lifecycle status.
