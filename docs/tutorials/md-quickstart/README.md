# MD quickstart — lysozyme in explicit water with OpenMM

A 30-minute molecular dynamics quickstart that runs end-to-end on a
laptop CPU. You will solvate hen egg-white lysozyme (PDB 1AKI) in
explicit TIP3P water with 0.15 M NaCl, run a brief equilibrium MD with
AMBER ff14SB at 300 K, repeat the production stage with three random
seeds, and verify the trajectory's Cα-RMSD plateau lands inside the
published reference band.

This tutorial exists to:

- give a copy-paste-runnable proof that you can run real explicit-solvent
  MD on commodity hardware,
- expose the validation gates that distinguish a real run from a
  pipeline that "completed" but produced nothing meaningful, and
- serve as the concrete example that the
  [ScienceSwarm MD pipeline walkthrough](../md-pipeline-walkthrough.md)
  refers to.

It is **not** a research result. Lysozyme apo dynamics is a textbook
control system — choosing it lets the tutorial focus on technique
rather than novelty.

---

## What you will do

| Stage | Script | Wall time (CPU) | Output |
|---|---|---|---|
| 1. Prepare | `01_prepare.py` | < 30 s | `prepared.pdb` |
| 2. Solvate | `02_solvate.py` | < 30 s | `solvated.pdb`, `system.xml` |
| 3. Minimize + equilibrate (150 ps) | `03_minimize_equilibrate.py` | ~6 min | `equilibrated.{pdb,xml}` |
| 4. Production × 3 seeds (1 ns each) | `04_produce.py` × 3 | ~70 min × 3 | `prod_seed{11,22,33}.dcd` |
| 5. Analyze | `05_analyze.py` | < 30 s | `analysis/{rmsd_ca,rmsf_ca,rg}.png`, `metrics.json` |

GPU users with CUDA can drop production wall time to ~5 min per seed by
exporting `OPENMM_PLATFORM=CUDA` before stage 4.

---

## Requirements

- macOS, Linux, or Windows (WSL2)
- Conda or mamba (`miniforge3` recommended)
- ~1 GB free disk for outputs
- Internet access for one PDB download

No API keys, no cluster, no GPU required.

---

## Setup

Create the conda environment from this directory:

```bash
mamba env create -f environment.yml
# or: conda env create -f environment.yml
mamba activate scienceswarm-md-quickstart
```

Verify the install:

```bash
python -c "import openmm, mdtraj, pdbfixer; print(openmm.version.full_version, mdtraj.__version__)"
# expected: 8.x.x and 1.11.x or newer
```

---

## Run the pipeline

From `docs/tutorials/md-quickstart/scripts/`:

```bash
# 0. fetch the structure
curl -o 1AKI.pdb https://files.rcsb.org/download/1AKI.pdb

# 1. clean the PDB and add hydrogens
python 01_prepare.py

# 2. solvate
python 02_solvate.py

# 3. minimize + equilibrate
python 03_minimize_equilibrate.py

# 4. three production seeds (sequential — each ~70 min on CPU, ~5 min on GPU)
python 04_produce.py --seed 11 --ns 1.0
python 04_produce.py --seed 22 --ns 1.0
python 04_produce.py --seed 33 --ns 1.0

# 5. analyze
python 05_analyze.py
```

Each script prints clear diagnostics, fails fast on a bad input, and
writes its output before exiting.

---

## What "good" looks like

Every script ends with a validation assertion that must pass before the
next stage is meaningful.

| Script | Validation gate |
|---|---|
| `01_prepare.py` | `assert n_protein == 129` (lysozyme has 129 residues) |
| `02_solvate.py` | `assert abs(net_charge) < 0.01`, atom count between 15 k and 60 k |
| `03_minimize_equilibrate.py` | end-of-NPT density in **0.95–1.05 g/mL** |
| `05_analyze.py` | per-seed Cα-RMSD plateau in **0.6–2.0 Å**, plateau std across seeds < **0.4 Å** |

The 0.6–2.0 Å Cα-RMSD reference band reflects published AMBER ff14SB /
TIP3P solution-MD behaviour for lysozyme at 300 K (Maier et al. 2015,
PMC4821407; biobb_wf_amber tutorial benchmarks). Plateaus outside this
band typically indicate a preparation defect (missing residues, wrong
protonation, broken ion neutralization), not a science result. The
0.4 Å seed-spread threshold catches the case where every seed
individually lands in the band but they disagree dramatically — that
is unconverged sampling, not a result.

`05_analyze.py` also writes three plots:

- `analysis/rmsd_ca.png` — Cα-RMSD vs time for all three seeds, with the
  published plateau band shaded.
- `analysis/rmsf_ca.png` — Cα-RMSF, mean ± standard deviation across the
  three seeds.
- `analysis/rg.png` — Radius of gyration vs time, all three seeds.

If your three seeds disagree dramatically, the run is not converged and
extending production is the first thing to try.

---

## Reading the output

A typical converged `metrics.json` has this shape:

```json
{
  "across_seeds": {
    "rmsd_ca_plateau_mean_A": 1.10,
    "rmsd_ca_plateau_std_across_seeds_A": 0.18,
    "rmsf_ca_global_mean_A": 0.55,
    "rmsf_ca_global_max_A": 2.10
  },
  "validation": {
    "rmsd_reference_band_A": [0.6, 2.5],
    "all_seeds_in_band": true
  }
}
```

The plateau mean is the Cα-RMSD averaged over the second half of each
trajectory, then averaged across seeds. The std-across-seeds is your
honest noise floor on a 1-ns × 3-seed budget; if you want to claim a
biological effect, the difference you report has to clear that floor.

---

## Common failures and what they mean

| Symptom | Likely cause | What to try |
|---|---|---|
| `OpenMMException: Particle position is NaN` during minimization | bad initial geometry; missing heavy atoms | rerun `01_prepare.py` and check `findMissingAtoms()` output |
| net charge ≠ 0 in stage 2 | ion-strength or `neutralize` flag | confirm `addSolvent(neutralize=True)` and rerun |
| stage 3 density assertion fails | barostat couple time too long, box too small, or wrong water model | inspect `eq_npt_free.log` density column; rerun with a longer NPT-restrained block |
| Cα-RMSD < 0.6 Å | run too short to leave the basin | extend production or check for accidental restraints |
| Cα-RMSD > 2.0 Å within 100 ps | preparation defect (missing residues, wrong His tautomer) | revisit `01_prepare.py` and check the PDB for gaps |
| seeds disagree by > 0.4 Å on the plateau | undersampled | extend production or add seeds; do not interpret single-seed differences as biology |

---

## What this tutorial does not cover

- **Small-molecule ligands.** Adding a ligand requires GAFF + AM1-BCC
  parameterization (via `openmmforcefields`) or CGenFF. That is the
  natural next step.
- **Free-energy methods.** FEP / TI / metadynamics are out of scope.
  This tutorial is plain equilibrium MD.
- **GROMACS.** The same simulation in GROMACS is straightforward and
  may be added as a parallel tutorial.

---

## Citing this tutorial

If you use this scaffold in published or shared work, please cite the
underlying force-field paper (Maier et al. 2015, PMID 26574453) and
OpenMM (Eastman et al. 2017, PMID 28746537). The tutorial code itself
is MIT-licensed with the rest of ScienceSwarm.
