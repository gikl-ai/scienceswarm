---
name: scienceswarm-scm-inference-and-placebos
description: Run permutation-based inference for synthetic control: in-space placebos across donors, in-time placebos across alternate treatment years, and leave-one-out donor sensitivity.
---

# ScienceSwarm SCM Inference and Placebos

Use this skill once a fitted SC model exists and the cross-method check
has passed. Standard SC inference is non-parametric; this skill runs
the three placebo families and reports them.

## Workflow

1. **In-space placebo (Abadie/Diamond/Hainmueller 2010).** Re-fit the
   synthetic control once for each donor unit, treating that donor as if
   it were the treated unit. Compute the post/pre RMSPE ratio for each
   placebo. The exact p-value is the share of placebos with ratio ≥ the
   treated unit's ratio.
2. **In-time placebo / falsification.** Re-assign treatment to alternate
   years inside the pre-period. The post/pre RMSPE ratio at the actual
   treatment year should stand out clearly above the placebo
   distribution; if it does not, the fit may be picking up pre-existing
   trends rather than the shock.
3. **Leave-one-out donor sensitivity.** Re-fit dropping the
   heaviest-weighted donor; the ATT should not change sign or move by
   more than ~25%.
4. Report: exact p-value, placebo distribution, in-time falsification
   plot, leave-one-out range. Do not report only a single ATT point
   estimate.
5. Produce an `SCM Inference Note` brain asset with `asset_kind:
   scm_inference_note` containing all three placebo families and a
   `Confidence Boundary` that names which placebo, if any, is closest to
   undermining the result.

Do not produce the final HTML report until all three placebo families
have been run and reported.
