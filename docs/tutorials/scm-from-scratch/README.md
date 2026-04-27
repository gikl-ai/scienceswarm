# SCM from scratch - build a synthetic-control analysis in ScienceSwarm

This tutorial is the advanced, "real researcher" path for the same
international-relations question covered by the existing SCM quickstart:

- Brexit referendum, treated unit United Kingdom, treatment year 2016.
- Russia 2022 sanctions, treated unit Russian Federation, treatment year 2022.
- Basque Country / ETA terrorism, treated unit Basque Country, treatment year
  1975.

The statistical target is intentionally the same: classic Abadie synthetic
control as the primary estimator, method comparison as robustness, placebo and
sensitivity checks for inference, and a final report with comparable figures,
tables, and interpretation. The difference is that this path starts with an
empty analysis folder. The user and assistant design the workflow, generate R
code stage by stage, approve each action, and keep every artifact visible inside
the ScienceSwarm study.

No terminal is required for the human user. All planning, code authoring,
execution, and artifact review happens through the ScienceSwarm study UI and
the selected assistant runtime.

## Expected final state

- gbrain assets for the study brief, data plan, fit note, method choice note,
  inference note, results report, and run log.
- Generated R code under `analysis/scm-from-scratch/code/`.
- Raw and prepared data under `analysis/scm-from-scratch/data/`.
- Tables, figures, fit objects, execution notes, and final HTML under
  `analysis/scm-from-scratch/output/`.
- A final `analysis/scm-from-scratch/output/scm-from-scratch-report.html`
  report whose shape and diagnostic quality are comparable to the SCM-IR
  quickstart report.

## 0. Create the study

1. Start ScienceSwarm and complete setup if the app asks.
2. Open the dashboard and create a study named something like
   `SCM from scratch`.
3. Open the study chat composer.
4. Choose a runtime that can author and execute study files, such as
   `Claude Code`.
5. For each stage below, paste the prompt, wait for the assistant to save the
   named asset, review the proposed next actions, and approve only the step you
   want it to generate next.

Do not import the existing `docs/tutorials/scm-ir-quickstart/scripts/` folder
for this path. The whole point is to build the analysis from an empty study
analysis folder.

Generated R should check for required packages and stop with a clear missing
dependency message if the runtime is not ready. It should not install packages
automatically; any package installation remains a separate user-approved step.

## Skill map

| Step | Command | Skill | Main asset |
|---|---|---|---|
| 1 | `/scm-scratch-question` | `scienceswarm-scm-scratch-question-design` | `scm_scratch_study_brief` |
| 2 | `/scm-scratch-data` | `scienceswarm-scm-scratch-data-authoring` | `scm_scratch_data_plan` |
| 3 | `/scm-scratch-fit` | `scienceswarm-scm-scratch-pretreatment-fit` | `scm_scratch_fit_note` |
| 4 | `/scm-scratch-methods` | `scienceswarm-scm-scratch-method-choice` | `scm_scratch_method_choice_note` |
| 5 | `/scm-scratch-inference` | `scienceswarm-scm-scratch-inference-placebos` | `scm_scratch_inference_note` |
| 6 | `/scm-scratch-report` | `scienceswarm-scm-scratch-results-report` | `scm_scratch_results_report` |

## 1. Plan the question before code exists

Paste this into study chat:

```text
/scm-scratch-question Create the from-scratch SCM Study Brief.

Research question: using the synthetic control method, estimate how three
canonical international-relations shocks changed real GDP per capita:
Brexit for the United Kingdom in 2016, Russia 2022 sanctions for the Russian
Federation in 2022, and ETA terrorism for the Basque Country beginning in 1975.

Use classic Abadie synthetic control as the primary estimator, then plan modern
SCM robustness checks, in-space and in-time placebo checks, leave-one-out donor
sensitivity, and a final report comparable to the SCM-IR quickstart.

Start from an empty study analysis folder. Do not assume any prewritten R
files. Define the estimand, donor-pool rules, outcome, predictors, pre/post
windows, assumptions, stop criteria, artifact paths, and approval-gated next
actions. Keep the main donor pools comparable to the SCM-IR quickstart; for the
Basque case, exclude the Spain national aggregate in the main specification and
leave Madrid, Catalonia, and Navarre for sensitivity checks unless explicitly
approved as main exclusions. Save a study-scoped asset with asset_kind
scm_scratch_study_brief before answering.
```

Continue only after the assistant proposes the data acquisition action and
does not start writing R code in the same turn.

## 2. Author the data pull and panel munging code

Paste:

```text
/scm-scratch-data Use the latest scm_scratch_study_brief and author the first
from-scratch data step.

Plan the data code before writing it. The target study paths are:
analysis/scm-from-scratch/code/01_acquire_data.R
analysis/scm-from-scratch/code/02_build_panels.R
analysis/scm-from-scratch/data/raw/
analysis/scm-from-scratch/data/prepared/
analysis/scm-from-scratch/output/tables/data-audit.csv

Pull World Bank Development Indicators for the United Kingdom and Russia cases,
use the public Synth::basque data for the Basque Country case, and build
balanced unit-time panels for classic SCM. Treat outcome coverage, donor count,
and pre-period length as hard gates; treat sparse auxiliary predictors such as
schooling or human-capital proxies as optional drops that must be recorded in
the data audit. Do not copy or require existing quickstart scripts. Ask for
approval before generating each R file, then execute only the approved file
through the selected ScienceSwarm runtime. Save asset_kind
scm_scratch_data_plan with source notes, exclusions, balance checks, and
generated study paths before answering.
```

Expected data-stage outputs:

- `analysis/scm-from-scratch/code/01_acquire_data.R`
- `analysis/scm-from-scratch/code/02_build_panels.R`
- `analysis/scm-from-scratch/data/prepared/brexit.rds`
- `analysis/scm-from-scratch/data/prepared/russia.rds`
- `analysis/scm-from-scratch/data/prepared/basque.rds`
- `analysis/scm-from-scratch/output/tables/data-audit.csv`

If a panel has weak coverage, the right next step is to revise data choices or
donor rules, not to fit a model.

## 3. Author classic SCM fit code and gate the pre-period fit

Paste:

```text
/scm-scratch-fit Use the latest from-scratch study brief and data plan.

Plan and then, after approval, author only:
analysis/scm-from-scratch/code/03_fit_classic_scm.R

Fit classic Abadie synthetic control for Brexit, Russia 2022 sanctions, and
Basque Country / ETA terrorism. Use explicit predictors and donor pools from
the approved data plan. Save fit objects, donor weights, treated versus
synthetic trajectories, and a classic fit summary under
analysis/scm-from-scratch/output/.

Gate each case on pre-treatment RMSPE relative to outcome variability. If the
fit gate fails, stop and recommend concrete revisions instead of continuing.
Use the quickstart-compatible fit gate by default: pre-RMSPE divided by outcome
standard deviation should be at most 0.25 unless a stricter threshold was
explicitly approved. Save asset_kind scm_scratch_fit_note before answering.
```

Expected outputs include:

- `analysis/scm-from-scratch/output/fits/`
- `analysis/scm-from-scratch/output/tables/classic-fit-summary.csv`
- `analysis/scm-from-scratch/output/notes/pretreatment-fit.md`

## 4. Author method-comparison code

Paste:

```text
/scm-scratch-methods Use the from-scratch study brief, data plan, and fit note.

Plan and then, after approval, author only:
analysis/scm-from-scratch/code/04_compare_methods.R

Keep classic Abadie SCM as the primary estimator. Compare it with feasible
modern variants such as generalized synthetic control, synthetic DiD when
available, and an augmented or doubly robust synthetic-control approximation.
Record unavailable optional methods without failing the whole tutorial.

Save method comparison tables and figures under
analysis/scm-from-scratch/output/, apply a sign-consistency and fragility gate,
and save asset_kind scm_scratch_method_choice_note before answering.
```

If available methods disagree on sign or interpretation, the tutorial should
carry forward a fragile-result narrative rather than a strong headline claim.

## 5. Author placebo and sensitivity checks

Paste:

```text
/scm-scratch-inference Use the latest from-scratch study brief, data plan,
classic fit note, and method choice note.

Plan and then, after approval, author only:
analysis/scm-from-scratch/code/05_placebos_and_sensitivity.R

Implement in-space donor placebos, in-time placebo treatment years, and
leave-one-out donor sensitivity where feasible. Label any fast tutorial
approximation clearly. Save placebo and sensitivity tables, figures, and notes
under analysis/scm-from-scratch/output/. Save asset_kind
scm_scratch_inference_note before answering.
```

The inference note should not report only a single ATT. It should describe the
placebo distribution, closest placebo donors, timing falsification, donor
sensitivity, and limits of the tutorial-scale checks.

## 6. Author and surface the final report

Paste:

```text
/scm-scratch-report Use all latest from-scratch SCM assets and generated
outputs.

Plan and then, after approval, author only:
analysis/scm-from-scratch/code/06_render_report.R

Render a final HTML report at:
analysis/scm-from-scratch/output/scm-from-scratch-report.html

The report should include treated versus synthetic trajectory plots, donor
weights, placebo distribution, method comparison, in-time falsification or
sensitivity summaries, a paper-ready methods paragraph, and interpretation with
caveats. Also write a run log at
analysis/scm-from-scratch/output/run-log.md.

Surface final study artifact paths in the response. Do not ask the user to
open files outside ScienceSwarm. Save asset_kind scm_scratch_results_report
before answering.
```

The report is complete only when the study shows:

- generated R files for all approved stages,
- prepared panels and data-audit table,
- fit, method-comparison, placebo, and sensitivity outputs,
- final HTML report and run log,
- final interpretation that distinguishes tutorial parity from a new
  political-science finding.

## What counts as parity with the current SCM demo

The numbers may differ slightly because this path authors code interactively
and may pull newer source data. Parity means the final artifacts have the same
research shape:

- the same three case studies,
- the same primary SCM estimator,
- comparable diagnostics for pre-treatment fit,
- donor-weight and trajectory outputs,
- placebo and sensitivity summaries,
- method robustness checks,
- a single study-visible report with interpretation and limitations.

If the newly generated analysis cannot support one of the quickstart-style
claims, the correct final output is a high-quality failed or caveated SCM report
with visible diagnostics, not a forced success.
