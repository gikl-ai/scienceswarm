---
name: scienceswarm-md-refinement-planning
description: Decide whether an MD study should stop, rerun, extend, adjust parameters, change system definition, switch methods, seek expert review, or seek experimental validation.
---

# ScienceSwarm MD Refinement Planning

Use this skill after results interpretation, failed execution, or new evidence.

## Workflow

1. Review the Results Interpretation Note, Simulation Run Log, Parameter
   Decision Ledger, and any new evidence.
2. Diagnose whether the issue is setup, equilibration, sampling, parameters,
   analysis artifact, true system behavior, or method mismatch.
3. Choose `stop`, `rerun-same-protocol`, `extend-run`, `adjust-parameters`,
   `change-system-definition`, `switch-method`, `seek-expert-review`, or
   `seek-experimental-validation`.
4. Justify why the chosen next run or method will teach something new, and list
   rejected decision values.
5. Stop low-value rerun loops. Repeated unresolved failures require expert
   review, a method switch, or experimental validation.
6. Produce a `Refinement Decision Update` with
   `asset_kind: md_refinement_decision_update`.

Include a `Confidence Boundary` section in the decision update.

Do not silently change molecular identity, protonation, force field family,
membrane composition, ion/pH assumptions, or the scientific question.
