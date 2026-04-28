---
name: scienceswarm-scm-inference-and-placebos
description: "Summarize synthetic-control inference: in-space donor placebos, clearly labeled in-time falsification support, and leave-one-out sensitivity status."
---

# ScienceSwarm SCM Inference and Placebos

Use this skill once a fitted SC model exists and the cross-method check
has passed. Standard SC inference is non-parametric; this skill reports
which placebo families were fully run, approximated, or deferred.

## Workflow

1. **In-space placebo (Abadie/Diamond/Hainmueller 2010).** Use the
   donor-refit permutation stored in the classic fit artifacts. Compute
   the post/pre RMSPE ratio for each placebo. The exact p-value is the
   share of placebos with ratio >= the treated unit's ratio.
2. **In-time placebo / falsification.** Report the available
   treatment-year falsification evidence. If the runtime uses the
   tutorial renderer's fast no-refit approximation instead of full
   refits, label it as approximated in the confidence boundary.
3. **Leave-one-out donor sensitivity.** Report LOO refits only when the
   artifacts exist. Otherwise list the top-weighted donors that must be
   dropped in a full sensitivity pass and mark this family as deferred.
4. Run any compact tutorial summary script when available, such as
   `scripts/05_summarize_inference.R`, and cite its Markdown/JSON output
   instead of pasting raw R console tables.
5. Report: exact p-value, placebo distribution, in-time falsification
   status, leave-one-out status. Do not report only a single ATT point
   estimate.
6. Produce an `SCM Inference Note` brain asset with `asset_kind:
   scm_inference_note` containing all three placebo families and a
   `Confidence Boundary` that names which placebo, if any, is closest to
   undermining the result.

When the `scienceswarm` MCP tools are available, save the inference note with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active study, and links or references to the upstream fit and method
comparison notes. If saving fails, report the exact save failure and do not
present the note as durable.

Do not present an inference family as completed unless the corresponding
artifact was actually run. The final HTML report can be produced after the
inference note clearly names which checks were run, approximated, or deferred.
