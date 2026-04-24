---
name: scienceswarm-md-study-design
description: Clarify a molecular dynamics research goal, decide whether MD is the right method, and create an MD Study Brief with missing scientific inputs and confidence boundaries.
---

# ScienceSwarm MD Study Design

Use this skill when a molecular dynamics request needs scientific scoping before
implementation. The output is a brain-file plan, not code.

## Workflow

1. Restate the biological or therapeutic decision the user wants to inform.
2. Convert it into a bounded simulation question.
3. Map the desired claim to MD observables, needed controls/comparisons,
   decision thresholds, and inconclusive outcomes.
4. Compare MD with adjacent methods that may answer the claim better.
5. Classify MD suitability as `md-fit`, `md-with-caveats`,
   `use-adjacent-method-first`, or `under-specified`.
6. Name missing inputs and stop criteria.
7. Produce an `MD Study Brief` with `asset_kind: md_study_brief` and a
   `Confidence Boundary`.

If the question is under-specified, stop with clarifying questions instead of
inventing the molecular system.
