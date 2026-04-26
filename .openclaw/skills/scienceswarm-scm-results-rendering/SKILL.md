---
name: scienceswarm-scm-results-rendering
description: Render the synthetic-control results as a single interactive HTML report with animated counterfactual trajectory, donor weights, placebo distribution, what-if falsification chart, multi-outcome panel, methodology modal, and an auto-generated paper-ready Methods paragraph.
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
   - Donor weight bar chart with hover/click highlighting
   - Placebo distribution of post/pre RMSPE ratios (treated highlighted)
   - "What-if" treatment-year falsification chart (in-time placebo)
   - Multi-outcome panel for secondary outcomes
   - Method-comparison forest plot (ATT with 95% CI per method)
   - Auto-generated Methods paragraph with all reportable numbers
2. Add a page-level toggleable Methodology Explainer modal aimed at
   non-experts (60-second SCM primer plus a "when not to use it"
   section).
3. Render with `plotly` + `htmltools::save_html`. The deliverable is one
   HTML file plus a sibling library folder of embedded Plotly assets.
4. Run the final validation gate: report file size ≥ 200 KB; all seven
   wow-element headings present in the HTML; Methods paragraph contains
   the headline ATT, pre-RMSPE, and placebo p-value.
5. Produce an `SCM Results Report` brain asset with `asset_kind:
   scm_results_report` linking to the HTML, summarizing the headline
   ATT per case, and including a `Confidence Boundary` that names what
   the report supports and what would change the headline.

The HTML report is the user-facing artifact. Every claim it makes
should be traceable to a brain asset produced earlier in the pipeline.
