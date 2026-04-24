---
name: scienceswarm-md-system-definition
description: Define the exact molecular system for an MD study, including entities, structures, states, cofactors, protonation, membranes, ions, and preparation risks.
---

# ScienceSwarm MD System Definition

Use this skill when implementation would otherwise guess what molecules, states,
or environment the MD run should contain.

## Workflow

1. Convert the study question into a precise molecular system.
2. Record entities, identifiers, structure source, state, environment, and
   preparation risks.
3. Mark unresolved choices and whether they block parameter planning.
4. Produce a `Molecular System Definition` with
   `asset_kind: md_system_definition` and a `Confidence Boundary`.

Do not let later coding-agent work silently choose missing system properties.
