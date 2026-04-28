---
name: scienceswarm-scm-pretreatment-fit
description: "Fit classic Abadie synthetic control: choose predictors, solve donor weights via the constrained quadratic program, and gate the fit on pre-period RMSPE relative to outcome variability."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-pipeline
aliases:
  - scm-fit
outputs:
  - SCM Pretreatment Fit Note brain asset with asset_kind scm_pretreatment_fit_note
  - donor weights and pre-period fit diagnostics
  - pass/fail fit gate
---

# ScienceSwarm SCM Pre-Treatment Fit

Use this skill once the data manifest is approved (see
`scienceswarm-scm-data-acquisition`). The job is to produce the
synthetic counterfactual and decide whether the pre-period fit is good
enough to interpret the post-period gap.

## Workflow

1. Choose the predictor set: pre-period averages of the predictors named
   in the brief, plus three lagged outcomes (typically at the start,
   middle, and end of the pre-period).
2. Solve donor weights with `tidysynth::generate_weights` (or the
   equivalent `Synth::synth` call). Weights are non-negative and sum to
   one — the synthetic unit lives inside the convex hull of donors.
3. Compute pre-period RMSPE in original outcome units, and the ratio of
   pre-period RMSPE to the outcome's own standard deviation.
4. Apply the fit gate: if `pre_rmspe / outcome_sd > 0.25`, the synthetic
   control is not tracking the pre-period closely enough to be
   interpreted as a counterfactual (Abadie 2021, JEL). Stop and revisit
   the donor pool or predictor list rather than reporting a result.
5. Report the donor weight concentration: a fit dominated by one or two
   donors is fragile; flag it for the inference stage.
6. Produce an `SCM Pretreatment Fit Note` brain asset with `asset_kind:
   scm_pretreatment_fit_note` containing the predictor list, weights,
   pre-RMSPE, RMSPE/SD ratio, and a `Confidence Boundary` describing
   what the fit supports.

When the `scienceswarm` MCP tools are available, save the fit note with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active study, and links or references to the upstream study brief and
data manifest. If saving fails, report the exact save failure and do not
present the note as durable.

Do not proceed to inference until the pre-period fit gate passes.
