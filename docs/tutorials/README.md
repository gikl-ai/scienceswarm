# Tutorials

| Tutorial | What it covers | Time |
|---|---|---|
| [MD quickstart — lysozyme in explicit water](md-quickstart/README.md) | End-to-end OpenMM pipeline: prepare, solvate, equilibrate, 1 ns × 3 seeds production, validation gates against the published Cα-RMSD reference band. | ~30 min on GPU, ~3.5 h on CPU |
| [ScienceSwarm MD pipeline walkthrough](md-pipeline-walkthrough.md) | The eight MD planning skills (`scienceswarm-md-*`) walked end-to-end on the lysozyme example, with the asset shapes each skill produces. | reading-time |

Tutorials are deliberately conservative: they use textbook test
systems (lysozyme), bundled force fields (AMBER ff14SB / TIP3P), and
validation gates against published reference values. The goal is for
a researcher to be able to copy-paste the steps, get a numerically
recognizable result, and then know which assumptions to renegotiate
when they swap in their own system.
