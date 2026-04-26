---
name: scienceswarm-scm-question-design
description: "Frame an international-relations or social-science research question for synthetic control analysis: identify the treated unit, treatment date, donor pool, outcome of interest, and decide whether SCM is the right method."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-pipeline
aliases:
  - scm-question
outputs:
  - SCM Study Brief brain asset with asset_kind scm_study_brief
  - SCM suitability verdict
  - confidence boundary
---

# ScienceSwarm SCM Question Design

Use this skill when a researcher needs to turn a substantive question about a
policy shock, sanction, treaty, regime change, or natural experiment into a
synthetic-control research design — before any data is pulled or models are
fit.

## Workflow

1. Identify the substantive question, the proposed treated unit (country,
   state, city, firm), the precise treatment date, and the candidate
   counterfactual donors.
2. Map the substantive claim to a measurable outcome variable with a clear
   pre-treatment time series.
3. Verify the donor pool is structurally comparable to the treated unit,
   has no co-shocked members, and has at least 15 candidates with
   adequate pre-period coverage.
4. Compare SCM with adjacent methods (DiD, RDD, event study, gsynth,
   synthetic DiD) and note when each would be more appropriate.
5. Decide whether the scoped question is `scm-fit`, `scm-with-caveats`,
   `use-adjacent-method-first`, or `under-specified`.
6. Produce an `SCM Study Brief` brain asset with `asset_kind:
   scm_study_brief` containing treated unit, treatment date, donor pool
   inclusion/exclusion criteria, primary outcome, secondary outcomes,
   pre/post windows, and a `Confidence Boundary` that states what the
   brief supports and what would change the recommendation.

When the `scienceswarm` MCP tools are available, save the brief with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
and the active project. If saving fails, report the exact save failure and do
not present the brief as durable.

Do not start data acquisition until the treated unit, treatment date,
donor pool, and outcome are explicit.
