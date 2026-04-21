---
name: db-clinicaltrials
description: 'Fetch ClinicalTrials.gov studies by NCT ID, or search trials'
owner: scienceswarm
runtime: in-session
tier: database
entity_types: [trial]
network: external
network_domains: [clinicaltrials.gov]
tools:
  - clinicaltrials_fetch
  - clinicaltrials_search
secrets: []
outputs:
  - trial entity pages at trials/trial-*.md
  - search-result pages at searches/*.md
metadata:
  openclaw:
    emoji: "CT"
---

# ClinicalTrials.gov Database Wrapper

Use this skill when the user asks for a clinical trial, NCT ID, trial status,
phase, intervention, condition, or ClinicalTrials.gov search.

## Tools

- `clinicaltrials_fetch`: exact NCT lookup. Persists one trial entity.
- `clinicaltrials_search`: free-text study search. Persists one search-result
  page listing hit IDs.

## Persistence Contract

All writes go through `db-base` and gbrain. Exact lookups create or update one
trial entity using NCT ID as the primary ID. Search creates one
`searches/<hash>.md` page with hit IDs.

External study text is sanitized and size-capped before the agent uses it.
Recruiting, active, completed, terminated, and withdrawn states surface in the
trial lifecycle field.
