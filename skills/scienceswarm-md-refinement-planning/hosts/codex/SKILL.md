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
4. Justify why the chosen next run or method will teach something new, and list
   rejected decision values.
5. Stop low-value rerun loops. Repeated unresolved failures require expert
   review, a method switch, or experimental validation.
6. State proposed changes, risks, and expected effects.
7. Produce a `Refinement Decision Update` with
   `asset_kind: md_refinement_decision_update` and a `Confidence Boundary`.

If another run is needed, specify which upstream assets must be updated before a
new handoff.
