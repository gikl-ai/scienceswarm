---
name: scienceswarm-scm-scratch-question-design
description: "Frame the from-scratch synthetic-control research question and turn it into an approval-gated analysis plan before code exists."
owner: scienceswarm
runtime: in-session
tier: synthetic-control-from-scratch
aliases:
  - scm-scratch-question
outputs:
  - SCM From-Scratch Study Brief brain asset with asset_kind scm_scratch_study_brief
  - SCM from-scratch execution plan
  - approval-gated next actions
  - Confidence Boundary
---

# ScienceSwarm SCM From-Scratch Question Design

Use this skill when a researcher starts with a substantive question and needs a real synthetic-control research design before any R files, prepared panels, or model scripts exist.

## Stage Contract

This is a plan-first stage. Do not write R code, fetch data, or run analysis in this stage unless the user explicitly changes the request. The output is the study brief and the next approved analysis step.

## Workflow

1. Restate the research question as a causal estimand: treated unit, treatment date, outcome, comparison population, pre-period, post-period, and target interpretation.
2. Map the same SCM methodology used by the quickstart: classic Abadie synthetic control as the primary estimator, method comparison as robustness, permutation-style placebo checks, and a final report with tables and plots comparable to the existing demo.
3. Specify donor inclusion and exclusion criteria before data acquisition. Exclude co-shocked units, direct spillover units, and units lacking sufficient pre-treatment coverage. For the SCM-IR from-scratch tutorial, keep main donor pools comparable to the SCM-IR quickstart: OECD-style country donors for Brexit, upper-middle-income country donors for Russia, and Basque regional donors that exclude only the Spain national aggregate in the main specification. Madrid, Catalonia, or Navarre belong in sensitivity checks unless the user explicitly makes them main-analysis exclusions.
4. List assumptions and diagnostics that must be checked: no anticipation, stable donor outcomes, strong pre-treatment fit, donor-weight interpretability, placebo rank, and sensitivity to donors or treatment year.
5. Define the artifact lifecycle under the active ScienceSwarm study:
   - analysis/scm-from-scratch/plan/scm-study-brief.md
   - analysis/scm-from-scratch/plan/stage-plan.json
   - analysis/scm-from-scratch/code/ for generated R files after approval
   - analysis/scm-from-scratch/data/raw/ and analysis/scm-from-scratch/data/prepared/
   - analysis/scm-from-scratch/output/ for fits, tables, plots, logs, and reports
6. Produce an SCM From-Scratch Study Brief with asset_kind: scm_scratch_study_brief.

## Execution Gate

End with a short approval gate. Offer exactly the next 2 or 3 actions, such as authoring the data acquisition R skeleton, refining donor exclusions, or changing the outcome. Only proceed to code generation when the user selects one action.

## Artifact Capture

When the scienceswarm MCP tools are available, save the brief with gbrain_capture before answering. Use a clear title, the asset kind above, and the active study. If saving fails, report the exact save failure and do not present the brief as durable.

## Confidence Boundary

State what the design supports, what remains unvalidated until data are acquired, and what evidence would force a redesign before any model fit is attempted.
