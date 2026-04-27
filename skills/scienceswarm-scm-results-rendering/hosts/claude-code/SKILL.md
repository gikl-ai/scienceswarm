---
name: scienceswarm-scm-results-rendering
description: Render the synthetic-control results as a single interactive HTML report with animated counterfactual trajectory, donor weights, placebo distribution, what-if falsification chart, method-comparison forest plot, methodology modal, and an auto-generated paper-ready Methods paragraph.
---

# ScienceSwarm SCM Results Rendering

Use this skill once classic SC fit, method-comparison, and inference
notes are all approved. The job is to package the result as a single
interactive HTML page a researcher can drop into a paper, blog, or
policy memo.

## Workflow

1. Build seven elements per case:
   - Animated counterfactual trajectory (treated vs. synthetic, gap fills
     in over the post-treatment window)
   - Donor weight bar chart with hover-readable country weights
   - Placebo distribution of post/pre RMSPE ratios (treated highlighted)
   - "What-if" treatment-year falsification chart (in-time placebo)
   - Method-comparison forest plot (ATT with 95% CI per method)
   - Methodology Explainer modal
   - Auto-generated Methods paragraph with all reportable numbers
2. Add a page-level toggleable Methodology Explainer modal aimed at
   non-experts (60-second SCM primer plus a "when not to use it"
   section).
3. Render with `plotly` + `htmltools::save_html`. In the SCM-IR tutorial
   runtime, run `scripts/06_render_html.R`. The deliverable is one HTML
   file plus a sibling library folder of embedded Plotly assets.
4. Run the final validation gate: report HTML plus sibling `lib/` assets
   total at least 1 MB; all seven wow-element headings are present in the
   HTML; Methods paragraph contains
   the headline ATT, pre-RMSPE, and placebo p-value.
5. Produce an `SCM Results Report` brain asset with `asset_kind:
   scm_results_report` linking to the HTML, summarizing the headline
   ATT per case, and including a `Confidence Boundary` that names what
   the report supports and what would change the headline.

When the `scienceswarm` MCP tools are available, save the report asset with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active study, the report path, and links or references to the upstream
SCM notes. If saving fails, report the exact save failure and do not present
the report as durable.

The HTML report is the user-facing artifact. Every claim it makes
should be traceable to a brain asset produced earlier in the pipeline.
Do not tell UI users to run `open`, `ls`, `du`, or other shell commands as a
required final step. Summarize the path and validation result in prose.
