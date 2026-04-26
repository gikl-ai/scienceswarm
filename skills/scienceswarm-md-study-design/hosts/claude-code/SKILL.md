---
name: scienceswarm-md-study-design
description: Clarify a molecular dynamics research goal, decide whether MD is the right method, and create an MD Study Brief with missing scientific inputs and confidence boundaries.
---

# ScienceSwarm MD Study Design

Use this skill when a scientist needs to turn a biological or therapeutic goal
into an MD study question before any files or parameters are generated.

## Workflow

1. Identify the research goal, molecular system, cancer or therapeutic context,
   desired conclusion, and available study evidence.
2. Map the desired claim to MD observables, needed controls/comparisons,
   decision thresholds, and inconclusive outcomes.
3. Compare MD with adjacent methods that may answer the claim better.
4. Decide whether the scoped question is `md-fit`, `md-with-caveats`,
   `use-adjacent-method-first`, or `under-specified`.
5. List missing scientific inputs and stop criteria.
6. Produce an `MD Study Brief` brain asset using `asset_kind: md_study_brief`.
7. Include a `Confidence Boundary` section that states what the brief supports,
   what it does not support, and what would change the recommendation.

When the `scienceswarm` MCP tools are available, save the brief with
`gbrain_capture` before answering. Use a clear title, the asset kind above, and
the active project. If saving fails, report the exact save failure and do not
present the brief as durable.

Do not start parameter planning until the simulation question and method
suitability are explicit.
