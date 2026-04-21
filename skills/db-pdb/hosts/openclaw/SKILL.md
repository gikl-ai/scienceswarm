---
name: db-pdb
description: 'Fetch structures from RCSB PDB by PDB ID or search PDB entries'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [structure]
network: external
network_domains: [data.rcsb.org, search.rcsb.org, www.rcsb.org]
tools:
  - pdb_fetch
  - pdb_search
secrets: []
outputs:
  - structure entity pages at structures/structure-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "PDB"
---

# PDB Database Wrapper

Use this skill when the user asks for a protein structure, PDB ID, structural
method, resolution, release date, or RCSB PDB search.

## Tools

- `pdb_fetch`: exact lookup by four-character PDB ID. Persists one structure
  entity.
- `pdb_search`: free-text search. Persists one search-result page listing
  structure IDs; it does not auto-persist every hit.

## Persistence Contract

All writes go through `db-base` and gbrain. PDB records become structure
entities with `entity_type: structure`, while gbrain stores them under the
existing `paper` content type until the broader content type union is widened.
