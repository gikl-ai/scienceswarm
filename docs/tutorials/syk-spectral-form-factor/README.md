# SYK spectral form factor — dip, ramp, plateau on a laptop

An end-to-end exact-diagonalization tutorial that reproduces one of the
cleanest signatures of quantum chaos in many-body physics: the
**dip–ramp–plateau** of the spectral form factor in the
Sachdev–Ye–Kitaev (SYK) model. Wall time is roughly **3–5 min on a
laptop CPU** at the default `N = 22`, no GPU required.

The result is delivered as a single self-contained interactive HTML
report — modern dark theme, animated 1D Coulomb-gas hero (which is
literally the equilibrium distribution of GUE eigenvalues), Plotly-backed
interactive plots for the spectral density, gap-ratio distribution, and
the spectral form factor itself, with the slope-1 random-matrix-theory
ramp overlaid for comparison.

This tutorial exists to:

- give a copy-paste-runnable proof that the central plot of SYK / quantum
  chaos / random-matrix-theory holography (Cotler et al. 2017) emerges on
  commodity hardware in minutes;
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

| Stage | Script | Wall time (CPU) | Output |
|---|---|---|---|
| 1. Diagonalize SYK ensemble (default N=22, 80 disorder samples) | `01_diagonalize.py` | ~3–5 min | `spectra.npz` |
| 2. Spectral form factor + level statistics | `02_spectral_form_factor.py` | ~10 s | `sff_data.json`, `metrics.json` |
| 3. Render interactive HTML report | `03_render_report.py` | <1 s | `report.html` |

A faster preview (`--N 20 --samples 60`) finishes in well under a
minute. A larger run (`--N 24 --samples 40`) takes ~10–15 min and
gives a noticeably sharper ramp.

---

## Requirements

- macOS, Linux, or Windows (WSL2)
- Conda or mamba (`miniforge3` recommended)
- ~50 MB free disk
- Modern browser (Chrome / Firefox / Safari) for the report
- No internet required at run time; the report fetches Plotly, KaTeX,
  Tailwind, and Alpine.js from CDNs the first time you open it

No API keys, no cluster, no GPU required.

---

## Setup

Create the conda environment from this directory:

```bash
mamba env create -f environment.yml
# or: conda env create -f environment.yml
mamba activate scienceswarm-syk-sff
```

Verify the install:

```bash
python -c "import numpy, scipy; print(numpy.__version__, scipy.__version__)"
# expected: 1.26+ / 2.x and 1.11+ / 1.13+
```

---

## Run the pipeline

From `docs/tutorials/syk-spectral-form-factor/scripts/`:

```bash
# 1. diagonalize the SYK_4 disorder ensemble
python 01_diagonalize.py            # default: N=22, samples=80, seed=2026

# 2. compute the spectral form factor and level statistics; write
#    sff_data.json and metrics.json (exits non-zero if any gate fails)
python 02_spectral_form_factor.py   # default: beta*J = 5

# 3. build the interactive HTML report
python 03_render_report.py
```

Each script prints clear diagnostics, fails fast on a bad input or
unconverged ensemble, and writes its outputs before exiting.

Open the report:

```bash
open report.html              # macOS
xdg-open report.html          # Linux
# or just double-click it; the report works with file:// URLs.
```

If you prefer a local server (and you should, if the CDN-loaded
Plotly/KaTeX behave oddly under file://):

```bash
python -m http.server 8000
# then visit http://localhost:8000/report.html
```

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
| Late-time plateau | `Z(2β) / Z(β)²` | within 50% |

If any gate fails, `02_spectral_form_factor.py` exits non-zero and the
report is not regenerated. Failures usually mean either the parity
projection misfired (a code bug worth filing), the ensemble was too
small to clear shot noise, or `t_max` was too small to reach the
plateau (extend it via `--t-max`).

---

## Knobs

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
