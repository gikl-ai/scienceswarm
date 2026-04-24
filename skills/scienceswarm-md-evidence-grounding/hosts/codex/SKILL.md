---
name: scienceswarm-md-evidence-grounding
description: Search the project paper library first, then external sources, to collect comparable MD protocols, key papers, structures, targets, ligands, and evidence gaps.
---

# ScienceSwarm MD Evidence Grounding

Use this skill when MD planning depends on papers, protocols, structures, or
database records. The source order is project library first, external sources
second.

## Workflow

1. Identify evidence needed by the MD Study Brief.
2. Gather project-library sources before external sources.
3. Extract protocol details and comparable system choices.
4. Judge transferability, validation basis, and limits for each source before
   reusing a protocol.
5. Preserve conflicts, negative/null results, and gaps instead of smoothing
   them over.
6. Write an `Evidence Grounding Packet` with
   `asset_kind: md_evidence_grounding_packet`, evidence classes, and a
   `Confidence Boundary`.

Prefer source-backed statements over general MD memory.
