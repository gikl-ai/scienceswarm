---
name: scienceswarm-scm-method-comparison
description: Run modern SCM variants — generalized SCM (Xu), synthetic DiD (Arkhangelsky et al.), and doubly-robust SC (Ben-Michael et al.) — alongside classic Abadie SCM and gate the result on cross-method sign consistency.
---

# ScienceSwarm SCM Method Comparison

Use this skill once a classic-SC fit exists (see
`scienceswarm-scm-pretreatment-fit`). The job is to check whether the
ATT is robust to modeling choices.

## Workflow

1. Re-fit the same case with three modern variants:
   - `gsynth` (Xu 2017) — generalized SCM with interactive fixed effects
     for unobserved heterogeneity.
   - `synthdid` (Arkhangelsky et al. 2021) — combines SC unit weights
     with DiD time weights; doubly-robust to either model being correct.
   - Doubly-robust SC (Ben-Michael, Feller, Rothstein 2021) — augments
     SC with an outcome-model bias correction.
2. Standardize all four estimates onto the same ATT scale (effect on
   the primary outcome, averaged over the post-treatment window).
3. Apply the robustness gate: at least 3 of 4 methods must agree on the
   sign of the ATT. If methods disagree, the result is too fragile to
   report; return to the data-acquisition or pretreatment-fit stage.
4. Produce an `SCM Method Comparison Note` brain asset with `asset_kind:
   scm_method_comparison_note` listing each method's ATT, standard
   error, and confidence interval, and a `Confidence Boundary` that
   states which method is the headline estimate and why.

When the `scienceswarm` MCP tools are available, save the comparison note with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active project, and links or references to the upstream fit note. If
saving fails, report the exact save failure and do not present the note as
durable.

Do not report a headline ATT without cross-method confirmation.
