---
name: db-orcid
description: 'Fetch ORCID public records by iD, or search ORCID people'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [person]
network: external
network_domains: [pub.orcid.org, orcid.org]
tools:
  - orcid_fetch
  - orcid_search
secrets: []
outputs:
  - person entity pages at people/person-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "ID"
---

# ORCID Database Wrapper

Use this skill when the user asks for an ORCID iD, researcher identity,
affiliations, works count, or ORCID search.

## Tools

- `orcid_fetch`: exact public-record lookup by ORCID iD. Persists one person entity.
- `orcid_search`: free-text people search. Persists one search-result page
  listing hit IDs.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
person entity using ORCID iD as the primary ID. Search creates one
`searches/<hash>.md` page with hit IDs.

External names and affiliations are sanitized and size-capped before the agent
uses them.
