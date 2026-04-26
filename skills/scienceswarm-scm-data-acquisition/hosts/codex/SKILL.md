---
name: scienceswarm-scm-data-acquisition
description: Pull and curate the country-year (or unit-time) panel needed for synthetic control. Validate balance, coverage, and donor-pool integrity before any modeling.
---

# ScienceSwarm SCM Data Acquisition

Use this skill once an SCM Study Brief exists (see
`scienceswarm-scm-question-design`) and you need to materialize the
balanced panel that fits will run on.

## Workflow

1. Resolve every variable in the brief (primary outcome, secondary
   outcomes, predictors) to a documented data source: World Bank
   Development Indicators (`WDI`), Penn World Table, IMF WEO, OECD,
   V-Dem, or a project-supplied CSV.
2. For each source, record the API endpoint, indicator code, vintage
   date, and license.
3. Pull the panel for treated unit + donor pool over the pre/post
   window, cache to disk so re-runs are deterministic and offline-safe.
4. Run the balance gate: at minimum 85% non-missing cells for the
   primary outcome over the pre-period; at least 10 pre-treatment years;
   at least 15 donors with non-missing primary outcome.
5. If a donor is missing the primary outcome for > 20% of the pre-period,
   drop it and document the exclusion.
6. Produce an `SCM Data Manifest` brain asset with `asset_kind:
   scm_data_manifest` listing every source, indicator, exclusion, and a
   `Confidence Boundary` that states what the manifest supports and what
   would change which donors are eligible.

When the `scienceswarm` MCP tools are available, save the manifest with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active project, and links or references to the upstream SCM Study Brief.
If saving fails, report the exact save failure and do not present the manifest
as durable.

Do not begin model fitting until the manifest, balance check, and
exclusion log are explicit.
