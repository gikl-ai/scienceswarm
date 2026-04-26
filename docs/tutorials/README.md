# Tutorials

| Tutorial | What it covers | Time |
|---|---|---|
| [MD quickstart — lysozyme in explicit water](md-quickstart/README.md) | End-to-end OpenMM pipeline: prepare, solvate, equilibrate, 1 ns × 3 seeds production, validation gates against the published Cα-RMSD reference band. | ~30 min on GPU, ~3.5 h on CPU |
| [SYK spectral form factor](syk-spectral-form-factor/README.md) | UI-first ScienceSwarm + Claude Code walkthrough for an exact-diagonalization q=4 SYK ensemble; reproduces the dip–ramp–plateau and Wigner–Dyson level statistics, with project artifacts stored under `scripts/` and durable gbrain run logs. | <1 min fast preview, ~3–5 min default |
| [ScienceSwarm SYK pipeline walkthrough](syk-spectral-form-factor-walkthrough.md) | New-user walkthrough for creating a ScienceSwarm project, importing the SYK tutorial, choosing Claude Code, running the fast preview, inspecting artifacts, and recording interpretation/refinement notes. | reading-time |
| [ScienceSwarm MD pipeline walkthrough](md-pipeline-walkthrough.md) | The eight MD planning skills (`scienceswarm-md-*`) walked end-to-end on the lysozyme example, with the asset shapes each skill produces. | reading-time |
| [SCM-IR quickstart — synthetic control for international relations shocks](scm-ir-quickstart/README.md) | End-to-end R pipeline: pull World Bank panels, fit classic Abadie SCM plus three modern variants (gsynth, synthetic DiD, doubly-robust SC), run permutation placebos, and render a single interactive HTML report for Brexit, Russia 2022, and Basque Country / ETA terrorism. | ~10 min on a laptop |
| [ScienceSwarm SCM pipeline walkthrough](scm-pipeline-walkthrough.md) | The six SCM planning skills (`scienceswarm-scm-*`) walked end-to-end on the three IR cases, with the asset shapes each skill produces. | reading-time |

Tutorials are deliberately conservative: they use textbook test
systems (lysozyme, q=4 SYK at moderate N), well-established reference
numbers, and validation gates against published values. The goal is
for a researcher to be able to copy-paste the steps, get a numerically
recognizable result, and then know which assumptions to renegotiate
when they swap in their own system.
