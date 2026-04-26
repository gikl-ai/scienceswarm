# Tutorials

| Tutorial | What it covers | Time |
|---|---|---|
| [MD quickstart — lysozyme in explicit water](md-quickstart/README.md) | End-to-end OpenMM pipeline: prepare, solvate, equilibrate, 1 ns × 3 seeds production, validation gates against the published Cα-RMSD reference band. | ~30 min on GPU, ~3.5 h on CPU |
| [SYK spectral form factor](syk-spectral-form-factor/README.md) | Exact-diagonalization disorder ensemble of the q=4 SYK model on N=22 Majoranas; reproduces the dip–ramp–plateau and Wigner–Dyson level statistics (Cotler et al. 2017), delivered as a single interactive HTML report with a Dyson-Coulomb-gas hero animation. | ~3–5 min on CPU |
| [ScienceSwarm MD pipeline walkthrough](md-pipeline-walkthrough.md) | The eight MD planning skills (`scienceswarm-md-*`) walked end-to-end on the lysozyme example, with the asset shapes each skill produces. | reading-time |
| [SCM-IR quickstart — synthetic control for international relations shocks](scm-ir-quickstart/README.md) | End-to-end R pipeline: pull World Bank panels, fit classic Abadie SCM plus three modern variants (gsynth, synthetic DiD, doubly-robust SC), run permutation placebos, and render a single interactive HTML report for Brexit, Russia 2022, and Basque Country / ETA terrorism. | ~10 min on a laptop |
| [ScienceSwarm SCM pipeline walkthrough](scm-pipeline-walkthrough.md) | The six SCM planning skills (`scienceswarm-scm-*`) walked end-to-end on the three IR cases, with the asset shapes each skill produces. | reading-time |

Tutorials are deliberately conservative: they use textbook test
systems (lysozyme, q=4 SYK at moderate N), well-established reference
numbers, and validation gates against published values. The goal is
for a researcher to be able to copy-paste the steps, get a numerically
recognizable result, and then know which assumptions to renegotiate
when they swap in their own system.
