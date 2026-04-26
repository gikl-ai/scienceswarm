# ScienceSwarm SCM pipeline walkthrough

This walkthrough shows how to drive ScienceSwarm's synthetic-control method
(SCM) skills from the UI with Claude Code. You should not need to open a
terminal or type shell commands. The example is the
[SCM-IR quickstart](scm-ir-quickstart/README.md): Brexit, Russia 2022
sanctions, and Basque Country / ETA terrorism.

The expected final state is:

- project-scoped SCM decision assets saved in gbrain,
- a completed deterministic R pipeline run,
- an interactive `output/scm-ir-report.html` with its sibling `output/lib/`
  assets,
- a saved SCM Run Log, and
- a final report asset whose claims trace back to the earlier study, data,
  fit, methods, and inference notes.

The example is a tutorial scaffold, not a new political-science result.

---

## 0. Create the project and choose Claude Code

1. Start ScienceSwarm and complete setup if the app asks.
2. Open the dashboard and create a project. A name like `SCM IR quickstart`
   is fine.
3. Open the project. You should see the project chat composer at the bottom of
   the page.
4. Import this checkout, or the `docs/tutorials/scm-ir-quickstart/` folder,
   into the project. The important imported files are `setup.R` and the
   `scripts/` folder.
5. If the import says `README.md`, `setup.R`, or the R scripts were saved
   without typed conversion, continue. They are still available to Claude Code
   as project files.
6. In the project chat composer, open the assistant selector and choose
   `Claude Code`.
7. If ScienceSwarm shows a send-review sheet for Claude Code, confirm the
   destination is `Claude Code`, the project is the SCM project, and the
   included data is the prompt plus project context. Then click the send
   button in that sheet.

Use Claude Code for every step below.

---

## How to run each skill

For each step:

1. Stay on the project page.
2. Confirm the assistant selector says `Claude Code`.
3. Click the message box.
4. Paste the text block for the step.
5. Click `Send`.
6. Wait until the `Stop` button disappears and the assistant reports a saved
   gbrain slug before starting the next step.

The SCM slash commands used here are:

| Step | Command | Skill | Asset |
|---|---|---|---|
| 1 | `/scm-question` | `scienceswarm-scm-question-design` | `scm_study_brief` |
| 2 | `/scm-data` | `scienceswarm-scm-data-acquisition` | `scm_data_manifest` |
| 3 | `/scm-fit` | `scienceswarm-scm-pretreatment-fit` | `scm_pretreatment_fit_note` |
| 4 | `/scm-methods` | `scienceswarm-scm-method-comparison` | `scm_method_comparison_note` |
| 5 | `/scm-inference` | `scienceswarm-scm-inference-and-placebos` | `scm_inference_note` |
| 6 | `/scm-report` | `scienceswarm-scm-results-rendering` | `scm_results_report` |

---

## 1. Design the SCM question

Paste this into the project chat:

```text
/scm-question Create an SCM Study Brief for the SCM-IR quickstart.

Scientific goal: demonstrate a ScienceSwarm UI-driven synthetic control
workflow on three canonical international-relations shocks.

Cases:
- Brexit referendum, treated unit United Kingdom, treatment year 2016.
- Russia 2022 sanctions, treated unit Russian Federation, treatment year 2022.
- Basque Country / ETA terrorism, treated unit Basque Country, treatment year
  1975.

Primary outcome: GDP per capita in real terms.

Desired claim: this is a validated tutorial scaffold showing how SCM decisions,
fits, placebos, and report artifacts are made traceable. It is not a new
political-science finding.

Map each case to treated unit, treatment date, donor pool inclusion/exclusion
criteria, primary outcome, secondary predictors, pre/post windows, suitability
verdict, stop criteria, and confidence boundary. Save a durable project-scoped
SCM Study Brief with gbrain_capture before answering.
```

Continue only after the assistant says it saved an `SCM Study Brief`. Check for
`scm-fit` or `scm-with-caveats`, explicit donor-pool exclusions, and a
confidence boundary.

---

## 2. Acquire and validate the data

Paste:

```text
/scm-data Build the SCM Data Manifest for the SCM-IR quickstart.

Use the latest project-scoped SCM Study Brief from this project and the
imported tutorial files. If the full ScienceSwarm checkout is imported, use
docs/tutorials/scm-ir-quickstart/. If only the tutorial folder is imported, use
the current project folder.

Use setup.R as the dependency contract, then run scripts/01_fetch_data.R and
scripts/02_prepare_panels.R from the tutorial root. Do not install R packages
into the app checkout or imported project folder. Use the ScienceSwarm-managed
R library under $SCIENCESWARM_DIR/runtimes/r/R-<major.minor>/<platform>/library/.

Record every source, indicator code, data vintage if available, license or
source note, donor exclusion, cache path, and balance check. Stop if any case
has fewer than 10 pre-treatment years or fewer than 15 donor candidates. Save a
durable project-scoped SCM Data Manifest with gbrain_capture before answering.
```

Expected sources:

- World Bank Development Indicators via the World Bank API for Brexit and Russia.
- `Synth::basque` for Basque Country / ETA terrorism.

Expected generated files:

- `data/raw/wdi_panel.rds`
- `data/raw/basque_bundled.rds`
- `data/prepared/brexit.rds`
- `data/prepared/russia.rds`
- `data/prepared/basque.rds`

---

## 3. Fit classic SCM and gate pre-treatment fit

Paste:

```text
/scm-fit Fit classic Abadie synthetic control for the SCM-IR quickstart.

Use the project SCM Study Brief and Data Manifest. Run
scripts/03_fit_classic_scm.R from the tutorial root. Stop if the script reports
a failed pre-period RMSPE / outcome-SD gate.

For each case, report treated unit, treatment year, donor-weight concentration,
pre-RMSPE, pre-RMSPE / outcome SD, post/pre RMSPE ratio, average post-treatment
gap, and placebo p-value. Explain whether each classic fit is interpretable as
a counterfactual under the tutorial gate. Save a durable project-scoped SCM
Pretreatment Fit Note with gbrain_capture before answering.
```

Continue only if all three cases pass `pre_rmspe_over_sd <= 0.25`. A failed
fit means the right next step is to revise donor pools or predictors, not to
render a report.

---

## 4. Compare methods

Paste:

```text
/scm-methods Compare classic SCM against modern SCM variants for the SCM-IR
quickstart.

Use the project SCM Study Brief, Data Manifest, and Pretreatment Fit Note. Run
scripts/04_fit_alternative_methods.R from the tutorial root. Treat synthdid as
optional if it is unavailable in the managed R library; do not block the whole
tutorial solely because synthdid is skipped.

For each case, report the available estimates from classic SCM, gsynth,
synthetic DiD if available, and the doubly-robust SC approximation. Apply the
sign-consistency gate from the script and explain whether the result is robust
enough to carry forward. Save a durable project-scoped SCM Method Comparison
Note with gbrain_capture before answering.
```

Continue only if each case clears the sign-consistency gate for the available
methods.

---

## 5. Interpret placebo inference and sensitivity

Paste:

```text
/scm-inference Create the SCM Inference Note for the SCM-IR quickstart.

Use the project SCM Study Brief, Data Manifest, Pretreatment Fit Note, Method
Comparison Note, and the generated classic fit files under output/fits/. Run
scripts/05_summarize_inference.R from the tutorial root and use
output/inference_summary.md as the primary source for the note; do not paste
raw console tables into the chat.

Report the in-space placebo p-value for each case, the post/pre RMSPE ratio,
which donor placebos are closest to the treated unit, and what the in-time
falsification and leave-one-out sensitivity checks support or do not support.
If the existing script output approximates an inference family rather than
fully refitting it, label that clearly in the confidence boundary. Save a
durable project-scoped SCM Inference Note with gbrain_capture before answering.
```

Check that the note does not report only a single ATT point estimate. It should
describe the placebo distribution and the limits of the tutorial-scale checks.

---

## 6. Render the report

Paste:

```text
/scm-report Render the final SCM-IR interactive report.

Use the project SCM Study Brief, Data Manifest, Pretreatment Fit Note, Method
Comparison Note, Inference Note, and generated fit files. Run
scripts/06_render_html.R from the tutorial root. Keep the HTML and sibling
lib/ folder together.

Report the final output path, total HTML plus lib/ asset size, the three case
headlines, and whether the report validation markers passed. Do not tell the
user to run `open` or another shell command; reference the ScienceSwarm project
artifact path and keep the HTML plus lib/ folder together. Save a durable
project-scoped SCM Results Report with gbrain_capture before answering.
```

The report is valid only if:

- `output/scm-ir-report.html` exists,
- `output/lib/` exists next to it,
- HTML plus `lib/` assets total at least 1 MB, and
- the report contains the required markers for trajectory, donor weights,
  placebo distribution, method comparison, in-time falsification, Methods
  paragraph, and methodology explainer.

---

## 7. Save the run log

If the previous steps did not already create a run log, paste:

```text
Create a project-scoped SCM Run Log for the completed SCM-IR quickstart.

Summarize the R version, managed R library path, scripts run, generated files,
validation gates, optional methods skipped or included, and final report path.
Link or reference the SCM Study Brief, Data Manifest, Pretreatment Fit Note,
Method Comparison Note, Inference Note, and Results Report. Save the run log
with gbrain_capture before answering.
```

This step is plain text rather than a slash command because it records the
execution provenance for the whole run, not a new scientific decision.

---

## Done checklist

You are done when gbrain contains:

- SCM Study Brief
- SCM Data Manifest
- SCM Pretreatment Fit Note
- SCM Method Comparison Note
- SCM Inference Note
- SCM Results Report
- SCM Run Log

And the project workspace contains:

- `data/raw/wdi_panel.rds`
- `data/raw/basque_bundled.rds`
- `data/prepared/brexit.rds`
- `data/prepared/russia.rds`
- `data/prepared/basque.rds`
- `output/fits/classic_brexit.rds`
- `output/fits/classic_russia.rds`
- `output/fits/classic_basque.rds`
- `output/fits/alternatives_brexit.rds`
- `output/fits/alternatives_russia.rds`
- `output/fits/alternatives_basque.rds`
- `output/scm-ir-report.html`
- `output/lib/`

The final answer you want from ScienceSwarm is a traceable chain from the
substantive question, to data choices, to model fit, to robustness checks, to
placebo inference, to a report whose claims are bounded by those assets.

---

## Method and platform boundaries

Use SCM when there is one clean treated unit, a sharp treatment date, a
structurally comparable donor pool, and a meaningful pre-treatment outcome
history. Do not use this pipeline for staggered adoption, many treated units
with different treatment dates, or heterogeneous-treatment-effect questions.

ScienceSwarm should keep:

- scientific runtime dependencies under `$SCIENCESWARM_DIR/runtimes/`,
- generated tutorial outputs inside the imported project tutorial folder, and
- durable interpretation, provenance, and decision notes in gbrain via
  `gbrain_capture`.

The platform should not require users to recover by typing terminal commands.
If setup, dependency installation, data fetch, or report rendering fails, the
assistant should show the exact failure and either fix it inside the project
runtime or ask one concrete permission question.

---

## Further reading

- [`docs/tutorials/scm-ir-quickstart/README.md`](scm-ir-quickstart/README.md)
  - the deterministic SCM-IR quickstart.
- `skills/scienceswarm-scm-*/hosts/claude-code/SKILL.md` - the Claude Code
  instructions embedded by the slash commands.
- Abadie & Gardeazabal (2003, *AER*) - Basque Country / ETA terrorism.
- Abadie, Diamond & Hainmueller (2010, *JASA*) and Abadie (2021, *JEL*) -
  synthetic control foundations and diagnostics.
