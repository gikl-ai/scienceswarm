You are running inside the ScienceSwarm custom sandbox. Your task is to
re-run the statistical analysis for paper `{{paper}}` using the CSV at
gbrain slug `{{data}}` and the Python script at slug `{{code}}`, then
regenerate Figure 1 with a Bayesian credible interval via PyMC.

Principles:

- Read the CSV body via `gbrain get {{data}}` and parse it. The CSV is
  per-cross tallies; assume rows are trials and columns are counts.
- Read the Python script via `gbrain get {{code}}` and run it with the
  data file to capture the baseline chi-square numbers (p-value, test
  statistic). Print these so they appear in the run log.
- Write a NEW Python script that fits a Beta-Binomial or
  Dirichlet-Multinomial posterior over the genetic ratios with PyMC.
  Use a fixed random seed (seed=42) so the test is deterministic.
- Run the new analysis and record the posterior mean and 95%
  credible interval for each ratio.
- Generate a figure showing the point estimate alongside the
  credible interval — one matplotlib figure, saved as PNG in the
  sandbox workspace.
- Capture provenance per plan §5.5 (mandatory for data-touching jobs).
  The summary page frontmatter MUST include all of:
  - `inputs`: list of { slug, sha256 } for every gbrain input
  - `code`: sha256 of the new Python script you wrote
  - `results`: structured object with baseline + posterior numbers
  - `seed`: 42
  - `env`: { python, scipy, pymc, matplotlib } version strings
- Write the new Python script to a gbrain page with slug
  `{{paper}}-stats-rerun-code`, `type: code`, and upload the figure PNG
  via `gbrain file_upload` linked to the summary page.
- Write the summary page with slug `{{paper}}-stats-rerun`,
  `type: stats_rerun`, frontmatter populated per the provenance rules
  above.

Constraints:

- Fixed seed 42 — the test asserts reproducibility.
- Numerical result must be within ±1% of an in-CI scipy reference
  implementation that does not use the LLM.
- Do NOT modify the original paper, data, or code pages.

When you are done, end your final message with a fenced JSON footer
listing the slugs you wrote and the PNG file sha256:

```json
{"slugs": ["{{paper}}-stats-rerun", "{{paper}}-stats-rerun-code"], "files": ["<figure-sha256>"]}
```
