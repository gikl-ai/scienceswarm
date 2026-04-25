"""Stage 4 — production NPT MD from the equilibrated state.

Usage:
    python 04_produce.py --seed 11 --ns 1.0
    python 04_produce.py --seed 22 --ns 1.0
    python 04_produce.py --seed 33 --ns 1.0

Each call writes `prod_seed{SEED}.dcd` and `prod_seed{SEED}.log`. Frames
are saved every 1 ps (every 500 steps at 2 fs).

The Monte-Carlo barostat is added here because `system.xml` was
serialized in stage 2 before equilibration introduced it. Without this
step the production run would be NVT, not NPT.

If you have a CUDA GPU, set OPENMM_PLATFORM=CUDA before running:
    OPENMM_PLATFORM=CUDA python 04_produce.py --seed 11 --ns 5.0
"""
import argparse
import os
import time
from pathlib import Path

from openmm import (
    LangevinMiddleIntegrator,
    MonteCarloBarostat,
    Platform,
    XmlSerializer,
)
from openmm.app import DCDReporter, PDBFile, Simulation, StateDataReporter
from openmm.unit import bar, femtosecond, kelvin, picosecond

HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, required=True, help="integer seed")
    parser.add_argument("--ns", type=float, default=1.0, help="production length in ns")
    args = parser.parse_args()

    n_steps = int(args.ns * 500_000)  # 2 fs / step
    dcd_path = HERE / f"prod_seed{args.seed}.dcd"
    log_path = HERE / f"prod_seed{args.seed}.log"

    with open(HERE / "system.xml") as fh:
        system = XmlSerializer.deserialize(fh.read())
    pdb = PDBFile(str(HERE / "solvated.pdb"))
    with open(HERE / "equilibrated.xml") as fh:
        state = XmlSerializer.deserialize(fh.read())

    # Add the Monte-Carlo barostat. system.xml was serialized in stage 2
    # before stage 3 added it in-memory, so without this line the
    # production ensemble would be NVT instead of NPT.
    system.addForce(MonteCarloBarostat(1 * bar, 300 * kelvin, 25))

    integrator = LangevinMiddleIntegrator(300 * kelvin, 1.0 / picosecond, 2 * femtosecond)
    integrator.setRandomNumberSeed(args.seed)

    platform_name = os.environ.get("OPENMM_PLATFORM", "CPU")
    platform = Platform.getPlatformByName(platform_name)
    sim = Simulation(pdb.topology, system, integrator, platform)
    sim.context.setState(state)
    # Equilibrated velocities are preserved from setState. Per-seed
    # divergence comes from the integrator's random-number stream
    # (LangevinMiddleIntegrator with setRandomNumberSeed). Re-randomizing
    # velocities here would discard the equilibrated distribution and
    # introduce a brief re-equilibration transient at the start of every
    # production trajectory.
    #
    # The integrator's step counter inherits from the saved state, so
    # the reporter's progress percentage would otherwise be wrong.
    # Adjust totalSteps so the percentage reflects production progress.
    initial_step = sim.currentStep
    total_steps_for_reporter = initial_step + n_steps

    sim.reporters.append(DCDReporter(str(dcd_path), 500))
    sim.reporters.append(StateDataReporter(
        str(log_path), 1000,
        step=True, time=True, potentialEnergy=True, temperature=True,
        density=True, speed=True, progress=True,
        totalSteps=total_steps_for_reporter,
    ))

    print(f"production seed={args.seed} target {args.ns} ns ({n_steps} steps) on {platform_name} ...")
    t0 = time.time()
    sim.step(n_steps)
    print(f"  ok ({(time.time() - t0)/60:.1f} min)")
    print(f"  trajectory: {dcd_path.name}")


if __name__ == "__main__":
    main()
