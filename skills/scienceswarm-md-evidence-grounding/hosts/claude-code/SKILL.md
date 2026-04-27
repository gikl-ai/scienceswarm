---
name: scienceswarm-md-evidence-grounding
description: Search the study paper library first, then external sources, to collect comparable MD protocols, key papers, structures, targets, ligands, and evidence gaps.
---

# ScienceSwarm MD Evidence Grounding

Use this skill to ground an MD plan in study evidence before parameters are
chosen.

## Workflow

1. Search the study paper library and existing gbrain artifacts first.
2. Use external sources only when study evidence is insufficient or requested.
3. Extract comparable systems, protocol details, structures, targets, ligands,
   conflicts, and key papers to read.
4. Judge transferability, validation basis, and limits for each source before
   reusing a protocol.
5. Label evidence as `study-literature`, `external-literature`,
   `common-heuristic`, `tool-default`, or `speculative`.
6. Preserve conflicts, negative/null results, and gaps instead of smoothing
   them over.
7. Produce an `Evidence Grounding Packet` with
   `asset_kind: md_evidence_grounding_packet`.

When the `scienceswarm` MCP tools are available, save the packet with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active study, and links or references to the upstream MD Study Brief.
If saving fails, report the exact save failure and do not present the packet as
durable.

Include a `Confidence Boundary` section in the packet.

Do not replace missing evidence with confident defaults.
