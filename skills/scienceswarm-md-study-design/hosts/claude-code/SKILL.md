---
name: scienceswarm-md-study-design
description: Clarify a molecular dynamics research goal, decide whether MD is the right method, and create an MD Study Brief with missing scientific inputs and confidence boundaries.
---

# ScienceSwarm MD Study Design

Use this skill when a scientist needs to turn a biological or therapeutic goal
into an MD study question before any files or parameters are generated.

## Workflow

1. Identify the research goal, molecular system, cancer or therapeutic context,
   desired conclusion, and available project evidence.
2. Decide whether the scoped question is `md-fit`, `md-with-caveats`,
   `use-adjacent-method-first`, or `under-specified`.
3. List missing scientific inputs and stop criteria.
4. Produce an `MD Study Brief` brain asset using `asset_kind: md_study_brief`.
5. Include a `Confidence Boundary` section that states what the brief supports,
   what it does not support, and what would change the recommendation.

Do not start parameter planning until the simulation question and method
suitability are explicit.
