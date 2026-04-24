---
name: scienceswarm-md-refinement-planning
description: Decide whether an MD study should stop, rerun, extend, adjust parameters, change system definition, switch methods, seek expert review, or seek experimental validation.
---

# ScienceSwarm MD Refinement Planning

Use this skill to decide the next move after MD results or failures.

## Workflow

1. Read the interpretation, run log, parameter ledger, and new evidence.
2. Diagnose the problem and confidence.
3. Decide whether to stop, rerun, extend, adjust parameters, change the system,
   switch methods, seek expert review, or seek experimental validation.
4. State proposed changes, risks, and expected effects.
5. Produce a `Refinement Decision Update` with
   `asset_kind: md_refinement_decision_update` and a `Confidence Boundary`.

If another run is needed, specify which upstream assets must be updated before a
new handoff.
