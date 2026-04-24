---
name: scienceswarm-md-system-definition
description: Define the exact molecular system for an MD study, including entities, structures, states, cofactors, protonation, membranes, ions, and preparation risks.
---

# ScienceSwarm MD System Definition

Use this skill to define what will actually be simulated before parameter
planning or execution.

## Workflow

1. Read the MD Study Brief and Evidence Grounding Packet.
2. Define molecular entities, structures, states, cofactors, modifications,
   protonation, charge, membrane, solvent, ions, and relevant therapeutic
   context.
3. Mark unresolved choices as blocking or non-blocking.
4. List preparation risks and downstream parameter implications.
5. Produce a `Molecular System Definition` with
   `asset_kind: md_system_definition`.

Include a `Confidence Boundary` section in the definition.

Stop if identity, charge, protonation, cofactors, or membrane composition are
unknown and material to the question.
