# ScienceSwarm SCM pipeline walkthrough

This walkthrough shows how to drive ScienceSwarm's six synthetic-control
planning skills end-to-end on three canonical international-relations
shocks. The skills produce durable brain assets that capture the
scientific judgment behind each decision; this walkthrough pairs each
skill with the artifact it should produce, using the
[SCM-IR quickstart](scm-ir-quickstart/README.md) (Brexit, Russia 2022,
Basque Country / ETA terrorism) as the concrete example.

The skills in execution order:

| # | Skill | Asset kind | Purpose |
|---|---|---|---|
| 1 | `scienceswarm-scm-question-design` | `scm_study_brief` | Decide whether SCM is the right method, and for which scoped treated unit, donor pool, outcome, and pre/post window. |
| 2 | `scienceswarm-scm-data-acquisition` | `scm_data_manifest` | Pull and curate the balanced unit-time panel. Document every source. |
| 3 | `scienceswarm-scm-pretreatment-fit` | `scm_pretreatment_fit_note` | Fit classic Abadie SCM. Gate on pre-period RMSPE / outcome SD ≤ 0.25. |
| 4 | `scienceswarm-scm-method-comparison` | `scm_method_comparison_note` | Cross-check ATT against gsynth, synthetic DiD, doubly-robust SC. Reject sign-disagreement. |
| 5 | `scienceswarm-scm-inference-and-placebos` | `scm_inference_note` | In-space and in-time placebos plus leave-one-out donor sensitivity. |
| 6 | `scienceswarm-scm-results-rendering` | `scm_results_report` | Render the interactive HTML deliverable with all seven wow elements. |

Each skill is documented in `skills/scienceswarm-scm-*/hosts/<host>/SKILL.md`
and is invocable from OpenClaw, Claude Code, or Codex.

---

## Why a pipeline, not a single skill

Synthetic control is decision-dense. A single agent prompt that says
"run synthetic control on the UK after Brexit" gives you a fit, not an
answer — because the choices that determine whether the fit is
interpretable (donor pool inclusion criteria, predictor list, pre-period
fit quality, robustness across method variants, placebo distribution)
are not in the prompt and not in the trajectory plot.

The pipeline asks for those decisions explicitly, before any HTML is
rendered. Each skill produces a markdown asset with a `Confidence
Boundary` section: what the asset supports, what it does not support,
and what would change the recommendation. That section is the single
most useful part of every asset. It survives the run and tells future
readers what the report is actually evidence for.

---

## Walking the three IR cases

### 1 — `scienceswarm-scm-question-design`

Decide whether SCM is appropriate. For each case the verdict is
`scm-fit` because (a) there is one cleanly identified treated unit,
(b) the treatment date is sharp and unambiguous, (c) the donor pool of
structurally comparable economies is well-defined, and (d) the outcome
(GDP per capita) is observed continuously before and after.

Asset shape (excerpt for Brexit):

```markdown
## SCM Suitability Verdict

`scm-fit`

## Treatment Definition

| Treated unit | Treatment date | Outcome |
|---|---|---|
| United Kingdom | 2016 (referendum) | GDP per capita (constant 2015 USD) |

## Donor Pool

27 OECD economies excluding co-shocked refugee-crisis countries.
Pre-period 1995–2015, post-period 2016–2023.
```

For Russia 2022, the verdict is `scm-with-caveats` because the
post-period is short (2 years of WB data as of pull) and the donor pool
must explicitly exclude Ukraine and Belarus. The brief flags that the
ATT estimate is strictly short-run.

For Basque Country / ETA terrorism, the verdict is `scm-fit` and the
brief notes this is a textbook replication of Abadie & Gardeazabal
(2003, *AER*) — the *original* synthetic control paper, which estimated
that ETA-related political violence cost the Basque Country roughly 10%
of pre-conflict GDP per capita.

### 2 — `scienceswarm-scm-data-acquisition`

For Brexit and Russia, the panel comes from the World Bank API via the
`WDI` R package: `NY.GDP.PCAP.KD` (real GDP per capita), `NE.TRD.GNFS.ZS`
(trade openness), `NE.GDI.TOTL.ZS` (gross capital formation),
`PA.NUS.FCRF` (official exchange rate). For Basque Country / ETA terrorism the
data is bundled in the `Synth` R package as `data("basque")` (17 Spanish
regions over 1955–1997).

The data manifest records, per source, the indicator code, vintage
date, and license. The balance gate requires ≥ 85% non-missing cells on
the primary outcome; both Brexit and Russia panels easily clear this.

### 3 — `scienceswarm-scm-pretreatment-fit`

Predictors are pre-period averages of the secondary outcomes
(trade openness, investment share, FX rate where applicable) plus three
lagged outcome snapshots (start, midpoint, end of pre-period).

The fit gate: `pre_rmspe / outcome_sd ≤ 0.25`. In the quickstart this
gate passes for all three cases. A failure here means the synthetic
counterfactual is not tracking the pre-period closely enough — the
right response is to widen the donor pool or revisit predictors, not to
report the post-period gap.

### 4 — `scienceswarm-scm-method-comparison`

Each case is re-fit with `gsynth` (Xu 2017), synthetic DiD (Arkhangelsky
et al. 2021), and a doubly-robust SC approximation (Ben-Michael et al.
2021). The robustness gate requires at least 3 of 4 methods to agree on
the sign of the ATT. For Brexit and Russia the headline ATT is
negative across all four methods; for Basque Country / ETA terrorism, all four
methods agree on a sign and rough magnitude consistent with the Abadie
2015 published estimate.

### 5 — `scienceswarm-scm-inference-and-placebos`

Three placebo families:

- **In-space placebo:** the treated unit's post/pre RMSPE ratio is
  compared against the distribution of donor placebos. The exact
  p-value is the share of donors with a ratio ≥ the treated unit.
- **In-time placebo:** treatment is re-assigned to alternate years
  inside the pre-period; the actual treatment year's ratio should
  stand out.
- **Leave-one-out:** the heaviest-weighted donor is dropped and the
  ATT is re-estimated; the sign and rough magnitude should be stable.

### 6 — `scienceswarm-scm-results-rendering`

The deliverable is a single interactive HTML page (~1–2 MB with
embedded Plotly assets) containing, per case:

1. Animated counterfactual trajectory
2. Donor weight bar chart with hover/click
3. Placebo distribution of post/pre RMSPE ratios
4. What-if treatment-year falsification chart (in-time placebo)
5. Method-comparison forest plot
6. Method-comparison forest plot
7. Auto-generated paper-ready Methods paragraph

Plus a page-level Methodology Explainer modal aimed at non-experts
("How synthetic control works in 60 seconds") and a tab switcher
across the three cases.

---

## What the pipeline does not cover

- **Staggered adoption.** When many units receive treatment at
  different times, use Callaway–Sant'Anna or Sun–Abraham staggered DiD
  instead. A future ScienceSwarm pipeline will cover this.
- **Bayesian synthetic control.** Compatible with this scaffolding but
  not yet wired in.
- **Causal forests / heterogeneous treatment effects.** Different
  question, different tool.
