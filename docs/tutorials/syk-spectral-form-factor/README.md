# SYK spectral form factor — dip, ramp, plateau from the ScienceSwarm UI

An end-to-end exact-diagonalization tutorial that reproduces one of the
cleanest signatures of quantum chaos in many-body physics: the
**dip–ramp–plateau** of the spectral form factor in the
Sachdev–Ye–Kitaev (SYK) model. Wall time is roughly **3–5 min on a
laptop CPU** at the default `N = 22`, no GPU required.

You should not need to open a terminal or type Linux commands. Create a
ScienceSwarm Study, import this tutorial folder, choose `Claude Code` in the
study chat, and follow the
[ScienceSwarm SYK walkthrough](../syk-spectral-form-factor-walkthrough.md).
Claude Code checks the Python runtime, runs the scripts inside the Study
workspace, saves run logs to gbrain, and keeps generated artifacts in the
Study file tree.

The final result is an interactive HTML report with CDN-loaded Plotly assets for
spectral-density, gap-ratio, and spectral-form-factor plots plus a
Dyson-Coulomb-gas hero animation.

This tutorial exists to:

- give a UI-driven proof that the central plot of SYK / quantum chaos /
  random-matrix-theory holography (Cotler et al. 2017) emerges on commodity
  hardware in minutes;
- expose the validation gates that distinguish a correct exact-diagonalization
  run from one that "completed" but produced a Poisson-like or otherwise
  broken spectrum;
- show how a research-grade numerical result can be presented as a
  modern interactive web report instead of a static figure.

It is **not** a research result. The model is exactly soluble at large
N in the strict CFT sense, and the dip–ramp–plateau is a textbook
signature; choosing it lets the tutorial focus on technique and on the
visual presentation of the result.

---

## What you will do

| Stage | What Claude Code does from ScienceSwarm | Output |
|---|---|---|
| 1. Study brief | Reads `README.md` and `scripts/`, records the model, run modes, validation gates, and confidence boundary | Study-scoped gbrain Study Brief |
| 2. Runtime check | Reuses a working Python with NumPy/SciPy or proposes a managed environment under `$SCIENCESWARM_DIR/runtimes/` | runtime decision in the run log |
| 3. Diagonalize SYK ensemble | Runs `01_diagonalize.py` in the Study `scripts/` folder | `scripts/spectra.npz` |
| 4. Compute SFF + gates | Runs `02_spectral_form_factor.py` and stops if a gate fails | `scripts/sff_data.json`, `scripts/metrics.json` |
| 5. Render report | Runs `03_render_report.py` only after gates pass | `scripts/report.html` |
| 6. Interpret/refine | Reads the metrics and report, separates tutorial support from research claims | Study-scoped gbrain notes |

A faster preview (`--N 20 --samples 60`) finishes in well under a
minute and uses the GSE random-matrix class. The stage-2 script collapses the
two-fold Kramers pairs for the GSE gap-ratio check and uses a degeneracy-aware
late-time plateau reference. A larger run (`--N 24 --samples 40`) takes about
10-15 min and gives a sharper ramp.

No API keys, cluster, or GPU are required.

---

## Start here

Use the full UI walkthrough:

- [ScienceSwarm SYK pipeline walkthrough](../syk-spectral-form-factor-walkthrough.md)

The walkthrough assumes you are new to ScienceSwarm. It shows how to create a
Study, import this folder, choose Claude Code, approve the Claude Code send
review sheet, run the fast preview, open the output artifacts from the Study
file tree, and save interpretation/refinement notes to gbrain.

If ScienceSwarm needs persistent scientific tooling, the assistant should keep
package managers and named environments under `$SCIENCESWARM_DIR/runtimes/`;
Study outputs stay in the imported Study workspace, usually `scripts/`.

---

## What the report shows

1. **Hero** — animated 1D Dyson Coulomb gas of N=28 particles. The
   equilibrium distribution of this gas at inverse temperature β=2 *is*
   the eigenvalue distribution of a GUE random matrix; that is the
   level repulsion you can see flickering in real time.

2. **Hamiltonian** — the SYK<sub>4</sub> Hamiltonian and the variance of
   the random couplings, rendered with KaTeX.

3. **Spectral density ρ(E)** — disorder-averaged density of states. At
   large N this approaches the conformal-field-theory prediction; at
   N=22 you can already see the soft edges and the asymmetric body.

4. **Gap-ratio distribution P(r)** — observed histogram of
   `r_n = min(s_n, s_{n+1}) / max(s_n, s_{n+1})` overlaid with the
   four reference values from Atas–Bogomolny–Roux–Roy (PRL 2013):
   Poisson 0.3863, GOE 0.5359, GUE 0.5995, GSE 0.6762. For N=22 the
   even-parity sector is GUE, and `<r>` typically lands within 0.01 of
   the surmise.

5. **The spectral form factor** — log-log plot of
   `g(t) = <|Z(β + i t)|²> / <|Z(β)|²>` and the connected piece `g_c`,
   with a slope-1 ramp reference line overlaid on top of the data and
   the asymptotic plateau drawn at `Z(2β) / Z(β)²`. Toggle between the
   total `g`, the connected `g_c`, or both. This is the centerpiece.

6. **Validation gates** — observed-vs-reference table for `<r>`, the
   ramp dynamic range, and the late-time plateau. These are the same
   gates `02_spectral_form_factor.py` exits non-zero on.

---

## Validation gates

A successful run satisfies all three:

| Gate | Reference | Tolerance |
|---|---|---|
| Mean gap ratio `<r>` | Atas surmise for the ensemble class implied by N mod 8 (GOE / GUE / GSE) | within 0.020 |
| Dip-to-plateau ratio | plateau ÷ dip > 3 | hard floor |
| Late-time plateau | finite-sample time average; for GSE this is degeneracy-aware for Kramers pairs | within 50% |

If any gate fails, `02_spectral_form_factor.py` exits non-zero and the
report is not regenerated. Failures usually mean either the parity
projection misfired (a code bug worth filing), Kramers pairs were not handled
for a GSE preview, the ensemble was too small to clear shot noise, or the time
grid was too short to reach the plateau.

---

## Knobs

These are parameters for the assistant to use in the ScienceSwarm Study
workspace; you do not need to type them into a terminal.

`01_diagonalize.py`:
- `--N` (default 22) — number of Majoranas. Even sector dimension is
  `2^(N/2-1)`. For other useful values: `N=20` → GSE (mod 8 = 4),
  `N=22` → GUE (mod 8 = 6), `N=24` → GOE (mod 8 = 0). The report
  auto-selects the right reference value.
- `--samples` (default 80) — disorder realizations.
- `--seed` (default 2026) — RNG seed for reproducibility.

`02_spectral_form_factor.py`:
- `--beta` (default 5.0) — inverse temperature in units of `1/J`. The
  Cotler et al. 2017 reference uses `βJ = 5`; smaller `β` makes the
  early-time decay shallower.
- `--t-min`, `--t-max`, `--n-times` — time grid for the SFF.

---

## Artifact conventions

ScienceSwarm should keep tutorial state in three places:

- Study workspace files: imported tutorial files and generated outputs such
  as `scripts/spectra.npz`, `scripts/sff_data.json`, `scripts/metrics.json`,
  and `scripts/report.html`.
- gbrain: durable Study Briefs, execution run logs, interpretation notes, and
  refinement decisions saved with `gbrain_capture`.
- Managed runtimes: persistent package managers and named environments under
  `$SCIENCESWARM_DIR/runtimes/`, for example
  `$SCIENCESWARM_DIR/runtimes/conda/envs/scienceswarm-syk-sff`, only when the
  existing Python environment is insufficient.

The ScienceSwarm app checkout and the original tutorial checkout should remain
source material, not the place where generated scientific outputs accumulate.

---

## Why this is the right size demo

The SYK<sub>4</sub> Hamiltonian on `N` Majorana fermions has at most
`C(N, 4) ≈ N⁴ / 24` independent couplings; the Hilbert space is
`2^(N/2)` and parity-decomposable into two halves. At `N = 22` the
even-parity block is `1024 × 1024`, which means a single sample is one
small dense Hermitian eigendecomposition (~0.3 s) and the disorder
ensemble runs in low minutes. Yet `1024` is *easily* enough to show
four orders of magnitude of ramp on a log-log SFF plot, and to localize
`<r>` to the GUE surmise within 0.01.

In other words, this is the smallest model where the headline result
of "many-body chaos = random matrices" is visually unambiguous, and
the smallest computer where the calculation is a few minutes rather
than a few hours.

---

## References

- Sachdev, Ye. *PRL* **70**, 3339 (1993).
- Kitaev. KITP talks (2015).
- Maldacena, Stanford. *PRD* **94**, 106002 (2016) — the q=4 SYK
  Hamiltonian, normalization conventions, and large-N solution.
- Cotler, Gur-Ari, Hanada, Polchinski, Saad, Shenker, Stanford,
  Streicher, Tezuka. *JHEP* **05**, 118 (2017) — the dip-ramp-plateau
  in SYK as black-hole-like spectral statistics.
- Saad, Shenker, Stanford. arXiv:1806.06840 (2018) — wormhole
  interpretation of the ramp.
- You, Ludwig, Xu. *PRB* **95**, 115150 (2017) — the
  Bott-periodicity / `N mod 8` symmetry classification of SYK.
- Atas, Bogomolny, Roux, Roy. *PRL* **110**, 084101 (2013) — the
  surmise values for `<r>` quoted in this tutorial.
