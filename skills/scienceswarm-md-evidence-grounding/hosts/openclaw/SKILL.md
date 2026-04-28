---
name: scienceswarm-md-evidence-grounding
description: Search the study paper library first, then external sources, to collect comparable MD protocols, key papers, structures, targets, ligands, and evidence gaps.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-evidence
outputs:
  - Evidence Grounding Packet brain asset with asset_kind md_evidence_grounding_packet
  - study-library-first source list
  - comparable protocol patterns
---

# ScienceSwarm MD Evidence Grounding

Use this skill after `scienceswarm-md-study-design` when the user needs
literature-grounded MD planning rather than unsupported parameter guesses.

Search the user's study library first. Only move to external sources when the
study library is insufficient or the user asks for outside evidence.

## Source Priority

1. Study Paper Library and gbrain artifacts.
2. Study notes, prior study briefs, run logs, and decision records.
3. PDB, UniProt, ChEMBL, PubMed, OpenAlex, Crossref, arXiv, and bioRxiv.
4. Official tool documentation and recognized best-practice references.

## Evidence Classes

Use these labels consistently:

- `study-literature`: evidence from the user's library or study memory.
- `external-literature`: evidence from outside papers, databases, or official
  records.
- `common-heuristic`: common practice without direct study-specific support.
- `tool-default`: a default inherited from a simulation package or workflow.
- `speculative`: plausible but weakly supported.

## What To Extract

- Comparable molecular systems.
- Force fields, water models, ion conditions, ensembles, timesteps, restraints,
  equilibration, production lengths, and analysis metrics.
- Structures, PDB IDs, UniProt accessions, ChEMBL IDs, and ligand identifiers.
- Transferability limits: system class, timescale, ligand chemistry, membrane
  context, force-field family, and assay or simulation endpoint differences.
- Validation basis: experimental benchmark, prior simulation benchmark,
  reproduced protocol, or setup-only report.
- Method limitations or contradictions across papers.
- Contradictory protocols or negative/null results that affect confidence.
- Papers the user should read before trusting the setup.

## Output Shape

Produce an `Evidence Grounding Packet`:

```markdown
# Evidence Grounding Packet: {study title}

## Study-Library Evidence

| Source | Relevant System | Protocol Details | Evidence Class | Transferability | Validation Basis | Notes |
|---|---|---|---|---|---|---|

## External Evidence

| Source | Relevant System | Protocol Details | Evidence Class | Transferability | Validation Basis | Notes |
|---|---|---|---|---|---|---|

## Comparable Protocol Patterns

## Evidence Adequacy Triage

`enough-to-plan | proceed-with-caveats | stop-for-evidence | seek-expert-input`

## Transferability Risks

| Source Or Pattern | Risk | Downstream Impact | Mitigation |
|---|---|---|---|

## Key Papers To Read

## Conflicts And Disagreements

## Evidence Gaps

## Recommendations For Downstream Skills

## Confidence Boundary

What this asset supports:
- ...

What it does not support:
- ...

What would change this recommendation:
- ...
```

Use frontmatter when saving:

```yaml
type: research_packet
asset_kind: md_evidence_grounding_packet
status: active
privacy: local-only
tags: [molecular-dynamics, md-pipeline, evidence]
```

## Stop Conditions

Stop and report an evidence gap if comparable protocols cannot be found for an
expert-sensitive system. Do not fill that gap with confident defaults.
