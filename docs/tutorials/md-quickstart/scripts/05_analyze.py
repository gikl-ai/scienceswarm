"""Stage 5 — analyze all production trajectories.

Reads `prod_seed*.dcd`, computes Cα-RMSD, Cα-RMSF, and radius of gyration,
writes plots and a `metrics.json` summary.

Run:
    python 05_analyze.py
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import mdtraj as md
import numpy as np

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "analysis"

# Published reference window: lysozyme 1AKI in TIP3P with AMBER ff14SB at
# 300 K typically plateaus around 1.0–1.5 Å Cα-RMSD on 1 ns (Maier et al.
# 2015 ff14SB paper, PMC4821407; biobb_wf_amber tutorial benchmarks).
# A run whose plateau falls outside 0.6–2.0 Å most often has a
# preparation defect (missing residues, wrong protonation, broken ion
# neutralization), not a science result.
RMSD_REFERENCE_LO_A = 0.6
RMSD_REFERENCE_HI_A = 2.0
# Maximum tolerated standard deviation of the plateau Cα-RMSD across
# seeds before we call the run "unconverged." Lysozyme on 1 ns × 3 seeds
# typically gives < 0.3 Å seed spread.
SEED_PLATEAU_STD_MAX_A = 0.4


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    seeds = sorted(int(p.stem.split("seed")[-1]) for p in HERE.glob("prod_seed*.dcd"))
    if not seeds:
        raise SystemExit("no prod_seed*.dcd found; run 04_produce.py first")

    rmsd_traces, rmsf_traces, rg_traces, time_traces = [], [], [], []
    res_ids_ref = None
    for seed in seeds:
        traj = md.load(str(HERE / f"prod_seed{seed}.dcd"), top=str(HERE / "solvated.pdb"))
        protein_idx = traj.topology.select("protein")
        traj_p = traj.atom_slice(protein_idx)
        ca = traj_p.topology.select("name CA")
        # Superpose every frame onto frame 0 so subsequent positional
        # comparisons are rotation-invariant.
        traj_p.superpose(traj_p, frame=0, atom_indices=ca)

        rmsd_traces.append(md.rmsd(traj_p, traj_p, frame=0, atom_indices=ca) * 10)

        # RMSF as fluctuation about the **mean** structure (not frame 0).
        # mdtraj's md.rmsf with a single-frame reference computes deviation
        # from that one snapshot, which is conceptually different. Compute
        # the mean structure ourselves and use it as reference.
        mean_xyz = traj_p.xyz.mean(axis=0)
        sq_dev = ((traj_p.xyz[:, ca, :] - mean_xyz[ca, :]) ** 2).sum(axis=2)
        rmsf_per_ca = np.sqrt(sq_dev.mean(axis=0)) * 10  # nm -> Å
        rmsf_traces.append(rmsf_per_ca)

        rg_traces.append(md.compute_rg(traj_p) * 10)
        time_traces.append(traj_p.time)  # in ps
        if res_ids_ref is None:
            res_ids_ref = [traj_p.topology.atom(i).residue.resSeq for i in ca]

    # Use the trajectory's own time array so a different DCDReporter
    # stride in stage 4 does not silently mislabel the x-axis.
    times_ps = time_traces[0]

    # RMSD vs time, all seeds.
    fig, ax = plt.subplots(figsize=(8, 3.5))
    for seed, trace in zip(seeds, rmsd_traces):
        ax.plot(times_ps, trace, alpha=0.85, label=f"seed {seed}")
    ax.axhspan(
        RMSD_REFERENCE_LO_A, RMSD_REFERENCE_HI_A,
        alpha=0.07, color="tab:green", label="published plateau band",
    )
    ax.set_xlabel("time (ps)")
    ax.set_ylabel("Cα RMSD (Å)")
    ax.set_title("Cα RMSD vs time — lysozyme 1AKI, AMBER ff14SB / TIP3P")
    ax.legend()
    fig.tight_layout()
    fig.savefig(OUT_DIR / "rmsd_ca.png", dpi=140)
    plt.close(fig)

    # RMSF mean ± std across seeds.
    rmsf_arr = np.stack(rmsf_traces)
    rmsf_mean = rmsf_arr.mean(axis=0)
    rmsf_std = rmsf_arr.std(axis=0)
    fig, ax = plt.subplots(figsize=(8, 3.5))
    ax.plot(res_ids_ref, rmsf_mean, color="tab:blue", label="mean over seeds")
    ax.fill_between(
        res_ids_ref, rmsf_mean - rmsf_std, rmsf_mean + rmsf_std,
        color="tab:blue", alpha=0.2, label="±1 std",
    )
    ax.set_xlabel("residue number")
    ax.set_ylabel("Cα RMSF (Å)")
    ax.set_title("Cα RMSF — lysozyme 1AKI, mean ± std across seeds")
    ax.legend()
    fig.tight_layout()
    fig.savefig(OUT_DIR / "rmsf_ca.png", dpi=140)
    plt.close(fig)

    # Rg vs time, all seeds.
    fig, ax = plt.subplots(figsize=(8, 3.5))
    for seed, trace in zip(seeds, rg_traces):
        ax.plot(times_ps, trace, alpha=0.85, label=f"seed {seed}")
    ax.set_xlabel("time (ps)")
    ax.set_ylabel("Rg (Å)")
    ax.set_title("Radius of gyration — lysozyme 1AKI")
    ax.legend()
    fig.tight_layout()
    fig.savefig(OUT_DIR / "rg.png", dpi=140)
    plt.close(fig)

    by_seed = {}
    for seed, t_rmsd, t_rg in zip(seeds, rmsd_traces, rg_traces):
        half = len(t_rmsd) // 2
        by_seed[str(seed)] = {
            "rmsd_ca_mean_A": float(t_rmsd.mean()),
            "rmsd_ca_max_A": float(t_rmsd.max()),
            "rmsd_ca_last_half_mean_A": float(t_rmsd[half:].mean()),
            "rmsd_ca_last_half_std_A": float(t_rmsd[half:].std()),
            "rg_mean_A": float(t_rg.mean()),
            "rg_std_A": float(t_rg.std()),
        }
    plateau_means = [by_seed[str(s)]["rmsd_ca_last_half_mean_A"] for s in seeds]
    metrics = {
        "system": "lysozyme 1AKI",
        "force_field": ["amber14-all.xml", "amber14/tip3p.xml"],
        "seeds": seeds,
        "n_frames_per_seed": int(len(rmsd_traces[0])),
        "time_per_frame_ps": 1.0,
        "by_seed": by_seed,
        "across_seeds": {
            "rmsd_ca_plateau_mean_A": float(np.mean(plateau_means)),
            "rmsd_ca_plateau_std_across_seeds_A": float(np.std(plateau_means)),
            "rmsf_ca_global_mean_A": float(rmsf_mean.mean()),
            "rmsf_ca_global_max_A": float(rmsf_mean.max()),
        },
        "validation": {
            "rmsd_reference_band_A": [RMSD_REFERENCE_LO_A, RMSD_REFERENCE_HI_A],
            "seed_plateau_std_max_A": SEED_PLATEAU_STD_MAX_A,
            "all_seeds_in_band": all(
                RMSD_REFERENCE_LO_A <= m <= RMSD_REFERENCE_HI_A
                for m in plateau_means
            ),
            "seed_spread_within_threshold": (
                float(np.std(plateau_means)) < SEED_PLATEAU_STD_MAX_A
            ),
        },
    }
    with open(OUT_DIR / "metrics.json", "w") as fh:
        json.dump(metrics, fh, indent=2)
    print(json.dumps(metrics["across_seeds"], indent=2))
    print(json.dumps(metrics["validation"], indent=2))

    # Validation gates — both must pass.
    assert metrics["validation"]["all_seeds_in_band"], (
        f"plateau means {plateau_means} are outside the published "
        f"{RMSD_REFERENCE_LO_A}-{RMSD_REFERENCE_HI_A} Å band; check preparation"
    )
    seed_spread = float(np.std(plateau_means))
    assert metrics["validation"]["seed_spread_within_threshold"], (
        f"plateau std across seeds is {seed_spread:.2f} Å, above the "
        f"{SEED_PLATEAU_STD_MAX_A} Å convergence threshold; extend "
        "production or add seeds before interpreting"
    )
    print("OK: all seeds plateau within the published reference band")
    print(f"OK: seed plateau std {seed_spread:.2f} Å < {SEED_PLATEAU_STD_MAX_A} Å threshold")


if __name__ == "__main__":
    main()
