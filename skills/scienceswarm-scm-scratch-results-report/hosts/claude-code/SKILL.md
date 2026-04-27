---
name: scienceswarm-scm-scratch-results-report
description: "Author the final from-scratch SCM reporting code and surface comparable figures, tables, interpretation, and artifact links in the project."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-from-scratch
aliases:
  - scm-scratch-report
outputs:
  - SCM From-Scratch Results Report brain asset with asset_kind scm_scratch_results_report
  - approved report-rendering R code
  - HTML report, tables, figures, and run log
  - Confidence Boundary
---

# ScienceSwarm SCM From-Scratch Results Report

Use this skill after the from-scratch design, data, fit, method choice, and inference notes exist and the user has approved report authoring.

## Stage Contract

Generate or modify only the report assembly code and final report artifacts. Do not silently revisit upstream data, fit, or inference choices unless the user approves a return to that earlier stage.

## Dependency Policy

Do not write `install.packages(...)`, `remotes::install_*`, `pak::pkg_install(...)`, or other package-install commands into generated R files. Generated code may check dependencies with `requireNamespace()` and must stop with a clear missing-dependency message that the user can approve separately. If a required package is absent, propose the install location and action as a next step instead of installing automatically.

## Workflow

1. Read all latest from-scratch SCM assets: study brief, data plan, pretreatment fit note, method choice note, and inference note.
2. Propose the report plan before authoring code. The normal file is analysis/scm-from-scratch/code/06_render_report.R.
3. Assemble final artifacts comparable to the existing SCM demo:
   - treated versus synthetic trajectory plots,
   - donor-weight tables,
   - placebo distribution and sensitivity summaries,
   - method-comparison table or forest plot,
   - paper-ready methods paragraph,
   - interpretation with caveats and confidence boundary.
4. Write outputs to:
   - analysis/scm-from-scratch/output/scm-from-scratch-report.html
   - analysis/scm-from-scratch/output/lib/ when HTML dependencies are externalized
   - analysis/scm-from-scratch/output/tables/
   - analysis/scm-from-scratch/output/figures/
   - analysis/scm-from-scratch/output/run-log.md
5. Validate that the report links back to source assets and does not claim more than the diagnostics support.
6. Produce an SCM From-Scratch Results Report with asset_kind: scm_scratch_results_report.

## Execution Gate

Before generating 06_render_report.R, list the included artifacts, validation markers, output paths, and any limitations. Ask for approval for the reporting step. After completion, surface the final project artifact paths instead of asking the user to open files outside ScienceSwarm.

## Artifact Capture

When the scienceswarm MCP tools are available, save the results report with gbrain_capture. Include links or paths to the HTML report, run log, tables, and figures.

## Confidence Boundary

The final narrative must distinguish tutorial parity from a new political-science contribution. If diagnostics fail, the report should present a transparent failed or fragile SCM analysis rather than a polished causal claim.
